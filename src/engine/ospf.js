// OSPFv2, single area, on broadcast (Ethernet) networks. Written from RFC 2328:
// - interfaces, hellos, neighbour states and DR/BDR election (sections 9 and 10)
// - router and network LSAs (12.4), database exchange with link-state requests (10.6-10.9)
// - reliable flooding with updates and acknowledgements (13)
// - shortest-path-first route calculation with Dijkstra's algorithm (16.1)
// Each DBD carries every LSA header at once (no M bit), and LSAs never age out on their own.

import { ipToInt, networkOf, inSubnet } from './util.js';

export const OSPF_MAC = '0100.5E00.0005';
export const OSPF_ALL_ROUTERS = '224.0.0.5';
const RXMT = 5000;

// Neighbour states, lowest first (RFC 2328 10.1)
export const NBR_STATES = ['DOWN', 'INIT', '2WAY', 'EXSTART', 'EXCHANGE', 'LOADING', 'FULL'];
const rank = (s) => NBR_STATES.indexOf(s);

export const OSPF_DEFAULTS = { hello: 10, dead: 40, priority: 1, referenceBw: 100 };
const INITIAL_SEQ = 0x80000001;

/** Interface bandwidth in kbit/s: the "bandwidth" command, else the port's line rate. */
export function bandwidthKbps(i) {
  if (Number.isInteger(i.bandwidth) && i.bandwidth > 0) return i.bandwidth;
  if (i.parent) return bandwidthKbps(i.parent);
  if (/^gig/i.test(i.name)) return 1000000;
  if (/^fast/i.test(i.name)) return 100000;
  return 10000;
}

export const lsaKey = (l) => `${l.type}:${l.id}:${l.adv}`;
const header = (l) => ({ type: l.type, id: l.id, adv: l.adv, seq: l.seq, maxAge: !!l.maxAge });
const hex = (n) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
/** Which of two copies of an LSA is more recent (RFC 2328 13.1, without checksums and ages). */
function newer(a, b) {
  if (!b) return true;
  if (a.seq !== b.seq) return a.seq > b.seq;
  return !!a.maxAge && !b.maxAge;
}
const sameBody = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function describeLsa(l) {
  return `${l.type} LSA ${l.id} from ${l.adv} (seq ${hex(l.seq)}${l.maxAge ? ', withdrawn' : ''})`;
}

/** Settings for one interface, with defaults filled in. */
export function ifaceOspf(i) {
  const c = i.ospf || {};
  const hello = c.hello ?? OSPF_DEFAULTS.hello;
  // Like real routers, the dead interval follows the hello interval (x4) unless it is set
  return { hello, dead: c.dead ?? hello * 4, priority: c.priority ?? OSPF_DEFAULTS.priority };
}

/** True when `ip` falls inside a network statement (wildcard bits are "don't care"). */
export function wildcardMatch(ip, net, wildcard) {
  const care = (~ipToInt(wildcard)) >>> 0;
  return ((ipToInt(ip) & care) >>> 0) === ((ipToInt(net) & care) >>> 0);
}

const cmpRid = (a, b) => ipToInt(a) - ipToInt(b);

export class Ospf {
  constructor(router) {
    this.r = router;
    this.enabled = false;
    this.processId = null;
    this.routerIdConfigured = null;
    this.routerId = null;
    this.networks = [];          // {ip, wildcard, area}
    this.passive = new Set();    // interface names
    this.logAdjacency = true;    // %OSPF-5-ADJCHG console messages
    this.ifs = new Map();        // interface name -> runtime state
    this.referenceBw = OSPF_DEFAULTS.referenceBw; // Mbit/s, for cost = reference / bandwidth
    this.lsdb = new Map();       // lsaKey -> LSA (the link-state database for area 0)
    this.routes = [];            // OSPF routes from the last SPF run
    this.spfRuns = 0;
    this.quiet = 0;              // >0 while a batch of changes is applied
  }

  /** Cost of an interface: "ip ospf cost", else reference bandwidth / interface bandwidth. */
  ifaceCost(i) {
    const fixed = validInt(i.ospf?.cost, 1, 65535);
    if (fixed) return fixed;
    return Math.max(1, Math.min(65535, Math.floor((this.referenceBw * 1000) / bandwidthKbps(i))));
  }

  setReferenceBw(mbps) {
    this.referenceBw = mbps;
    this.refresh();
  }

  // ---------------- configuration ----------------

  enable(pid) {
    if (this.enabled) return;
    this.enabled = true;
    this.processId = pid;
    this.chooseRouterId();
    this.refresh();
  }

  disable() {
    this.flushOwn();
    this.quiet++;
    for (const st of this.ifs.values()) this.stopIface(st, 'Interface down or detached');
    this.quiet--;
    this.ifs.clear();
    this.lsdb.clear();
    this.setRoutes([]);
    this.referenceBw = OSPF_DEFAULTS.referenceBw;
    this.enabled = false;
    this.processId = null;
    this.routerId = null;
    this.networks = [];
    this.passive.clear();
    this.routerIdConfigured = null;
    this.logAdjacency = true;
  }

  /** Router ID: the configured one, else the highest IPv4 address on an interface that is up. */
  chooseRouterId() {
    if (this.routerIdConfigured) { this.routerId = this.routerIdConfigured; return; }
    const ips = this.r.ifaces.filter((i) => i.ip && this.r.ifaceUp(i)).map((i) => i.ip).sort(cmpRid);
    this.routerId = ips.length ? ips[ips.length - 1] : null;
  }

