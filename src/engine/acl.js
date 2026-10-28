// IPv4 access lists: numbered standard (1-99) and extended (100-199) lists, and named lists
// ("ip access-list standard|extended NAME"). Every entry has a sequence number, so lines can be
// inserted between others or removed one at a time.

import { ipToInt } from './util.js';

function matchAddr(spec, ip) {
  if (spec.any) return true;
  const a = ipToInt(spec.ip);
  const w = ipToInt(spec.wildcard || '0.0.0.0');
  return ((ipToInt(ip) | w) >>> 0) === ((a | w) >>> 0);
}

export function addrToString(spec) {
  if (spec.any) return 'any';
  if (!spec.wildcard || spec.wildcard === '0.0.0.0') return `host ${spec.ip}`;
  return `${spec.ip} ${spec.wildcard}`;
}

/** Turns "10", 10 or "BLOCK-WEB" into a list key: numbers for numbered lists, strings for names. */
export function aclKey(x) {
  if (typeof x === 'number') return x;
  const s = String(x);
  return /^\d+$/.test(s) ? Number(s) : s;
}

/** The type a numbered list gets from its number, or null when the number is out of range. */
export function numberedType(n) {
  if (n >= 1 && n <= 99) return 'standard';
  if (n >= 100 && n <= 199) return 'extended';
  return null;
}

export const SEQ_STEP = 10;
export const SEQ_MAX = 2147483647;

export class Acl {
  constructor(router) {
    this.r = router;
    this.lists = new Map(); // key (number or name) -> [{seq, action, proto, src, dst, port, hits}] in sequence order
    this.types = new Map(); // name -> 'standard'|'extended' (numbered lists get their type from the number)
  }

  typeOf(key) {
    if (typeof key === 'number') return numberedType(key);
    return this.types.get(key) || null;
  }

  isNamed(key) { return typeof key === 'string'; }

  /** Creates an empty list if needed. Returns an error message, or null. */
  create(key, type) {
    const have = this.typeOf(key);
    if (typeof key === 'number') {
      if (have !== type) return `% ${key} is not ${type === 'extended' ? 'an' : 'a'} ${type} access list number (standard 1-99, extended 100-199)`;
    } else if (have && have !== type) {
      return `% ${key} is already a ${have} access list; remove it first with "no ip access-list ${have} ${key}"`;
    } else {
      this.types.set(key, type);
    }
    if (!this.lists.has(key)) this.lists.set(key, []);
    return null;
  }

  /**
   * Adds an entry. Without a sequence number it goes after the last line (highest number + 10).
   * Returns an error message, or null.
   */
  add(key, rule, seq = null) {
    if (!this.lists.has(key)) this.lists.set(key, []);
    const rules = this.lists.get(key);
    if (seq === null) {
      const last = rules.length ? rules[rules.length - 1].seq : 0;
      seq = last + SEQ_STEP;
      if (seq > SEQ_MAX) return '% Sequence number would be too large; renumber the list or give a number';
    } else {
      if (seq < 1 || seq > SEQ_MAX) return `% Sequence number must be between 1 and ${SEQ_MAX}`;
      if (rules.some((x) => x.seq === seq)) return `% Duplicate sequence number ${seq}`;
    }
    rules.push({ ...rule, seq, hits: 0 });
    rules.sort((a, b) => a.seq - b.seq);
    return null;
  }

  /** Removes the entry with this sequence number. Returns true when there was one. */
  removeSeq(key, seq) {
    const rules = this.lists.get(key);
    if (!rules) return false;
    const i = rules.findIndex((x) => x.seq === seq);
    if (i < 0) return false;
    rules.splice(i, 1);
    return true;
  }

  /** Removes the entry whose text matches (e.g. "deny host 10.0.0.1"). Returns true when there was one. */
  removeMatching(key, rule) {
    const rules = this.lists.get(key);
    if (!rules) return false;
    const type = this.typeOf(key);
    const text = ruleText(type, rule);
    const i = rules.findIndex((x) => ruleText(type, x) === text);
    if (i < 0) return false;
    rules.splice(i, 1);
    return true;
  }

