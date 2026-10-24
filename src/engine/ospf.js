// OSPFv2, single area, part 1: interfaces, hellos, neighbour states, DR/BDR election and
// adjacencies on broadcast (Ethernet) networks. Written from RFC 2328 (sections 9 and 10).
// Link-state advertisements and shortest-path routes come later; until then the database
// exchange carries no LSAs, so two routers are in sync as soon as their DBDs cross.

import { ipToInt, networkOf } from './util.js';

export const OSPF_MAC = '0100.5E00.0005';
export const OSPF_ALL_ROUTERS = '224.0.0.5';
const RXMT = 5000;

// Neighbour states, lowest first (RFC 2328 10.1)
export const NBR_STATES = ['DOWN', 'INIT', '2WAY', 'EXSTART', 'EXCHANGE', 'LOADING', 'FULL'];
const rank = (s) => NBR_STATES.indexOf(s);

export const OSPF_DEFAULTS = { hello: 10, dead: 40, priority: 1 };

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
    this.ifs = new Map();        // interface name -> runtime state
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
    for (const st of this.ifs.values()) this.stopIface(st, 'Interface down or detached');
    this.ifs.clear();
    this.enabled = false;
    this.processId = null;
    this.routerId = null;
    this.networks = [];
    this.passive.clear();
    this.routerIdConfigured = null;
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
    for (const st of this.ifs.values()) this.stopIface(st, 'Interface down or detached');
    this.ifs.clear();
    this.chooseRouterId();
    this.refresh();
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
      hello: s.hello, dead: s.dead, priority: s.priority,
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
  }

  onHello(st, pkt, m) {
    const r = this.r;
    // Parameters that must match before two routers can be neighbours (RFC 2328 10.5)
    if (m.area !== st.area) { r.explain(`OSPF hello from ${pkt.src} ignored: it is in area ${m.area}, this interface is in area ${st.area}`); return; }
    if (m.mask !== st.mask) { r.explain(`OSPF hello from ${pkt.src} ignored: subnet mask ${m.mask} does not match ${st.mask}`); return; }
    if (m.hello !== st.hello) { r.explain(`OSPF hello from ${pkt.src} ignored: hello interval ${m.hello} s does not match ${st.hello} s`); return; }
    if (m.dead !== st.dead) { r.explain(`OSPF hello from ${pkt.src} ignored: dead interval ${m.dead} s does not match ${st.dead} s`); return; }
    if (m.routerId === this.routerId) {
      r.explain(`OSPF hello from ${pkt.src} ignored: it uses my own router ID ${m.routerId}`);
      r.syslog(`%OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id ${m.routerId} from ${pkt.src} on interface ${st.iface.name}`);
      return;
    }

    let nb = st.neighbors.get(m.routerId);
    const isNew = !nb;
    if (!nb) {
      nb = { rid: m.routerId, ip: pkt.src, state: 'DOWN', priority: m.priority, dr: m.dr, bdr: m.bdr, deadTimer: null, rxmtTimer: null, dbdSent: false };
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
    if (state === 'FULL' || old === 'FULL' || state === 'DOWN') {
      const why = reason || (state === 'FULL' ? 'Loading Done' : '');
      this.r.syslog(`%OSPF-5-ADJCHG: Process ${this.processId}, Nbr ${nb.rid} on ${st.iface.name} from ${old} to ${state}${why ? `, ${why}` : ''}`);
    }
  }

  dropNeighbor(st, nb, reason, reelect) {
    const net = this.r.net;
    if (nb.deadTimer) net?.cancel(nb.deadTimer);
    if (nb.rxmtTimer) net?.cancel(nb.rxmtTimer);
    nb.deadTimer = nb.rxmtTimer = null;
    if (reason === 'Dead timer expired') this.r.explain?.(`OSPF: no hello from ${nb.rid} for ${st.dead} s, neighbour removed`);
    this.setState(st, nb, 'DOWN', reason);
    st.neighbors.delete(nb.rid);
    if (reelect && !st.waiting) this.electAndAdjust(st);
  }

  /** Falls back from an adjacency to INIT or 2WAY. */
  dropAdjacency(st, nb, state, reason) {
    if (nb.rxmtTimer) { this.r.net.cancel(nb.rxmtTimer); nb.rxmtTimer = null; }
    nb.dbdSent = false;
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
    this.sendPacket(st, nb.ip, { type: 'DBD', ack, master: cmpRid(this.routerId, nb.rid) > 0, lsas: [] });
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
    if (nb.state === 'FULL') {
      if (!m.ack) this.sendDbd(st, nb, true);
      return;
    }
    if (!m.ack) this.sendDbd(st, nb, true);
    if (nb.rxmtTimer) { r.net.cancel(nb.rxmtTimer); nb.rxmtTimer = null; }
    nb.state = 'EXCHANGE';
    nb.state = 'LOADING';
    r.explain(`OSPF database description from ${m.routerId}: our link-state databases match, nothing to request, adjacency is FULL`);
    this.setState(st, nb, 'FULL');
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

  // ---------------- persistence ----------------

  save() {
    return {
      enabled: this.enabled, processId: this.processId, routerId: this.routerIdConfigured,
      networks: this.networks.map((n) => ({ ...n })), passive: [...this.passive],
    };
  }

  load(c = {}) {
    this.networks = (c.networks || []).map((n) => ({ ...n }));
    this.passive = new Set(c.passive || []);
    this.routerIdConfigured = c.routerId || null;
    if (c.enabled) { this.enabled = false; this.enable(c.processId || 1); }
  }
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
