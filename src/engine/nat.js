// Network address translation with port overload (PAT), following RFC 3022 (traditional NAT,
// "NAPT"). Inside hosts that match an access list share the address of one outside interface;
// each flow is told apart by its TCP/UDP source port or its ICMP query identifier.
//
// Static NAT (RFC 3022 "basic NAT", one to one) maps one inside local address to one inside global
// address for every protocol, in both directions, so outside hosts can start conversations with an
// inside server. A static mapping wins over the overload rules for the same inside host.
//
// Interfaces are marked `iface.nat = 'inside' | 'outside'`. The router calls:
//   translateOut(inIface, outIface, pkt)  after routing, for inside → outside traffic
//   inboundMatch(iface, pkt) / translateIn(entry, pkt) before routing, for outside → inside traffic

import { inSubnet, isValidIp } from './util.js';

// Idle timeouts in milliseconds (the usual defaults on routers)
export const NAT_TIMEOUTS = { icmp: 60 * 1000, udp: 5 * 60 * 1000, tcp: 24 * 60 * 60 * 1000 };

const PORT_FLOOR = { icmp: 1, udp: 1024, tcp: 1024 };

/** Protocol and layer 4 identifiers of a packet, or null when NAT cannot overload it. */
function flowOf(pkt) {
  if (pkt.proto === 'TCP' || pkt.proto === 'UDP') {
    const p = pkt.payload || {};
    if (typeof p.srcPort !== 'number' && typeof p.srcPort !== 'string') return null;
    return { proto: pkt.proto.toLowerCase(), sport: p.srcPort, dport: p.dstPort };
  }
  if (pkt.proto === 'ICMP' && (pkt.payload?.type === 8 || pkt.payload?.type === 0)) {
    // echo request and reply carry a query identifier that PAT uses like a port
    return { proto: 'icmp', sport: pkt.payload.id, dport: pkt.payload.id };
  }
  return null;
}

const ep = (ip, port) => `${ip}:${port}`;

export class Nat {
  constructor(router) {
    this.r = router;
    this.rules = [];         // [{ acl, iface, overload }]: "ip nat inside source list <acl> interface <iface> overload"
    this.statics = [];       // [{ local, global }]: "ip nat inside source static <local> <global>"
    this.table = [];         // [{ proto, insideLocal, localPort, insideGlobal, globalPort, outside, outsidePort, created, last }]
    this.hits = 0;
    this.misses = 0;
  }

  get now() { return this.r.net ? this.r.net.time : 0; }

  /** True when there is anything to translate with. */
  active() { return this.rules.length > 0 || this.statics.length > 0 || this.table.length > 0; }

  /**
   * Adds a static mapping. Returns null on success, or the existing mapping that already uses
   * the inside local or the inside global address.
   */
  addStatic(local, global) {
    const same = (s) => s.local === local && s.global === global;
    const clash = this.statics.find((s) => (s.local === local || s.global === global) && !same(s));
    if (clash) return clash;
    if (!this.statics.some(same)) this.statics.push({ local, global });
    return null;
  }

  /** Removes a static mapping; returns false when there was no such mapping. */
  removeStatic(local, global) {
    const n = this.statics.length;
    this.statics = this.statics.filter((s) => !(s.local === local && s.global === global));
    return this.statics.length !== n;
  }

  staticFor(field, ip) { return this.statics.find((s) => s[field] === ip) || null; }

  addRule(rule) {
    this.removeRule(rule);
    this.rules.push({ acl: rule.acl, iface: rule.iface, overload: true });
  }

  removeRule({ acl, iface }) {
    this.rules = this.rules.filter((x) => !(x.acl === acl && x.iface === iface));
  }

  /** Drops translations that have been idle longer than their protocol's timeout. */
  expire() {
    const now = this.now;
    this.table = this.table.filter((e) => now - e.last <= (NAT_TIMEOUTS[e.proto] ?? NAT_TIMEOUTS.udp));
  }

  clear() { this.table = []; }

  translations() { this.expire(); return this.table.slice(); }

  /** Picks the inside global port: the inside host's own port if nobody else is using it, else the next free one. */
  allocatePort(proto, globalIp, localIp, localPort) {
    const mine = this.table.find((e) => e.proto === proto && e.insideGlobal === globalIp && e.insideLocal === localIp && e.localPort === localPort);
    if (mine) return mine.globalPort;
    const used = new Set(this.table.filter((e) => e.proto === proto && e.insideGlobal === globalIp).map((e) => e.globalPort));
    if (!used.has(localPort)) return localPort;
    for (let p = PORT_FLOOR[proto]; p <= 65535; p++) if (!used.has(p)) return p;
    return null;
  }