  /** Returns true if the new ID is in use now, false if it waits for "clear ip ospf process". */
  setRouterId(rid) {
    this.routerIdConfigured = rid;
    if (!this.hasNeighbours()) { this.restart(); return true; }
    return false;
  }

  clearRouterId() {
    this.routerIdConfigured = null;
    if (!this.hasNeighbours()) { this.restart(); return true; }
    return false;
  }

  /** "clear ip ospf process": drop every neighbour and start again (picks up a new router ID). */
  restart() {
    if (!this.enabled) return;
    this.flushOwn();
    this.quiet++;
    for (const st of this.ifs.values()) this.stopIface(st, 'Interface down or detached');
    this.quiet--;
    this.ifs.clear();
    // A new process starts with an empty database and learns it again from its neighbours
    this.lsdb.clear();
    this.setRoutes([]);
    this.chooseRouterId();
    this.refresh();
  }

  /**
   * Withdraws every LSA this router originated, while its adjacencies still work, so
   * neighbours stop using them at once instead of keeping them in their databases.
   */
  flushOwn() {
    if (!this.routerId || !this.r.net) return;
    for (const [key, l] of [...this.lsdb]) if (l.adv === this.routerId) this.flush(key);
  }

  hasNeighbours() {
    for (const st of this.ifs.values()) if (st.neighbors.size) return true;
    return false;
  }

  addNetwork(ip, wildcard, area) {
    const net = networkOf(ip, intToMask(wildcard));
    const existing = this.networks.find((n) => n.ip === net && n.wildcard === wildcard);
    if (existing) {
      if (existing.area !== area) return `% OSPF: "network ${net} ${wildcard} area ${existing.area}" is already configured in another area`;
      return null;
    }
    this.networks.push({ ip: net, wildcard, area });
    this.refresh();
    return null;
  }

  removeNetwork(ip, wildcard) {
    const net = networkOf(ip, intToMask(wildcard));
    this.networks = this.networks.filter((n) => !(n.ip === net && n.wildcard === wildcard));
    this.refresh();
  }

  setPassive(name, on) {
    if (on) this.passive.add(name); else this.passive.delete(name);
    this.refresh();
  }

  /** The area an interface belongs to, or null. The most specific network statement wins. */
  areaOf(i) {
    if (!i.ip) return null;
    let best = null;
    for (const n of this.networks) {
      if (!wildcardMatch(i.ip, n.ip, n.wildcard)) continue;
      const bits = popcount(ipToInt(n.wildcard));
      if (!best || bits < best.bits) best = { area: n.area, bits };
    }
    return best ? best.area : null;
  }

  /** OSPF runs on the interface (it is up, addressed and covered by a network statement). */
  ospfIface(i) {
    return this.enabled && !!i.ip && !!i.mask && this.r.ifaceUp(i) && this.areaOf(i) !== null;
  }

  // ---------------- interface state ----------------

  topologyChanged() { if (this.enabled) this.refresh(); }

  /** Starts or stops OSPF on interfaces so they match the configuration and link state. */
  refresh() {
    if (!this.enabled || !this.r.net) return;
    if (!this.routerId) this.chooseRouterId();
    this.quiet++;
    try { this.refreshIfaces(); } finally { this.quiet--; }
    this.rebuild();
  }

  refreshIfaces() {
    for (const i of this.r.ifaces) {
      const want = this.ospfIface(i) && !!this.routerId;
      const st = this.ifs.get(i.name);
      const settings = ifaceOspf(i);
      const changed = st && (st.iface !== i || st.ip !== i.ip || st.mask !== i.mask || st.area !== this.areaOf(i)
        || st.passive !== this.passive.has(i.name));
      if (st && (!want || changed)) {
        this.stopIface(st, 'Interface down or detached');
        this.ifs.delete(i.name);
      }
      if (want && (!st || changed)) { this.startIface(i); continue; }
      if (!want || !st) continue;
      if (st.hello !== settings.hello || st.dead !== settings.dead) {
        // New timers apply to the next hello. Neighbours that still use the old ones will
        // have their hellos ignored and drop when their dead timer runs out.
        st.hello = settings.hello;
        st.dead = settings.dead;
        if (!st.passive) {
          if (st.helloTimer) this.r.net.cancel(st.helloTimer);
          this.sendHello(st);
          this.scheduleHello(st);
        }
      }
      st.cost = this.ifaceCost(i);
      if (st.priority !== settings.priority) {
        st.priority = settings.priority;
        if (!st.waiting) this.electAndAdjust(st);
      }
    }
    for (const [name, st] of this.ifs) {
      if (!this.r.ifaces.includes(st.iface)) { this.stopIface(st, 'Interface down or detached'); this.ifs.delete(name); }
    }
  }

  startIface(i) {
    const s = ifaceOspf(i);
    const st = {
      iface: i, ip: i.ip, mask: i.mask, area: this.areaOf(i), passive: this.passive.has(i.name),
      hello: s.hello, dead: s.dead, priority: s.priority, cost: this.ifaceCost(i),
      dr: '0.0.0.0', bdr: '0.0.0.0', waiting: true, waitTimer: null, helloTimer: null,
      neighbors: new Map(), // router ID -> neighbour
    };
    this.ifs.set(i.name, st);
    if (st.passive) return;
    const net = this.r.net;
    // Wait timer: listen for an existing DR before electing (RFC 2328 9.4)
    st.waitTimer = net.schedule(st.dead * 1000, () => {
      st.waitTimer = null;
      if (this.ifs.get(i.name) !== st) return;
      st.waiting = false;
      this.electAndAdjust(st);
      this.rebuild();
    });
    this.sendHello(st);
    this.scheduleHello(st);
  }