  /** Renumbers the list: first line `start`, then every `step`. */
  resequence(key, start = SEQ_STEP, step = SEQ_STEP) {
    const rules = this.lists.get(key);
    if (!rules) return false;
    rules.forEach((x, i) => { x.seq = start + i * step; });
    return true;
  }

  remove(key) { this.lists.delete(key); this.types.delete(key); }

  /** All list keys: numbered lists first in number order, then names in alphabetical order. */
  keys() {
    return [...this.lists.keys()].sort((a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      if (typeof a === 'number') return -1;
      if (typeof b === 'number') return 1;
      return a.localeCompare(b);
    });
  }

  evaluate(key, pkt) {
    const rules = this.lists.get(key);
    if (!rules) return { action: 'permit', rule: null }; // a missing ACL permits everything
    for (const rule of rules) {
      if (rule.action === 'remark') continue;
      if (!matchAddr(rule.src, pkt.src)) continue;
      if (rule.dst && !matchAddr(rule.dst, pkt.dst)) continue;
      if (rule.proto && rule.proto !== 'ip') {
        if (rule.proto.toUpperCase() !== pkt.proto) continue;
        if (rule.port && pkt.payload?.dstPort !== rule.port) continue;
      }
      rule.hits++;
      return { action: rule.action, rule };
    }
    return { action: 'deny', rule: null, implicit: true };
  }

  /** `errorPkt` is the packet the ICMP error is about (before NAT changed its source). */
  check(iface, dir, pkt, errorPkt = pkt) {
    const key = dir === 'in' ? iface.aclIn : iface.aclOut;
    if (key === null || key === undefined || key === '') return true;
    const label = `ACL ${key} ${dir} on ${iface.name}`;
    const rules = this.lists.get(key);
    if (!rules) {
      this.r.explain(`${label}: the list does not exist, so nothing is filtered`);
      return true;
    }
    if (!rules.some((x) => x.action !== 'remark')) {
      this.r.explain(`${label}: the list has no entries, so nothing is filtered`);
      return true;
    }
    const type = this.typeOf(key);
    const res = this.evaluate(key, pkt);
    const line = res.rule ? ` by line ${res.rule.seq} (${ruleText(type, res.rule)})` : '';
    if (res.action === 'permit') {
      this.r.explain(`${label}: permitted${line}`);
      return true;
    }
    this.r.explain(`${label}: DENIED${res.implicit ? ' (implicit deny at end of list)' : line}`);
    this.r.sendIcmpError(errorPkt, 3, 13);
    return false;
  }

  /** The entries of a list as text, without sequence numbers. */
  lines(key) {
    const type = this.typeOf(key);
    return (this.lists.get(key) || []).map((r) => ruleText(type, r));
  }

  save() {
    return this.keys().map((k) => {
      const entry = [k, this.lists.get(k).map(({ hits, ...r }) => r)];
      if (typeof k === 'string') entry.push(this.types.get(k));
      return entry;
    });
  }

  /** Loads saved lists. Files from before sequence numbers and names get 10, 20, 30… */
  load(c = []) {
    this.lists = new Map();
    this.types = new Map();
    for (const item of c) {
      if (!Array.isArray(item)) continue;
      const [n, rules = [], type] = item;
      const key = aclKey(n);
      if (typeof key === 'string') {
        if (type !== 'standard' && type !== 'extended') continue;
        this.types.set(key, type);
      } else if (!numberedType(key)) continue;
      let last = 0;
      const list = (Array.isArray(rules) ? rules : []).map((r) => {
        const seq = Number.isInteger(r.seq) && r.seq > last ? r.seq : last + SEQ_STEP;
        last = seq;
        return { ...r, seq, hits: 0 };
      });
      this.lists.set(key, list);
    }
  }
}

/** One entry as configuration text, e.g. "permit tcp any host 10.0.0.5 eq 80". */
export function ruleText(type, r) {
  if (r.action === 'remark') return `remark ${r.text || ''}`.trimEnd();
  if (type === 'standard') return `${r.action} ${r.src.any ? 'any' : r.src.wildcard && r.src.wildcard !== '0.0.0.0' ? `${r.src.ip} ${r.src.wildcard}` : r.src.ip}`;
  return `${r.action} ${r.proto} ${addrToString(r.src)} ${addrToString(r.dst)}${r.port ? ` eq ${r.port}` : ''}`;
}