  /**
   * Inside → outside, after the routing decision. Rewrites the source address and port.
   * Returns false when the packet must be dropped.
   */
  translateOut(inIface, outIface, pkt) {
    if (inIface.nat !== 'inside' || outIface.nat !== 'outside') return true;
    this.created = null;
    const st = this.staticFor('local', pkt.src);
    if (st) {
      this.hits++;
      this.r.explain(`NAT: static mapping ${st.local} → ${st.global}; source address rewritten, ${pkt.proto === 'ICMP' ? 'ICMP identifier' : 'ports'} unchanged`);
      pkt.src = st.global;
      // an ICMP error about a packet that came in through this mapping quotes the public destination
      if (pkt.proto === 'ICMP' && (pkt.payload?.type === 3 || pkt.payload?.type === 11) && pkt.payload.orig?.dst === st.local) {
        pkt.payload.orig = { ...pkt.payload.orig, dst: st.global };
      }
      return true;
    }
    const candidates = this.rules.filter((x) => x.iface.toLowerCase() === outIface.name.toLowerCase());
    if (!candidates.length) {
      this.r.explain(`NAT: no "ip nat inside source" rule uses ${outIface.name}, so the source address ${pkt.src} is not translated`);
      return true;
    }
    // the first rule whose access list permits the source wins
    const rule = candidates.find((x) => this.r.acl.lists.has(x.acl) && this.r.acl.evaluate(x.acl, pkt).action === 'permit');
    if (!rule) {
      const lists = candidates.map((x) => x.acl).join(', ');
      const missing = candidates.filter((x) => !this.r.acl.lists.has(x.acl)).map((x) => x.acl);
      this.r.explain(`NAT: source ${pkt.src} is not permitted by access list ${lists}${missing.length ? ` (access list ${missing.join(', ')} does not exist)` : ''}, so it is forwarded without translation`);
      return true;
    }
    if (!outIface.ip) {
      this.r.explain(`NAT: ${outIface.name} has no IP address to share; packet dropped`);
      return false;
    }
    const flow = pkt.proto === 'ICMP' && pkt.payload?.type !== 8 ? null : flowOf(pkt);
    if (!flow) {
      this.r.explain(`NAT: port address translation needs a TCP/UDP port or an ICMP echo identifier; this ${pkt.proto} packet is dropped`);
      return false;
    }
    this.expire();
    // for ICMP the outside "port" is the identifier the outside host sees, which is the global one
    let e = this.table.find((x) => x.proto === flow.proto && x.insideLocal === pkt.src && x.localPort === flow.sport
      && x.insideGlobal === outIface.ip && x.outside === pkt.dst && (flow.proto === 'icmp' || x.outsidePort === flow.dport));
    if (e) {
      this.hits++;
      this.r.explain(`NAT: existing translation ${ep(e.insideLocal, e.localPort)} → ${ep(e.insideGlobal, e.globalPort)} is reused`);
    } else {
      const globalPort = this.allocatePort(flow.proto, outIface.ip, pkt.src, flow.sport);
      if (globalPort === null) {
        this.r.explain(`NAT: no free ${flow.proto} ports left on ${outIface.ip}; packet dropped`);
        return false;
      }
      e = {
        proto: flow.proto, insideLocal: pkt.src, localPort: flow.sport, insideGlobal: outIface.ip, globalPort,
        outside: pkt.dst, outsidePort: flow.proto === 'icmp' ? globalPort : flow.dport, created: this.now, last: this.now,
      };
      this.table.push(e);
      this.created = e;
      this.misses++;
      const portNote = globalPort === flow.sport
        ? `keeps its ${flow.proto === 'icmp' ? 'ICMP identifier' : 'source port'} ${globalPort}`
        : `${flow.proto === 'icmp' ? 'ICMP identifier' : 'source port'} ${flow.sport} is already taken on ${outIface.ip}, so it becomes ${globalPort}`;
      this.r.explain(`NAT: ${pkt.src} is permitted by access list ${rule.acl}; new translation to ${outIface.name}'s address ${outIface.ip} (overload), and the flow ${portNote}`);
    }
    e.last = this.now;
    pkt.src = e.insideGlobal;
    if (flow.proto === 'icmp') pkt.payload.id = e.globalPort;
    else pkt.payload.srcPort = e.globalPort;
    return true;
  }

