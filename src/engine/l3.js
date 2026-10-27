// A small IPv4 stack shared by hosts, routers and switch management interfaces.
// ARP, ICMP (echo, time exceeded, unreachable), longest-prefix routing and UDP delivery.

import { Device } from './device.js';
import {
  BROADCAST_MAC, inSubnet, ipToInt, maskToPrefix, networkOf, broadcastOf, isValidIp,
} from './util.js';

export const AD = { C: 0, L: 0, S: 1, R: 120, O: 110 };
const ARP_TIMEOUT = 2000;
const ARP_AGE = 4 * 60 * 60 * 1000;

export class L3Device extends Device {
  constructor(type, name) {
    super(type, name);
    this.ifaces = [];
    this.arp = new Map();
    this.arpWait = new Map();
    this.staticRoutes = [];
    this.dynamicRoutes = [];   // RIP
    this.ospfRoutes = [];      // OSPF
    this.forwarding = false;
    this.proxyArp = false;
    this.queueOnArp = true;
    this.defaultGateway = null;
    this.icmpHandlers = new Map();
    this.icmpId = 1 + Math.floor(Math.random() * 1000);
    this.ipIdent = 1;
    this.defaultTtl = 128;
    this.udpHandlers = new Map(); // port -> fn(iface, packet)
  }

  makeIface(name, port, extra = {}) {
    const iface = {
      name, port, vlan: null, ip: null, mask: null,
      mac: port ? port.mac : extra.mac, shutdown: false, description: '', ...extra,
    };
    this.ifaces.push(iface);
    return iface;
  }

  getIface(name) {
    const n = String(name).toLowerCase();
    return this.ifaces.find((i) => i.name.toLowerCase() === n) || null;
  }

  ifaceUp(i) {
    if (i.isSvi) return this.sviUp ? this.sviUp(i) : false;
    if (!i.port || !i.port.isUp()) return false;
    if (i.parent) return !i.shutdown && i.vlan !== null;
    return !i.shutdown;
  }

  /** "administratively down" vs "down" vs "up" for show commands */
  ifaceStatus(i) {
    const admin = i.parent || i.isSvi ? i.shutdown : (i.port ? i.port.shutdown : i.shutdown);
    if (admin) return { status: 'administratively down', protocol: 'down' };
    if (i.parent && i.parent.shutdown) return { status: 'administratively down', protocol: 'down' };
    const up = this.ifaceUp(i);
    return { status: up ? 'up' : 'down', protocol: up ? 'up' : 'down' };
  }

  ownsIp(ip) {
    return this.ifaces.some((i) => i.ip === ip && this.ifaceUp(i));
  }

  // ---------------- routing ----------------

  /** All usable routes, best first per prefix. */
  routes() {
    const all = [];
    for (const i of this.ifaces) {
      if (!i.ip || !i.mask || !this.ifaceUp(i)) continue;
      all.push({ proto: 'C', network: networkOf(i.ip, i.mask), mask: i.mask, iface: i, ad: 0, metric: 0 });
      if (this.forwarding) all.push({ proto: 'L', network: i.ip, mask: '255.255.255.255', iface: i, ad: 0, metric: 0 });
    }
    const connectedOnly = all.slice();
    const viaConnected = (ip) => connectedOnly.find((r) => r.proto === 'C' && inSubnet(ip, r.network, r.mask));

    for (const s of this.staticRoutes) {
      // distance 255 means "never trust this route": IOS keeps it in the config but never installs it
      if ((s.ad ?? 1) >= 255) continue;
      if (s.iface) {
        const i = this.getIface(s.iface);
        if (i && this.ifaceUp(i)) all.push({ proto: 'S', network: s.network, mask: s.mask, iface: i, nextHop: s.nextHop || null, ad: s.ad ?? 1, metric: 0, exitIface: true });
      } else if (s.nextHop) {
        // recursive lookup (one level is enough for teaching topologies)
        const r = viaConnected(s.nextHop);
        if (r) all.push({ proto: 'S', network: s.network, mask: s.mask, iface: r.iface, nextHop: s.nextHop, ad: s.ad ?? 1, metric: 0 });
      }
    }
    if (this.defaultGateway && !this.forwarding) {
      const r = viaConnected(this.defaultGateway);
      if (r) all.push({ proto: 'S', network: '0.0.0.0', mask: '0.0.0.0', iface: r.iface, nextHop: this.defaultGateway, ad: 1, metric: 0, gateway: true });
    }
    for (const d of [...this.dynamicRoutes, ...(this.ospfRoutes || [])]) {
      if (this.ifaceUp(d.iface)) all.push({ ...d, ad: d.ad ?? AD[d.proto] ?? 200 });
    }
    // keep the lowest administrative distance per prefix (ties = ECMP)
    const best = new Map();
    for (const r of all) {
      const k = `${r.network}/${r.mask}`;
      const cur = best.get(k);
      if (!cur || r.ad < cur[0].ad || (r.ad === cur[0].ad && r.metric < cur[0].metric)) best.set(k, [r]);
      else if (r.ad === cur[0].ad && r.metric === cur[0].metric && r.proto !== 'C' && r.proto !== 'L') cur.push(r);
    }
    return [...best.values()].flat();
  }