  stopIface(st, reason) {
    const net = this.r.net;
    if (st.waitTimer) net?.cancel(st.waitTimer);
    if (st.helloTimer) net?.cancel(st.helloTimer);
    st.waitTimer = st.helloTimer = null;
    for (const nb of [...st.neighbors.values()]) this.dropNeighbor(st, nb, reason, false);
  }

  scheduleHello(st) {
    const net = this.r.net;
    st.helloTimer = net.schedule(st.hello * 1000, () => {
      st.helloTimer = null;
      if (this.ifs.get(st.iface.name) !== st || !net.devices.has(this.r.id)) return;
      this.sendHello(st);
      this.scheduleHello(st);
    });
  }

  role(st, ip) {
    if (ip === st.dr) return 'DR';
    if (ip === st.bdr) return 'BDR';
    return 'DROTHER';
  }

  // ---------------- packets ----------------

  sendPacket(st, dst, body) {
    const r = this.r;
    const pkt = {
      src: st.iface.ip, dst, ttl: 1, ident: r.ipIdent++, proto: 'OSPF',
      payload: { version: 2, routerId: this.routerId, area: st.area, ...body },
    };
    if (dst === OSPF_ALL_ROUTERS) r.sendFrame(st.iface, OSPF_MAC, 'IPv4', pkt);
    else r.resolveAndSend(st.iface, dst, pkt);
  }

  sendHello(st) {
    const neighbors = [...st.neighbors.keys()];
    this.r.explain?.(`OSPF: sending hello out ${st.iface.name} (router ID ${this.routerId}, ${neighbors.length} neighbour(s) seen)`);
    this.sendPacket(st, OSPF_ALL_ROUTERS, {
      type: 'Hello', mask: st.mask, hello: st.hello, dead: st.dead, priority: st.priority,
      dr: st.dr, bdr: st.bdr, neighbors,
    });
  }

  receive(iface, pkt) {
    const r = this.r;
    const m = pkt.payload;
    const st = this.ifs.get(iface.name);
    if (!this.enabled || !st) { r.explain('OSPF packet ignored (OSPF is not enabled on this interface)'); return; }
    if (st.passive) { r.explain(`OSPF packet ignored (${iface.name} is a passive interface)`); return; }
    if (r.ownsIp(pkt.src)) return;
    if (m.type === 'Hello') this.onHello(st, pkt, m);
    else if (m.type === 'DBD') this.onDbd(st, pkt, m);
    else if (m.type === 'LSR') this.onLsr(st, pkt, m);
    else if (m.type === 'LSU') this.onLsu(st, pkt, m);
    else if (m.type === 'LSAck') this.onLsAck(st, pkt, m);
  }

  onHello(st, pkt, m) {
    const r = this.r;
    // Parameters that must match before two routers can be neighbours (RFC 2328 10.5)
    if (m.area !== st.area) { r.explain(`OSPF hello from ${pkt.src} ignored: it is in area ${m.area}, this interface is in area ${st.area}`); return; }
    if (!inSubnet(pkt.src, st.ip, st.mask)) { r.explain(`OSPF hello from ${pkt.src} ignored: it is not in my subnet ${networkOf(st.ip, st.mask)}`); return; }
    if (m.mask !== st.mask) { r.explain(`OSPF hello from ${pkt.src} ignored: subnet mask ${m.mask} does not match ${st.mask}`); return; }
    if (m.hello !== st.hello) { r.explain(`OSPF hello from ${pkt.src} ignored: hello interval ${m.hello} s does not match ${st.hello} s`); return; }
    if (m.dead !== st.dead) { r.explain(`OSPF hello from ${pkt.src} ignored: dead interval ${m.dead} s does not match ${st.dead} s`); return; }
    if (m.routerId === this.routerId) {
      r.explain(`OSPF hello from ${pkt.src} ignored: it uses my own router ID ${m.routerId}`);
      r.syslog(`%OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id ${m.routerId} from ${pkt.src} on interface ${st.iface.name}`);
      return;
    }

    let nb = st.neighbors.get(m.routerId);
    if (nb && nb.ip !== pkt.src) {
      // Two different routers on this segment claim the same router ID; keep the first one
      r.explain(`OSPF hello from ${pkt.src} ignored: router ID ${m.routerId} already belongs to neighbour ${nb.ip}`);
      r.syslog(`%OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id ${m.routerId} from ${pkt.src} on interface ${st.iface.name}`);
      return;
    }
    const isNew = !nb;
    if (!nb) {
      nb = { rid: m.routerId, ip: pkt.src, state: 'DOWN', priority: m.priority, dr: m.dr, bdr: m.bdr, deadTimer: null, rxmtTimer: null, dbdSent: false, ...freshExchange() };
      st.neighbors.set(m.routerId, nb);
    }
    const prev = { priority: nb.priority, dr: nb.dr, bdr: nb.bdr };
    nb.ip = pkt.src;
    nb.priority = m.priority;
    nb.dr = m.dr;
    nb.bdr = m.bdr;
    this.resetDeadTimer(st, nb);

    if (isNew) {
      this.setState(st, nb, 'INIT');
      r.explain(`OSPF hello from ${m.routerId} (${pkt.src}): new neighbour, state INIT`);
    }
    const seesMe = (m.neighbors || []).includes(this.routerId);
    if (seesMe && rank(nb.state) < rank('2WAY')) {
      this.setState(st, nb, '2WAY');
      r.explain(`OSPF hello from ${m.routerId} lists my router ID, so we can hear each other: state 2WAY`);
    } else if (!seesMe && rank(nb.state) >= rank('2WAY')) {
      r.explain(`OSPF hello from ${m.routerId} no longer lists my router ID: back to INIT`);
      this.dropAdjacency(st, nb, 'INIT', '1-Way');
      // Two-way contact is lost, so the neighbour can no longer hold a DR or BDR role here
      if (!st.waiting) this.electAndAdjust(st);
    } else if (!isNew) {
      r.explain(`OSPF hello from ${m.routerId}: neighbour is alive (dead timer reset to ${st.dead} s)`);
    }

    // Leaving the waiting state early when the segment already has a DR or BDR (BackupSeen)
    if (st.waiting && rank(nb.state) >= rank('2WAY')) {
      const backupSeen = (m.bdr === pkt.src) || (m.dr === pkt.src && m.bdr === '0.0.0.0');
      if (backupSeen) {
        r.explain(`OSPF: ${m.routerId} already acts as ${m.dr === pkt.src ? 'DR' : 'BDR'} on this segment, so the election runs now instead of waiting`);
        st.waiting = false;
        if (st.waitTimer) { r.net.cancel(st.waitTimer); st.waitTimer = null; }
      }
    }
    const declarationChanged = prev.priority !== nb.priority || prev.dr !== nb.dr || prev.bdr !== nb.bdr;
    if (!st.waiting && (declarationChanged || seesMe)) this.electAndAdjust(st);
  }

