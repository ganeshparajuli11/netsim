// Numbered standard (1-99) and extended (100-199) IPv4 access lists.

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

export class Acl {
  constructor(router) {
    this.r = router;
    this.lists = new Map(); // number -> [{action, proto, src, dst, port, hits}]
  }

  add(num, rule) {
    if (!this.lists.has(num)) this.lists.set(num, []);
    this.lists.get(num).push({ ...rule, hits: 0 });
  }

  remove(num) { this.lists.delete(num); }

  evaluate(num, pkt) {
    const rules = this.lists.get(num);
    if (!rules) return { action: 'permit', rule: null }; // a missing ACL permits everything
    for (const rule of rules) {
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

  check(iface, dir, pkt) {
    const num = dir === 'in' ? iface.aclIn : iface.aclOut;
    if (!num) return true;
    const res = this.evaluate(num, pkt);
    if (res.action === 'permit') {
      this.r.explain(`ACL ${num} ${dir} on ${iface.name}: permitted`);
      return true;
    }
    this.r.explain(`ACL ${num} ${dir} on ${iface.name}: DENIED${res.implicit ? ' (implicit deny at end of list)' : ''}`);
    this.r.sendIcmpError(pkt, 3, 13);
    return false;
  }

  lines(num) {
    const rules = this.lists.get(num) || [];
    return rules.map((r) => {
      if (num < 100) return `${r.action} ${r.src.any ? 'any' : r.src.wildcard && r.src.wildcard !== '0.0.0.0' ? `${r.src.ip} ${r.src.wildcard}` : r.src.ip}`;
      return `${r.action} ${r.proto} ${addrToString(r.src)} ${addrToString(r.dst)}${r.port ? ` eq ${r.port}` : ''}`;
    });
  }

  save() { return [...this.lists.entries()].map(([n, rules]) => [n, rules.map(({ hits, ...r }) => r)]); }
  load(c = []) { this.lists = new Map(c.map(([n, rules]) => [Number(n), rules.map((r) => ({ ...r, hits: 0 }))])); }
}