  /** The installed default route (0.0.0.0/0), or null. Shown as "Gateway of last resort". */
  gatewayOfLastResort(routes = this.routes()) {
    return routes.find((r) => r.network === '0.0.0.0' && r.mask === '0.0.0.0') || null;
  }

  lookup(dst) {
    let best = null;
    for (const r of this.routes()) {
      if (!inSubnet(dst, r.network, r.mask)) continue;
      const p = maskToPrefix(r.mask);
      if (!best || p > best.p || (p === best.p && r.ad < best.r.ad)) best = { r, p };
    }
    if (!best) return null;
    const r = best.r;
    return { route: r, iface: r.iface, nextHop: r.nextHop || dst };
  }

  // ---------------- sending ----------------

  sendFrame(iface, dstMac, type, payload) {
    const frame = { src: iface.mac, dst: dstMac, type, payload };
    if (iface.vlan !== null && iface.vlan !== undefined && !iface.isSvi && !iface.nativeVlan) frame.vlan = iface.vlan;
    if (iface.isSvi) frame.vlan = iface.vlan;
    return this.emitFrame(iface, frame);
  }

  emitFrame(iface, frame) {
    return this.net.transmit(iface.port, frame);
  }

  /**
   * Sends an IP packet. Returns 'ok', 'no-route' or 'down'.
   * opts.iface forces the egress interface (used for broadcasts / DHCP).
   */
  sendIp(packet, opts = {}) {
    const pkt = { ttl: this.defaultTtl, ident: this.ipIdent++, ...packet };
    if (opts.iface) {
      const iface = opts.iface;
      if (!this.ifaceUp(iface)) return 'down';
      if (!pkt.src) pkt.src = iface.ip || '0.0.0.0';
      if (pkt.dst === '255.255.255.255' || opts.broadcast) {
        this.sendFrame(iface, BROADCAST_MAC, 'IPv4', pkt);
        return 'ok';
      }
      this.resolveAndSend(iface, opts.nextHop || pkt.dst, pkt);
      return 'ok';
    }
    if (this.ownsIp(pkt.dst)) {
      // loopback delivery
      const iface = this.ifaces.find((i) => i.ip === pkt.dst);
      if (!pkt.src) pkt.src = pkt.dst;
      this.net.schedule(0, () => this.deliverLocal(iface, pkt));
      return 'ok';
    }
    const r = this.lookup(pkt.dst);
    if (!r) return 'no-route';
    if (!pkt.src) pkt.src = r.iface.ip;
    if (r.iface.ip && r.iface.mask && pkt.dst === broadcastOf(r.iface.ip, r.iface.mask)) {
      this.sendFrame(r.iface, BROADCAST_MAC, 'IPv4', pkt);
      return 'ok';
    }
    this.resolveAndSend(r.iface, r.nextHop, pkt);
    return 'ok';
  }

  resolveAndSend(iface, nhIp, pkt) {
    const e = this.arp.get(nhIp);
    if (e && e.iface === iface) {
      this.sendFrame(iface, e.mac, 'IPv4', pkt);
      return;
    }
    let w = this.arpWait.get(nhIp);
    if (w) {
      if (this.queueOnArp) w.queue.push(pkt);
      return;
    }
    w = { iface, queue: this.queueOnArp ? [pkt] : [] };
    if (!this.queueOnArp) this.explain(`no ARP entry for ${nhIp}; packet dropped while ARP resolves`);
    w.timer = this.net.schedule(ARP_TIMEOUT, () => {
      this.arpWait.delete(nhIp);
    });
    this.arpWait.set(nhIp, w);
    this.sendArpRequest(iface, nhIp);
  }

  sendArpRequest(iface, targetIp) {
    this.sendFrame(iface, BROADCAST_MAC, 'ARP', {
      op: 1, senderMac: iface.mac, senderIp: iface.ip || '0.0.0.0', targetMac: '0000.0000.0000', targetIp,
    });
  }