  /** Outside → inside: finds the translation an arriving packet belongs to, or null. */
  inboundMatch(iface, pkt) {
    if (iface.nat !== 'outside') return null;
    const dyn = this.table.length ? this.dynamicMatch(pkt) : null;
    if (dyn) return dyn;
    const st = this.staticFor('global', pkt.dst);
    if (!st) return null;
    if (this.r.ownsIp(st.global)) {
      this.r.explain(`NAT: ${st.global} is also an address of this router, so the static mapping to ${st.local} is not used`);
      return null;
    }
    const error = pkt.proto === 'ICMP' && (pkt.payload?.type === 3 || pkt.payload?.type === 11) && pkt.payload.orig?.src === st.global;
    return { static: st, error };
  }

  /** True when this router should answer ARP for `ip` on `iface` because it is a static global address. */
  ownsGlobal(iface, ip) {
    return iface.nat === 'outside' && !!this.staticFor('global', ip) && !this.r.ownsIp(ip)
      && !!iface.ip && !!iface.mask && inSubnet(ip, iface.ip, iface.mask);
  }

  dynamicMatch(pkt) {
    this.expire();
    // ICMP errors about a translated packet (for example TTL exceeded during a traceroute)
    if (pkt.proto === 'ICMP' && (pkt.payload?.type === 3 || pkt.payload?.type === 11) && pkt.payload.orig) {
      const o = pkt.payload.orig;
      const proto = String(o.proto || '').toLowerCase();
      const port = proto === 'icmp' ? o.icmp?.id : o.ports?.src;
      if (port === undefined || port === null) return null;
      // the quoted packet must be one this translation actually sent
      const e = this.table.find((x) => x.proto === proto && x.insideGlobal === pkt.dst && x.insideGlobal === o.src
        && x.globalPort === port && x.outside === o.dst);
      return e ? { entry: e, error: true } : null;
    }
    if (pkt.proto === 'ICMP' && pkt.payload?.type !== 0) return null; // only echo replies come back through PAT
    const flow = flowOf(pkt);
    if (!flow) return null;
    // a reply comes from the outside host's port and goes to the inside global port
    const e = this.table.find((x) => x.proto === flow.proto && x.insideGlobal === pkt.dst && x.globalPort === flow.dport
      && x.outside === pkt.src && x.outsidePort === flow.sport);
    return e ? { entry: e, error: false } : null;
  }

  /** Rewrites the destination of an arriving packet back to the inside host. */
  translateIn({ entry: e, static: st, error }, pkt) {
    if (st) {
      this.hits++;
      pkt.dst = st.local;
      if (error) {
        pkt.payload.orig = { ...pkt.payload.orig, src: st.local };
        this.r.explain(`NAT: this ICMP error is about a packet from ${st.global}; static mapping rewrites it to the inside host ${st.local}`);
      } else {
        this.r.explain(`NAT: ${st.global} is statically mapped to ${st.local}; destination rewritten to the inside host`);
      }
      return;
    }
    e.last = this.now;
    this.hits++;
    pkt.dst = e.insideLocal;
    if (error) {
      const o = pkt.payload.orig;
      pkt.payload.orig = e.proto === 'icmp'
        ? { ...o, src: e.insideLocal, icmp: { ...o.icmp, id: e.localPort } }
        : { ...o, src: e.insideLocal, ports: { ...o.ports, src: e.localPort } };
      this.r.explain(`NAT: this ICMP error is about translated flow ${ep(e.insideGlobal, e.globalPort)}; destination and the quoted packet are rewritten to the inside host ${e.insideLocal}`);
      return;
    }
    if (e.proto === 'icmp') pkt.payload.id = e.localPort;
    else pkt.payload.dstPort = e.localPort;
    this.r.explain(`NAT: ${ep(e.insideGlobal, e.globalPort)} belongs to the translation for ${ep(e.insideLocal, e.localPort)}; destination rewritten to the inside host`);
  }

  /** Forgets the translation the last packet created, when an outbound ACL drops that packet. */
  discardCreated() {
    if (this.created) this.table = this.table.filter((x) => x !== this.created);
    this.created = null;
  }

  save() {
    const c = { rules: this.rules.map((x) => ({ ...x })) };
    if (this.statics.length) c.statics = this.statics.map((x) => ({ ...x }));
    return c;
  }

  load(c = {}) {
    this.rules = (c.rules || []).filter((x) => x && Number.isInteger(Number(x.acl)) && typeof x.iface === 'string')
      .map((x) => ({ acl: Number(x.acl), iface: x.iface, overload: true }));
    this.statics = [];
    for (const x of c.statics || []) if (x && isValidIp(x.local) && isValidIp(x.global)) this.addStatic(x.local, x.global);
    this.table = [];
  }
}
