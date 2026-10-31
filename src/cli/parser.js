// A tiny command grammar engine with IOS-like behaviour: unique-prefix keywords,
// "% Ambiguous command", "% Incomplete command", '^' error markers, '?' help and Tab completion.

import { isValidIp } from '../engine/util.js';

const IF_TYPES = [
  ['gigabitethernet', 'GigabitEthernet'],
  ['fastethernet', 'FastEthernet'],
  ['ethernet', 'Ethernet'],
  ['vlan', 'Vlan'],
];

/** Normalises user interface names: "g0/0", "gig 0/1.10", "vlan 1", "f0/5" */
export function parseIfName(text) {
  const m = String(text).trim().match(/^([a-z-]+)\s*(\d+(?:\/\d+)*(?:\.\d+)?)$/i);
  if (!m) return null;
  const t = m[1].toLowerCase();
  const found = IF_TYPES.filter(([full]) => full.startsWith(t));
  if (found.length !== 1) return null;
  return `${found[0][1]}${m[2]}`;
}

/** Splits "FastEthernet0/1 - 5 , f0/7" into names. */
export function parseIfRange(text) {
  const out = [];
  for (const part of String(text).split(',')) {
    const m = part.trim().match(/^([a-z-]+)\s*((?:\d+\/)*)(\d+)\s*(?:-\s*(\d+))?$/i);
    if (!m) return null;
    const base = parseIfName(`${m[1]}${m[2]}${m[3]}`);
    if (!base) return null;
    const prefix = base.slice(0, base.length - m[3].length);
    const a = Number(m[3]);
    const b = m[4] ? Number(m[4]) : a;
    if (b < a) return null;
    for (let i = a; i <= b; i++) out.push(`${prefix}${i}`);
  }
  return out;
}

const PLACEHOLDER_HELP = {
  '<ip>': 'A.B.C.D',
  '<mask>': 'A.B.C.D',
  '<n>': '<0-4294967295>',
  '<word>': 'WORD',
  '<line>': 'LINE',
  '<if>': 'Interface name',
};

export function tokenize(line) {
  return line.trim().split(/\s+/).filter(Boolean);
}

function tryIf(tokens, i) {
  if (i >= tokens.length) return null;
  const one = parseIfName(tokens[i]);
  if (one) return { name: one, used: 1 };
  if (i + 1 < tokens.length) {
    const two = parseIfName(`${tokens[i]}${tokens[i + 1]}`);
    if (two) return { name: two, used: 2 };
  }
  return null;
}

/**
 * Attempts to match tokens against one syntax.
 * Returns {status: 'ok'|'incomplete'|'fail', args, failAt, exact, lits}
 */
export function matchSyntax(syntax, tokens) {
  const parts = syntax.split(' ');
  const args = [];
  let ti = 0;
  let exact = 0;
  const lits = [];
  for (let pi = 0; pi < parts.length; pi++) {
    const s = parts[pi];
    if (ti >= tokens.length) return { status: 'incomplete', args, failAt: ti, exact, lits, next: s };
    const tok = tokens[ti];
    const low = tok.toLowerCase();
    if (s === '<line>') { args.push(tokens.slice(ti).join(' ')); ti = tokens.length; continue; }
    if (s === '<if>') {
      const r = tryIf(tokens, ti);
      if (!r) return { status: 'fail', failAt: ti, args, exact, lits };
      args.push(r.name);
      ti += r.used;
      continue;
    }
    if (s === '<ip>' || s === '<mask>') {
      if (!isValidIp(tok)) return { status: 'fail', failAt: ti, args, exact, lits };
      args.push(tok); ti++; continue;
    }
    if (s === '<n>') {
      if (!/^\d+$/.test(tok)) return { status: 'fail', failAt: ti, args, exact, lits };
      args.push(Number(tok)); ti++; continue;
    }
    if (s === '<word>') { args.push(tok); ti++; continue; }
    // literal (may contain alternatives a|b)
    const alts = s.split('|');
    const hit = alts.find((a) => a.toLowerCase() === low) || (alts.filter((a) => a.toLowerCase().startsWith(low)).length === 1 ? alts.find((a) => a.toLowerCase().startsWith(low)) : null);
    if (!hit) return { status: 'fail', failAt: ti, args, exact, lits };
    if (hit.toLowerCase() === low) exact++;
    if (alts.length > 1) args.push(hit.toLowerCase());
    lits.push({ ti, lit: hit.toLowerCase() });
    ti++;
  }
  if (ti < tokens.length) return { status: 'fail', failAt: ti, args, exact, lits };
  return { status: 'ok', args, exact, lits };
}

export class CommandSet {
  constructor() { this.defs = []; this.keywordHelp = {}; }