  resetDeadTimer(st, nb) {
    const net = this.r.net;
    if (nb.deadTimer) net.cancel(nb.deadTimer);
    nb.deadTimer = net.schedule(st.dead * 1000, () => {
      nb.deadTimer = null;
      if (st.neighbors.get(nb.rid) !== nb) return;
      this.dropNeighbor(st, nb, 'Dead timer expired', true);
    });
  }

  setState(st, nb, state, reason = null) {
    const old = nb.state;
    if (old === state) return;
    nb.state = state;
    // Like real routers, the console only reports changes to and from FULL and DOWN
    if (this.logAdjacency && (state === 'FULL' || old === 'FULL' || state === 'DOWN')) {
      const why = reason || (state === 'FULL' ? 'Loading Done' : '');
      this.r.syslog(`%OSPF-5-ADJCHG: Process ${this.processId}, Nbr ${nb.rid} on ${st.iface.name} from ${old} to ${state}${why ? `, ${why}` : ''}`);
    }
    // A full adjacency appearing or going away changes this router's LSAs
    if ((old === 'FULL') !== (state === 'FULL')) this.rebuild();
  }

  dropNeighbor(st, nb, reason, reelect) {
    const net = this.r.net;
    if (nb.deadTimer) net?.cancel(nb.deadTimer);
    if (nb.rxmtTimer) net?.cancel(nb.rxmtTimer);
    nb.deadTimer = nb.rxmtTimer = null;
    this.clearExchange(nb);
    if (reason === 'Dead timer expired') this.r.explain?.(`OSPF: no hello from ${nb.rid} for ${st.dead} s, neighbour removed`);
    this.setState(st, nb, 'DOWN', reason);
    st.neighbors.delete(nb.rid);
    if (reelect && !st.waiting) this.electAndAdjust(st);
  }

  /** Falls back from an adjacency to INIT or 2WAY. */
  dropAdjacency(st, nb, state, reason) {
    if (nb.rxmtTimer) { this.r.net.cancel(nb.rxmtTimer); nb.rxmtTimer = null; }
    nb.dbdSent = false;
    this.clearExchange(nb);
    this.setState(st, nb, state, reason);
  }

  // ---------------- DR / BDR election (RFC 2328 9.4) ----------------

  elect(st) {
    const me = { rid: this.routerId, ip: st.ip, priority: st.priority, dr: st.dr, bdr: st.bdr };
    const cands = [me, ...[...st.neighbors.values()].filter((n) => rank(n.state) >= rank('2WAY'))]
      .filter((c) => c.priority > 0);
    const better = (a, b) => (a.priority !== b.priority ? a.priority > b.priority : cmpRid(a.rid, b.rid) > 0);
    const pick = (list) => list.reduce((best, c) => (!best || better(c, best) ? c : best), null);
    const run = (drNow, bdrNow) => {
      const view = cands.map((c) => (c === me ? { ...c, dr: drNow, bdr: bdrNow } : c));
      const notDr = view.filter((c) => c.dr !== c.ip);
      const bdrPool = notDr.filter((c) => c.bdr === c.ip);
      const bdr = pick(bdrPool.length ? bdrPool : notDr);
      const drPool = view.filter((c) => c.dr === c.ip);
      const dr = pick(drPool) || bdr;
      return { dr: dr ? dr.ip : '0.0.0.0', bdr: bdr ? bdr.ip : '0.0.0.0' };
    };
    let res = run(st.dr, st.bdr);
    // If this router's own role changed, repeat the election with its new declaration, so it
    // can never end up as both DR and BDR (RFC 2328 9.4 step 4)
    const roleOf = (v) => (v.dr === st.ip ? 'DR' : v.bdr === st.ip ? 'BDR' : 'DROTHER');
    if (roleOf(st) !== roleOf(res) || (res.dr === st.ip && res.bdr === st.ip)) res = run(res.dr, res.bdr);
    return res;
  }

  electAndAdjust(st) {
    if (st.passive) return;
    this.quiet++;
    try { this.electAndAdjustNow(st); } finally { this.quiet--; }
    this.rebuild();
  }