  learnArp(ip, mac, iface) {
    this.arp.set(ip, { mac, iface, time: this.now, type: 'dynamic' });
    const w = this.arpWait.get(ip);
    if (w) {
      this.arpWait.delete(ip);
      this.net.cancel(w.timer);
      for (const p of w.queue) this.sendFrame(iface, mac, 'IPv4', p);
    }
  }

  clearArp(iface = null) {
    for (const [ip, e] of this.arp) if (!iface || e.iface === iface) this.arp.delete(ip);
  }

  // ---------------- receiving ----------------

  ifaceForFrame(port, frame) {
    const tag = frame.vlan ?? null;
    const onPort = this.ifaces.filter((i) => i.port === port);
    if (tag === null) return onPort.find((i) => i.parent && i.nativeVlan) || onPort.find((i) => !i.parent) || null;
    return onPort.find((i) => i.parent && i.vlan === tag && !i.nativeVlan) || null;
  }

  receive(port, frame) {
    const iface = this.ifaceForFrame(port, frame);
    if (!iface) { this.explain(`dropped frame (no interface for VLAN tag ${frame.vlan ?? 'none'} on ${port.name})`); return; }
    this.receiveOnIface(iface, frame);
  }

  receiveOnIface(iface, frame) {
    if (!this.ifaceUp(iface)) { this.explain(`${iface.name} is down, frame dropped`); return; }
    if (frame.dst !== iface.mac && frame.dst !== BROADCAST_MAC && !frame.dst.startsWith('0100.5E')) {
      this.explain(`destination MAC ${frame.dst} is not mine (${iface.mac}), frame dropped`);
      return;
    }
    if (frame.type === 'ARP') this.handleArp(iface, frame.payload);
    else if (frame.type === 'IPv4') this.handleIp(iface, frame.payload, frame);
  }

  handleArp(iface, a) {
    if (a.op === 1) {
      if (iface.ip && a.targetIp === iface.ip) {
        if (a.senderIp !== '0.0.0.0') this.learnArp(a.senderIp, a.senderMac, iface);
        this.explain(`ARP request is for my address ${iface.ip}; replying with ${iface.mac}`);
        this.sendFrame(iface, a.senderMac, 'ARP', {
          op: 2, senderMac: iface.mac, senderIp: iface.ip, targetMac: a.senderMac, targetIp: a.senderIp,
        });
        return;
      }
      if (this.answersArpFor(iface, a.targetIp)) {
        if (a.senderIp !== '0.0.0.0') this.learnArp(a.senderIp, a.senderMac, iface);
        this.explain(`ARP request is for ${a.targetIp}, which NAT statically maps to an inside host; replying with ${iface.mac}`);
        this.sendFrame(iface, a.senderMac, 'ARP', {
          op: 2, senderMac: iface.mac, senderIp: a.targetIp, targetMac: a.senderMac, targetIp: a.senderIp,
        });
        return;
      }
      if (this.proxyArp && this.forwarding && iface.ip) {
        const r = this.lookup(a.targetIp);
        if (r && r.iface !== iface && r.route.proto !== 'L') {
          this.explain(`proxy ARP: I have a route to ${a.targetIp} via ${r.iface.name}, answering for it`);
          this.sendFrame(iface, a.senderMac, 'ARP', {
            op: 2, senderMac: iface.mac, senderIp: a.targetIp, targetMac: a.senderMac, targetIp: a.senderIp,
          });
          return;
        }
      }
      if (this.arp.has(a.senderIp)) this.arp.get(a.senderIp).mac = a.senderMac;
      this.explain(`ARP request for ${a.targetIp} is not for me, ignored`);
    } else if (a.op === 2) {
      this.learnArp(a.senderIp, a.senderMac, iface);
      this.explain(`ARP reply: learned ${a.senderIp} is at ${a.senderMac}`);
    }
  }

  isLocalDst(iface, dst) {
    if (dst === '255.255.255.255') return true;
    if (dst.startsWith('224.')) return true;
    if (this.ownsIp(dst)) return true;
    if (iface.ip && iface.mask && dst === broadcastOf(iface.ip, iface.mask)) return true;
    return false;
  }

  handleIp(iface, pkt, frame) {
    if (this.isLocalDst(iface, pkt.dst)) {
      this.deliverLocal(iface, pkt, frame);
      return;
    }
    if (!this.forwarding) {
      this.explain(`packet for ${pkt.dst} is not for me and I do not route, dropped`);
      return;
    }
    this.forward(iface, pkt);
  }

  /** Hook for addresses this device answers ARP for besides its own (static NAT). */
  answersArpFor(_iface, _ip) { return false; }