  /** `words` optionally describes keywords for this command only, for `?` help. */
  add(modes, syntaxes, run, help = '', words = null) {
    for (const syntax of [].concat(syntaxes)) this.defs.push({ modes: [].concat(modes), syntax, run, help, words });
    return this;
  }

  describe(words) { Object.assign(this.keywordHelp, words); return this; }

  forMode(mode) { return this.defs.filter((d) => d.modes.includes(mode) || d.modes.includes('*')); }

  /** Resolves a command line into {def, args} or {error} */
  resolve(mode, line) {
    const tokens = tokenize(line);
    if (!tokens.length) return { empty: true };
    const results = this.forMode(mode).map((def) => ({ def, m: matchSyntax(def.syntax, tokens) }));
    const ok = results.filter((r) => r.m.status === 'ok');
    if (ok.length) {
      ok.sort((a, b) => b.m.exact - a.m.exact);
      // ambiguity: different keyword paths with the same exactness
      const top = ok[0];
      const path = (r) => r.m.lits.map((l) => l.lit).join(' ');
      // a rival whose keywords are all part of the top match only used a placeholder (<word>) where the
      // top match has a keyword, so the keyword wins: "mac-address stick" means "mac-address sticky"
      const subset = (r) => r.m.lits.every((l) => top.m.lits.some((t) => t.ti === l.ti && t.lit === l.lit));
      const rivals = ok.filter((r) => r.m.exact === top.m.exact && path(r) !== path(top) && !subset(r));
      if (rivals.length) {
        const diff = top.m.lits.find((l, i) => rivals.some((r) => r.m.lits[i]?.lit !== l.lit));
        if (diff && tokens[diff.ti].toLowerCase() !== diff.lit) return { error: 'ambiguous', token: tokens[diff.ti], tokens };
      }
      return { def: top.def, args: top.m.args, tokens };
    }
    const inc = results.filter((r) => r.m.status === 'incomplete');
    if (inc.length) {
      // if the given tokens were an ambiguous prefix, say so
      return { error: 'incomplete', tokens };
    }
    const far = Math.max(...results.map((r) => r.m.failAt ?? 0), 0);
    // check ambiguity at the failing position: several keywords share this prefix
    const tok = tokens[far]?.toLowerCase();
    if (tok) {
      const lits = new Set();
      for (const r of results) {
        if ((r.m.failAt ?? -1) !== far) continue;
        const prefixOk = matchSyntax(r.def.syntax, tokens.slice(0, far));
        if (prefixOk.status !== 'incomplete') continue;
        for (const a of String(prefixOk.next).split('|')) if (a.toLowerCase().startsWith(tok)) lits.add(a.toLowerCase());
      }
      if (lits.size > 1) return { error: 'ambiguous', token: tokens[far], tokens };
    }
    return { error: 'invalid', failAt: far, tokens };
  }

  /** Words that may follow the given (complete) tokens. */
  nextWords(mode, tokens, partial = '') {
    const out = new Map();
    for (const def of this.forMode(mode)) {
      const m = matchSyntax(def.syntax, tokens);
      if (m.status === 'incomplete') {
        for (const w of String(m.next).split('|')) {
          if (!w.toLowerCase().startsWith(partial.toLowerCase()) && !w.startsWith('<')) continue;
          if (w.startsWith('<') && partial) continue;
          const help = w.startsWith('<') ? PLACEHOLDER_HELP[w] || w : def.words?.[w] || this.keywordHelp[w] || (def.syntax.split(' ').length === tokens.length + 1 ? def.help : '');
          if (!out.has(w)) out.set(w, help || '');
        }
      } else if (m.status === 'ok' && !partial) {
        out.set('<cr>', '');
      }
    }
    return [...out.entries()].sort((a, b) => (a[0] === '<cr>') - (b[0] === '<cr>') || a[0].localeCompare(b[0]));
  }

  help(mode, line) {
    const endsWithSpace = /\s$/.test(line) || line === '';
    const tokens = tokenize(line);
    const partial = endsWithSpace ? '' : tokens.pop() || '';
    const words = this.nextWords(mode, tokens, partial);
    if (!words.length) return '% Unrecognized command';
    if (!endsWithSpace) return words.filter(([w]) => !w.startsWith('<')).map(([w]) => w).join('  ');
    const width = Math.max(...words.map(([w]) => w.length)) + 2;
    return words.map(([w, h]) => `  ${w.padEnd(width)}${h}`).join('\n');
  }

  complete(mode, line) {
    if (/\s$/.test(line) || !line.trim()) return null;
    const tokens = tokenize(line);
    const partial = tokens.pop();
    const words = this.nextWords(mode, tokens, partial).map(([w]) => w).filter((w) => !w.startsWith('<'));
    if (words.length !== 1) return null;
    return line.slice(0, line.length - partial.length) + words[0] + ' ';
  }
}