  electAndAdjustNow(st) {
    const r = this.r;
    const before = { dr: st.dr, bdr: st.bdr };
    const res = this.elect(st);
    st.dr = res.dr;
    st.bdr = res.bdr;
    if (before.dr !== st.dr || before.bdr !== st.bdr) {
      const name = (ip) => (ip === '0.0.0.0' ? 'none' : ip === st.ip ? `${ip} (me)` : ip);
      r.explain(`OSPF election on ${st.iface.name}: DR is ${name(st.dr)}, BDR is ${name(st.bdr)} (highest priority wins, then highest router ID)`);
    }
    for (const nb of st.neighbors.values()) {
      if (rank(nb.state) < rank('2WAY')) continue;
      const adj = this.shouldBeAdjacent(st, nb);
      if (adj && nb.state === '2WAY') this.startExchange(st, nb);
      else if (!adj && rank(nb.state) > rank('2WAY')) this.dropAdjacency(st, nb, '2WAY', 'Neighbor no longer DR or BDR');
    }
  }

  /** On a broadcast segment only the DR and BDR form full adjacencies with everyone (RFC 2328 10.4). */
  shouldBeAdjacent(st, nb) {
    if (st.waiting) return false;
    return st.dr === st.ip || st.bdr === st.ip || st.dr === nb.ip || st.bdr === nb.ip;
  }

  startExchange(st, nb) {
    this.setState(st, nb, 'EXSTART');
    const master = cmpRid(this.routerId, nb.rid) > 0;
    this.r.explain(`OSPF: forming an adjacency with ${nb.rid} (one of us is DR or BDR); state EXSTART, ${master ? 'I am' : `${nb.rid} is`} master because ${master ? 'my' : 'its'} router ID is higher`);
    this.sendDbd(st, nb, false);
  }

  sendDbd(st, nb, ack) {
    this.r.explain?.(`OSPF: sending database description to ${nb.rid}`);
    this.sendPacket(st, nb.ip, { type: 'DBD', ack, master: cmpRid(this.routerId, nb.rid) > 0, lsas: [...this.lsdb.values()].map(header) });
    nb.dbdSent = true;
    if (!ack && rank(nb.state) < rank('FULL')) {
      // Unanswered DBDs are sent again (the first one is often lost while ARP resolves)
      if (nb.rxmtTimer) this.r.net.cancel(nb.rxmtTimer);
      nb.rxmtTimer = this.r.net.schedule(RXMT, () => {
        nb.rxmtTimer = null;
        if (st.neighbors.get(nb.rid) === nb && rank(nb.state) >= rank('EXSTART') && rank(nb.state) < rank('FULL')) this.sendDbd(st, nb, false);
      });
    }
  }

  onDbd(st, pkt, m) {
    const r = this.r;
    const nb = st.neighbors.get(m.routerId);
    if (!nb || rank(nb.state) < rank('2WAY')) { r.explain(`OSPF database description from ${pkt.src} ignored: no two-way neighbour with router ID ${m.routerId}`); return; }
    if (nb.state === '2WAY') {
      if (!this.shouldBeAdjacent(st, nb)) { r.explain(`OSPF database description from ${m.routerId} ignored: neither of us is DR or BDR`); return; }
      this.setState(st, nb, 'EXSTART');
    }
    if (nb.state === 'FULL' || nb.state === 'LOADING') {
      if (!m.ack) this.sendDbd(st, nb, true);
      return;
    }
    if (!m.ack) this.sendDbd(st, nb, true);
    if (nb.rxmtTimer) { r.net.cancel(nb.rxmtTimer); nb.rxmtTimer = null; }
    nb.state = 'EXCHANGE';
    // Compare the neighbour's LSA headers with our own database (RFC 2328 10.6)
    nb.requests = new Map();
    for (const h of m.lsas || []) {
      const cur = this.lsdb.get(lsaKey(h));
      if (h.maxAge && !cur) continue;
      if (newer(h, cur)) nb.requests.set(lsaKey(h), h);
    }
    if (!nb.requests.size) {
      r.explain(`OSPF database description from ${m.routerId}: our link-state databases match, nothing to request, adjacency is FULL`);
      nb.state = 'LOADING';
      this.setState(st, nb, 'FULL');
      return;
    }
    this.setState(st, nb, 'LOADING');
    r.explain(`OSPF database description from ${m.routerId}: it lists ${nb.requests.size} LSA(s) I am missing or hold an older copy of; state LOADING, asking for them with a link-state request`);
    this.sendLsr(st, nb);
  }

  // ---------------- requests, updates and acknowledgements ----------------

  sendLsr(st, nb) {
    const net = this.r.net;
    if (nb.lsrTimer) net.cancel(nb.lsrTimer);
    nb.lsrTimer = null;
    if (!nb.requests.size || nb.state !== 'LOADING') return;
    this.r.explain?.(`OSPF: sending link-state request for ${nb.requests.size} LSA(s) to ${nb.rid}`);
    this.sendPacket(st, nb.ip, { type: 'LSR', requests: [...nb.requests.values()].map(header) });
    nb.lsrTimer = net.schedule(RXMT, () => {
      nb.lsrTimer = null;
      if (st.neighbors.get(nb.rid) === nb) this.sendLsr(st, nb);
    });
  }

  onLsr(st, pkt, m) {
    const r = this.r;
    const nb = st.neighbors.get(m.routerId);
    if (!nb || rank(nb.state) < rank('EXCHANGE')) { r.explain(`OSPF link-state request from ${pkt.src} ignored: no database exchange with ${m.routerId}`); return; }
    const lsas = (m.requests || []).map((h) => this.lsdb.get(lsaKey(h))).filter(Boolean);
    r.explain(`OSPF link-state request from ${m.routerId}: answering with ${lsas.length} LSA(s) in a link-state update`);
    if (lsas.length) this.sendPacket(st, nb.ip, { type: 'LSU', lsas });
  }

