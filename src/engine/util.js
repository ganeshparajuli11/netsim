// Small helpers for addresses. Everything here is pure and safe to use in Node or the browser.

export const BROADCAST_MAC = 'FFFF.FFFF.FFFF';

export function isValidIp(s) {
  if (typeof s !== 'string') return false;
  const p = s.trim().split('.');
  if (p.length !== 4) return false;
  return p.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
}

export function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => ((acc << 8) | Number(o)) >>> 0, 0) >>> 0;
}

export function intToIp(n) {
  n >>>= 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isValidMask(mask) {
  if (!isValidIp(mask)) return false;
  const n = ipToInt(mask);
  // contiguous ones followed by zeros
  const inv = (~n) >>> 0;
  return ((inv + 1) & inv) === 0;
}

export function maskToPrefix(mask) {
  let n = ipToInt(mask);
  let c = 0;
  while (n & 0x80000000) { c++; n = (n << 1) >>> 0; }
  return c;
}

export function prefixToMask(prefix) {
  if (prefix <= 0) return '0.0.0.0';
  return intToIp((0xffffffff << (32 - prefix)) >>> 0);
}

export function networkOf(ip, mask) {
  return intToIp((ipToInt(ip) & ipToInt(mask)) >>> 0);
}

export function broadcastOf(ip, mask) {
  return intToIp(((ipToInt(ip) & ipToInt(mask)) | (~ipToInt(mask) >>> 0)) >>> 0);
}

export function inSubnet(ip, net, mask) {
  return ((ipToInt(ip) & ipToInt(mask)) >>> 0) === ((ipToInt(net) & ipToInt(mask)) >>> 0);
}

/** Wildcard mask (as used by ACLs / routing statements) to subnet mask. */
export function wildcardToMask(wc) {
  return intToIp((~ipToInt(wc)) >>> 0);
}

let macCounter = 1;
export function randomMac() {
  // Locally administered unicast prefix 02:xx so we never collide with real vendors.
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0').toUpperCase();
  const c = (macCounter++ & 0xffff).toString(16).padStart(4, '0').toUpperCase();
  return `02${r().slice(2)}.${r()}.${c}`;
}

/** Formats a MAC in the requested style. Internal format is XXXX.XXXX.XXXX */
export function formatMac(mac, style = 'dot') {
  const hex = mac.replace(/\./g, '').toLowerCase();
  if (style === 'dash') return hex.match(/../g).join('-');
  if (style === 'colon') return hex.match(/../g).join(':');
  return hex.match(/..../g).join('.');
}

export function clone(o) {
  return o === undefined ? o : JSON.parse(JSON.stringify(o));
}

/** Parses "1,3,10-20" into a sorted array of numbers. Returns null on bad input. */
export function parseRangeList(s, min = 1, max = 4094) {
  const out = new Set();
  for (const part of String(s).split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < min || b > max || a > b) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/** Compresses [1,2,3,5] -> "1-3,5" */
export function compressRange(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const out = [];
  for (let i = 0; i < a.length; i++) {
    let j = i;
    while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++;
    out.push(j > i ? `${a[i]}-${a[j]}` : `${a[i]}`);
    i = j;
  }
  return out.join(',');
}