  /** Hook for ACLs etc. Return false to drop. */
  filterIn(_iface, _pkt) { return true; }
  filterOut(_iface, _pkt, _untranslated) { return true; }
  /** Hook for NAT after the routing decision. Return false to drop. */
  translateOut(_inIface, _outIface, _pkt) { return true; }

  forward(inIface, pkt, { inChecked = false } = {}) {
    if (!inChecked && !this.filterIn(inIface, pkt)) return;
    pkt.ttl -= 1;
    if (pkt.ttl <= 0) {
      this.explain(`TTL expired; sending ICMP Time Exceeded to ${pkt.src}`);
      this.sendIcmpError(pkt, 11, 0);
      return;
    }
    const r = this.lookup(pkt.dst);
    if (!r) {
      this.explain(`no route to ${pkt.dst}; sending ICMP Destination Unreachable`);
      this.sendIcmpError(pkt, 3, 0);
      return;
    }
    const via = r.nextHop !== pkt.dst ? ` via next hop ${r.nextHop}` : ' (directly connected)';
    this.explain(`routing table match ${r.route.network}/${maskToPrefix(r.route.mask)} [${r.route.proto}] → out ${r.iface.name}${via}; TTL now ${pkt.ttl}`);
    if (r.route.network === '0.0.0.0' && r.route.mask === '0.0.0.0') {
      this.explain(`no more specific route to ${pkt.dst}, so the default route (gateway of last resort) is used`);
    }
    if (r.route.proto === 'S' && r.route.ad > 1
      && this.staticRoutes.some((s) => s.network === r.route.network && s.mask === r.route.mask && (s.ad ?? 1) < r.route.ad)) {
      this.explain(`this is a floating static route (distance ${r.route.ad}); it is in use because the preferred route with a lower distance is not available`);
    }
    // ICMP errors about a dropped packet go to its real sender, so keep the untranslated header
    const before = { ...pkt, payload: { ...pkt.payload } };
    if (!this.translateOut(inIface, r.iface, pkt)) return;
    if (!this.filterOut(r.iface, pkt, before)) return;
    if (r.iface.ip && r.iface.mask && pkt.dst === broadcastOf(r.iface.ip, r.iface.mask)) {
      this.sendFrame(r.iface, BROADCAST_MAC, 'IPv4', pkt);
      return;
    }
    this.resolveAndSend(r.iface, r.nextHop, pkt);
  }

  deliverLocal(iface, pkt, _frame) {
    if (pkt.proto === 'ICMP') return this.handleIcmp(iface, pkt);
    if (pkt.proto === 'UDP') {
      const h = this.udpHandlers.get(pkt.payload.dstPort);
      if (h) return h(iface, pkt);
      this.explain(`no service on UDP port ${pkt.payload.dstPort}, dropped`);
      return;
    }
    if (pkt.proto === 'TCP') return this.onTcp?.(iface, pkt);
    if (pkt.proto === 'OSPF') {
      if (this.onOspf) return this.onOspf(iface, pkt);
      this.explain('OSPF packet ignored (this device does not run OSPF)');
    }
  }

  handleIcmp(iface, pkt) {
    const m = pkt.payload;
    if (m.type === 8) {
      if (pkt.dst === '255.255.255.255') return;
      this.explain(`ICMP echo request from ${pkt.src}; sending echo reply`);
      this.sendIp({
        src: this.ownsIp(pkt.dst) ? pkt.dst : iface.ip, dst: pkt.src, proto: 'ICMP',
        payload: { type: 0, code: 0, id: m.id, seq: m.seq, size: m.size },
      });
      return;
    }
    let key = null;
    if (m.type === 0) key = `${m.id}:${m.seq}`;
    else if ((m.type === 11 || m.type === 3) && m.orig?.icmp) key = `${m.orig.icmp.id}:${m.orig.icmp.seq}`;
    const h = key && this.icmpHandlers.get(key);
    if (h) {
      this.explain(`ICMP ${m.type === 0 ? 'echo reply' : m.type === 11 ? 'time exceeded' : 'unreachable'} received from ${pkt.src}`);
      h(pkt);
    } else {
      this.explain(`ICMP type ${m.type} from ${pkt.src} (no waiting application)`);
    }
  }