  onLsu(st, pkt, m) {
    const r = this.r;
    const nb = st.neighbors.get(m.routerId);
    if (!nb || rank(nb.state) < rank('EXCHANGE')) { r.explain(`OSPF link-state update from ${pkt.src} ignored: ${m.routerId} is not a full neighbour on this segment`); return; }
    const acks = [];
    const learned = [];
    let dbChanged = false;
    for (const lsa of m.lsas || []) {
      const key = lsaKey(lsa);
      const cur = this.lsdb.get(key);
      const req = nb.requests.get(key);
      if (req && !newer(req, lsa)) nb.requests.delete(key);
      if (newer(lsa, cur)) {
        if (lsa.adv === this.routerId) {
          // An old copy of one of my own LSAs (from before a restart): replace it (RFC 2328 13.4)
          r.explain(`OSPF: ${describeLsa(lsa)} is my own LSA from an earlier life; sending a newer copy`);
          this.lsdb.set(key, { ...lsa });
          acks.push(header(lsa));
          this.rebuild(key);
          continue;
        }
        if (cur) nb.rxmt.delete(key);
        r.explain(`OSPF link-state update from ${m.routerId}: new ${describeLsa(lsa)}, added to my database`);
        this.lsdb.set(key, lsa);
        dbChanged = true;
        learned.push(lsa);
        acks.push(header(lsa));
        this.flood(lsa, st, nb);
      } else if (!newer(cur, lsa)) {
        // Same copy as ours: it either acknowledges what we sent or needs an acknowledgement
        if (nb.rxmt.has(key)) nb.rxmt.delete(key);
        else acks.push(header(lsa));
      } else {
        // The neighbour has an older copy: send it ours
        nb.rxmt.set(key, cur);
        this.armRxmt(st, nb);
        this.sendPacket(st, nb.ip, { type: 'LSU', lsas: [cur] });
      }
    }
    if (!learned.length) r.explain(`OSPF link-state update from ${m.routerId}: nothing new`);
    if (acks.length) this.sendPacket(st, OSPF_ALL_ROUTERS, { type: 'LSAck', lsas: acks });
    if (nb.state === 'LOADING' && !nb.requests.size) {
      if (nb.lsrTimer) { r.net.cancel(nb.lsrTimer); nb.lsrTimer = null; }
      r.explain(`OSPF: every LSA requested from ${m.routerId} has arrived, adjacency is FULL`);
      this.setState(st, nb, 'FULL');
    }
    if (dbChanged) this.spf();
  }

  onLsAck(st, pkt, m) {
    const nb = st.neighbors.get(m.routerId);
    if (!nb || rank(nb.state) < rank('EXCHANGE')) return;
    let n = 0;
    for (const h of m.lsas || []) {
      const cur = nb.rxmt.get(lsaKey(h));
      if (cur && cur.seq === h.seq && !!cur.maxAge === !!h.maxAge) { nb.rxmt.delete(lsaKey(h)); n++; }
    }
    this.r.explain(`OSPF link-state acknowledgement from ${m.routerId}: ${n ? `${n} LSA(s) confirmed, no need to resend them` : 'nothing waiting for it'}`);
  }

  /** Sends an LSA to every neighbour that should get it (RFC 2328 13.3). */
  flood(lsa, fromSt = null, fromNb = null) {
    for (const st of this.ifs.values()) {
      if (st.passive) continue;
      const targets = [...st.neighbors.values()].filter((n) => n !== fromNb && rank(n.state) >= rank('EXCHANGE'));
      if (!targets.length) continue;
      // On the segment it came from, only the DR sends it on to everyone else
      if (st === fromSt && st.dr !== st.ip) continue;
      for (const n of targets) { n.rxmt.set(lsaKey(lsa), lsa); this.armRxmt(st, n); }
      this.r.explain?.(`OSPF: flooding ${describeLsa(lsa)} out ${st.iface.name}`);
      this.sendPacket(st, OSPF_ALL_ROUTERS, { type: 'LSU', lsas: [lsa] });
    }
  }

  /** Unacknowledged LSAs are sent again, straight to the neighbour, every 5 s. */
  armRxmt(st, nb) {
    const net = this.r.net;
    if (nb.lsuTimer) return;
    nb.lsuTimer = net.schedule(RXMT, () => {
      nb.lsuTimer = null;
      if (st.neighbors.get(nb.rid) !== nb || !nb.rxmt.size || rank(nb.state) < rank('EXCHANGE')) return;
      this.r.explain?.(`OSPF: ${nb.rid} has not acknowledged ${nb.rxmt.size} LSA(s); sending them again`);
      this.sendPacket(st, nb.ip, { type: 'LSU', lsas: [...nb.rxmt.values()] });
      this.armRxmt(st, nb);
    });
  }

  clearExchange(nb) {
    const net = this.r.net;
    if (nb.lsuTimer) net?.cancel(nb.lsuTimer);
    if (nb.lsrTimer) net?.cancel(nb.lsrTimer);
    Object.assign(nb, freshExchange());
  }

  // ---------------- originating LSAs (RFC 2328 12.4) ----------------

  /** The links in this router's router LSA. */
  ownRouterLinks() {
    const links = [];
    for (const st of this.ifs.values()) {
      const nbs = [...st.neighbors.values()];
      const transit = !st.passive && !st.waiting && st.dr !== '0.0.0.0'
        && (st.dr === st.ip ? nbs.some((n) => n.state === 'FULL') : nbs.some((n) => n.ip === st.dr && n.state === 'FULL'));
      if (transit) links.push({ kind: 'transit', id: st.dr, data: st.ip, cost: st.cost });
      else links.push({ kind: 'stub', id: networkOf(st.ip, st.mask), data: st.mask, cost: st.cost });
    }
    return links.sort((a, b) => ipToInt(a.id) - ipToInt(b.id) || a.kind.localeCompare(b.kind));
  }

  /** Installs and floods a new instance of one of this router's LSAs if its content changed. */
  originate(type, id, body, force = false) {
    const key = lsaKey({ type, id, adv: this.routerId });
    const cur = this.lsdb.get(key);
    if (cur && !cur.maxAge && !force && sameBody(bodyOf(cur), body)) return false;
    const lsa = { type, id, adv: this.routerId, seq: cur ? cur.seq + 1 : INITIAL_SEQ, born: this.r.now, ...body };
    this.lsdb.set(key, lsa);
    this.r.explain?.(`OSPF: my ${type} LSA changed, sending a new copy (seq ${hex(lsa.seq)}) to my full neighbours`);
    this.flood(lsa);
    return true;
  }

  /** Withdraws one of this router's LSAs by flooding it as too old to use (premature aging). */
  flush(key) {
    const cur = this.lsdb.get(key);
    if (!cur || cur.maxAge) return;
    const lsa = { ...cur, seq: cur.seq + 1, born: this.r.now, maxAge: true };
    this.lsdb.set(key, lsa);
    this.r.explain?.(`OSPF: withdrawing ${describeLsa(cur)}`);
    this.flood(lsa);
  }

  /** Brings this router's own LSAs up to date, then recalculates routes. */
  rebuild(forceKey = null) {
    if (this.quiet || !this.enabled || !this.routerId || !this.r.net) return;
    this.originate('router', this.routerId, { links: this.ownRouterLinks() }, forceKey === lsaKey({ type: 'router', id: this.routerId, adv: this.routerId }));
    // The DR describes its segment in a network LSA listing every router fully adjacent to it
    const wanted = new Set();
    for (const st of this.ifs.values()) {
      if (st.passive || st.waiting || st.dr !== st.ip) continue;
      const full = [...st.neighbors.values()].filter((n) => n.state === 'FULL').map((n) => n.rid).sort(cmpRid);
      if (!full.length) continue;
      const key = lsaKey({ type: 'network', id: st.ip, adv: this.routerId });
      wanted.add(key);
      this.originate('network', st.ip, { mask: st.mask, attached: [this.routerId, ...full] }, forceKey === key);
    }
    for (const [key, l] of [...this.lsdb]) {
      if (l.adv === this.routerId && !wanted.has(key) && !(l.type === 'router' && l.id === this.routerId)) this.flush(key);
    }
    this.spf();
  }

  // ---------------- shortest path first (RFC 2328 16.1) ----------------

  spf() {
    const r = this.r;
    const me = this.routerId;
    const routerLsa = (rid) => { const l = this.lsdb.get(`router:${rid}:${rid}`); return l && !l.maxAge ? l : null; };
    // Normally one network LSA per DR address. If an old one survives (the DR changed its
    // router ID), use the copy that lists the router looking for it.
    const netLsa = (id, rid) => {
      const all = [...this.lsdb.values()].filter((l) => l.type === 'network' && l.id === id && !l.maxAge);
      return all.find((l) => l.attached.includes(rid)) || null;
    };
    const root = me && routerLsa(me);
    if (!root) { this.setRoutes([]); return; }
    const hopKey = (h) => `${h.iface.name}|${h.nextHop}`;
    const merge = (a, b) => { const m = new Map([...a, ...b].map((h) => [hopKey(h), h])); return [...m.values()]; };
    const tree = new Map();
    const cand = new Map([[`R:${me}`, { kind: 'R', id: me, lsa: root, cost: 0, hops: [], isRoot: true }]]);
    const relax = (key, v) => {
      if (tree.has(key)) return;
      const c = cand.get(key);
      if (!c || v.cost < c.cost) cand.set(key, v);
      else if (v.cost === c.cost) c.hops = merge(c.hops, v.hops);
    };
    while (cand.size) {
      let best = null;
      // On equal cost, networks go first so every equal-cost path into a router is known
      // before the router itself is expanded (RFC 2328 16.1)
      for (const [k, v] of cand) if (!best || v.cost < best[1].cost || (v.cost === best[1].cost && v.kind === 'N' && best[1].kind === 'R')) best = [k, v];
      const [key, v] = best;
      cand.delete(key);
      tree.set(key, v);
      if (v.kind === 'R') {
        for (const link of v.lsa.links || []) {
          if (link.kind !== 'transit') continue;
          const n = netLsa(link.id, v.id);
          if (!n) continue; // the network must list this router too
          let hops = v.hops;
          if (v.isRoot) {
            const st = [...this.ifs.values()].find((s) => s.ip === link.data);
            if (!st) continue;
            hops = [{ iface: st.iface, nextHop: null }];
          }
          relax(`N:${link.id}`, { kind: 'N', id: link.id, lsa: n, cost: v.cost + link.cost, hops });
        }
      } else {
        for (const rid of v.lsa.attached) {
          const w = routerLsa(rid);
          const back = w && (w.links || []).find((l) => l.kind === 'transit' && l.id === v.id);
          if (!back) continue; // two-way check: the router must point back at this network
          // Across a network this router is attached to, the next hop is the neighbour itself
          const hops = v.hops.map((h) => (h.nextHop ? h : { iface: h.iface, nextHop: back.data }));
          relax(`R:${rid}`, { kind: 'R', id: rid, lsa: w, cost: v.cost, hops });
        }
      }
    }
    // Every reached network and every stub network of a reached router becomes a route
    const best = new Map();
    const offer = (network, mask, cost, hops) => {
      const k = `${network}/${mask}`;
      const c = best.get(k);
      if (!c || cost < c.cost) best.set(k, { network, mask, cost, hops });
      else if (cost === c.cost) c.hops = merge(c.hops, hops);
    };
    let routers = 0, networks = 0;
    for (const v of tree.values()) {
      if (v.kind === 'N') {
        networks++;
        offer(networkOf(v.id, v.lsa.mask), v.lsa.mask, v.cost, v.hops); // directly attached hops have no next hop and are skipped below
        continue;
      }
      routers++;
      if (v.isRoot) continue;
      for (const l of v.lsa.links || []) if (l.kind === 'stub') offer(l.id, l.data, v.cost + l.cost, v.hops);
    }
    const list = [];
    for (const b of best.values()) {
      for (const h of b.hops) if (h.nextHop) list.push({ proto: 'O', network: b.network, mask: b.mask, nextHop: h.nextHop, iface: h.iface, metric: b.cost, ad: 110 });
    }
    this.spfRuns++;
    this.lastSpf = r.now;
    this.spfTree = tree;
    const sig = (l) => l.map((x) => `${x.network}/${x.mask}>${x.nextHop}@${x.metric}`).sort().join(',');
    if (sig(list) !== sig(this.routes)) {
      r.explain?.(`OSPF: ran shortest path first (Dijkstra) over ${routers} router(s) and ${networks} transit network(s); ${list.length} OSPF route(s) now, each using the lowest total cost`);
    }
    this.setRoutes(list);
  }