  sendIcmpError(orig, type, code) {
    if (orig.proto === 'ICMP' && orig.payload.type !== 8 && orig.payload.type !== 0) return; // never error about errors
    if (orig.src === '0.0.0.0') return;
    const r = this.lookup(orig.src);
    if (!r) return;
    this.sendIp({
      src: r.iface.ip, dst: orig.src, proto: 'ICMP',
      payload: {
        type, code,
        orig: {
          src: orig.src, dst: orig.dst, proto: orig.proto,
          icmp: orig.proto === 'ICMP' ? { type: orig.payload.type, id: orig.payload.id, seq: orig.payload.seq } : null,
          // like a real ICMP error, quote the start of the transport header so NAT can map it back
          ...(orig.proto === 'TCP' || orig.proto === 'UDP' ? { ports: { src: orig.payload?.srcPort, dst: orig.payload?.dstPort } } : {}),
        },
      },
    });
  }

  /**
   * Generic echo client used by ping and traceroute.
   * onResult({kind:'reply'|'timeout'|'ttl'|'unreachable'|'no-route', from, rtt, ttl, seq})
   */
  ping(dst, { count = 4, timeout = 1000, interval = 1000, ttl = null, size = 32, src = null, onResult = () => {}, onDone = () => {} } = {}) {
    const id = (this.icmpId++) & 0xffff;
    let seq = 0;
    let cancelled = false;
    let pendingTimer = null;
    const stats = { sent: 0, received: 0, rtts: [] };
    const next = () => {
      if (cancelled) return;
      if (seq >= count) { onDone(stats); return; }
      seq++;
      const mySeq = seq;
      const sentAt = this.now;
      const key = `${id}:${mySeq}`;
      let finished = false;
      let timer = null;
      const finish = (res) => {
        if (finished || cancelled) return;
        finished = true;
        this.icmpHandlers.delete(key);
        if (timer) this.net.cancel(timer);
        if (res.kind === 'reply') { stats.received++; stats.rtts.push(res.rtt); }
        onResult({ ...res, seq: mySeq });
        const wait = Math.max(0, sentAt + interval - this.now);
        pendingTimer = this.net.schedule(res.kind === 'timeout' ? 0 : wait, next);
      };
      this.icmpHandlers.set(key, (pkt) => {
        const m = pkt.payload;
        const rtt = this.now - sentAt;
        if (m.type === 0) finish({ kind: 'reply', from: pkt.src, rtt, ttl: pkt.ttl, size: m.size });
        else if (m.type === 11) finish({ kind: 'ttl', from: pkt.src, rtt });
        else finish({ kind: 'unreachable', from: pkt.src, rtt, code: m.code });
      });
      stats.sent++;
      const pkt = { dst, proto: 'ICMP', payload: { type: 8, code: 0, id, seq: mySeq, size } };
      if (ttl) pkt.ttl = ttl;
      if (src) pkt.src = src;
      const res = this.sendIp(pkt);
      if (res !== 'ok') {
        this.net.schedule(0, () => finish({ kind: 'no-route' }));
        return;
      }
      timer = this.net.schedule(timeout, () => finish({ kind: 'timeout' }));
    };
    next();
    return {
      cancel: () => {
        cancelled = true;
        if (pendingTimer) this.net.cancel(pendingTimer);
        for (const k of [...this.icmpHandlers.keys()]) if (k.startsWith(`${id}:`)) this.icmpHandlers.delete(k);
      },
    };
  }

  /** ICMP-based traceroute. onHop({ttl, probes:[{kind,from,rtt}]}) */
  traceroute(dst, { maxHops = 30, probes = 3, timeout = 1000, onHop = () => {}, onDone = () => {} } = {}) {
    let ttl = 0;
    let cancelled = false;
    let handle = null;
    const hop = () => {
      if (cancelled) return;
      ttl++;
      if (ttl > maxHops) { onDone(); return; }
      const results = [];
      handle = this.ping(dst, {
        count: probes, timeout, interval: 0, ttl,
        onResult: (r) => results.push(r),
        onDone: () => {
          if (cancelled) return;
          onHop({ ttl, probes: results });
          const done = results.some((r) => r.kind === 'reply' || r.kind === 'unreachable' || r.kind === 'no-route');
          if (done) onDone(); else hop();
        },
      });
    };
    hop();
    return { cancel: () => { cancelled = true; handle?.cancel(); } };
  }

  sendUdp(dst, srcPort, dstPort, payload, opts = {}) {
    return this.sendIp({ src: opts.src, dst, proto: 'UDP', payload: { srcPort, dstPort, payload } }, opts);
  }

  // ---------------- misc ----------------
  onPortChange(port, up) {
    for (const i of this.ifaces) {
      if (i.port === port && !up) {
        this.clearArp(i);
      }
    }
  }

  static validIp(ip) { return isValidIp(ip); }
  static cmpIp(a, b) { return ipToInt(a) - ipToInt(b); }
}