  setRoutes(list) {
    const old = new Map(this.routes.map((x) => [`${x.network}/${x.mask}>${x.nextHop}`, x]));
    for (const x of list) {
      const o = old.get(`${x.network}/${x.mask}>${x.nextHop}`);
      x.time = o && o.metric === x.metric ? o.time : this.r.now;
    }
    this.routes = list;
    this.r.ospfRoutes = list;
  }

  // ---------------- show helpers ----------------

  /** Neighbour rows for "show ip ospf neighbor". */
  neighborRows() {
    const rows = [];
    for (const st of this.ifs.values()) {
      for (const nb of st.neighbors.values()) {
        const role = st.dr === '0.0.0.0' && st.bdr === '0.0.0.0' ? 'DROTHER' : this.role(st, nb.ip);
        const deadMs = nb.deadTimer ? Math.max(0, nb.deadTimer.time - this.r.now) : 0;
        rows.push({ rid: nb.rid, priority: nb.priority, state: `${nb.state}/${nb.priority === 0 ? 'DROTHER' : role}`, dead: deadMs, ip: nb.ip, iface: st.iface.name });
      }
    }
    return rows;
  }

  // ---------------- show helpers (continued) ----------------

  /** Rows for "show ip ospf interface brief". */
  interfaceRows() {
    return [...this.ifs.values()].map((st) => {
      const nbs = [...st.neighbors.values()];
      const state = st.passive ? 'DR' : st.waiting ? 'WAIT' : this.role(st, st.ip);
      return { iface: st.iface.name, area: st.area, ip: st.ip, mask: st.mask, cost: st.cost, state, full: nbs.filter((n) => n.state === 'FULL').length, count: nbs.length };
    });
  }

  /** The area this router's OSPF interfaces are in (single-area OSPF), for show commands. */
  mainArea() {
    for (const st of this.ifs.values()) return st.area;
    return this.networks[0]?.area ?? 0;
  }

  /** Router IDs this router has a usable router LSA from, with when it was originated. */
  sources() {
    const out = [];
    for (const v of this.spfTree?.values() || []) {
      if (v.kind === 'R' && !v.isRoot) out.push({ rid: v.id, born: v.lsa.born ?? 0 });
    }
    return out.sort((a, b) => cmpRid(a.rid, b.rid));
  }

  // ---------------- persistence ----------------

  save() {
    return {
      enabled: this.enabled, processId: this.processId, routerId: this.routerIdConfigured,
      networks: this.networks.map((n) => ({ ...n })), passive: [...this.passive],
      logAdjacency: this.logAdjacency,
      referenceBw: this.referenceBw === OSPF_DEFAULTS.referenceBw ? undefined : this.referenceBw,
    };
  }

  load(c = {}) {
    this.networks = (c.networks || []).map((n) => ({ ...n }));
    this.passive = new Set(c.passive || []);
    this.routerIdConfigured = c.routerId || null;
    this.logAdjacency = c.logAdjacency !== false;
    this.referenceBw = validInt(c.referenceBw, 1, 4294967) ?? OSPF_DEFAULTS.referenceBw;
    if (c.enabled) { this.enabled = false; this.enable(c.processId || 1); }
  }
}

/** A whole number within [lo, hi], or undefined (for values read from saved files). */
export function validInt(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;
}

function freshExchange() {
  return { requests: new Map(), rxmt: new Map(), lsuTimer: null, lsrTimer: null };
}

function bodyOf(l) {
  const { type, id, adv, seq, born, maxAge, ...body } = l;
  void type; void id; void adv; void seq; void born; void maxAge;
  return body;
}

function popcount(n) {
  let c = 0;
  for (n >>>= 0; n; n >>>= 1) c += n & 1;
  return c;
}

function intToMask(wildcard) {
  const n = (~ipToInt(wildcard)) >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
