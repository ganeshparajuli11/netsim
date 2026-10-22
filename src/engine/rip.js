// RIP version 2 (distance vector, hop count metric, split horizon, triggered updates).

import { inSubnet, networkOf, ipToInt } from './util.js';

const UPDATE = 30000;
const INVALID = 180000;
export const RIP_MAC = '0100.5E00.0009';
export const RIP_GROUP = '224.0.0.9';

function classfulMask(ip) {
  const first = ipToInt(ip) >>> 24;
  if (first < 128) return '255.0.0.0';
  if (first < 192) return '255.255.0.0';
  return '255.255.255.0';
}

export class Rip {
  constructor(router) {
    this.r = router;
    this.enabled = false;
    this.version = 2;
    this.networks = [];        // classful network statements
    this.passive = new Set();  // interface names
    this.autoSummary = true;
    this.routes = new Map();   // key -> {network, mask, nextHop, iface, metric, time}
    this.poisoned = [];
    this.timer = null;
    this.trigger = null;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.schedulePeriodic();
    this.triggerUpdate();
  }

  disable() {
    this.enabled = false;
    this.routes.clear();
    this.sync();
    if (this.timer) this.r.net?.cancel(this.timer);
    this.timer = null;
  }

  addNetwork(ip) {
    const net = networkOf(ip, classfulMask(ip));
    if (!this.networks.includes(net)) this.networks.push(net);
    this.triggerUpdate();
  }

  removeNetwork(ip) {
    const net = networkOf(ip, classfulMask(ip));
    this.networks = this.networks.filter((n) => n !== net);
    this.triggerUpdate();
  }

  ripIface(i) {
    if (!i.ip || !this.r.ifaceUp(i)) return false;
    return this.networks.some((n) => inSubnet(i.ip, n, classfulMask(n)));
  }

  schedulePeriodic() {
    const net = this.r.net;
    if (!net || !this.enabled) return;
    this.timer = net.schedule(UPDATE, () => {
      this.timer = null;
      if (!this.enabled || !net.devices.has(this.r.id)) return;
      this.expire();
      this.sendUpdates();
      this.schedulePeriodic();
    });
  }

  triggerUpdate() {
    const net = this.r.net;
    if (!net || !this.enabled || this.trigger) return;
    this.trigger = net.schedule(5, () => {
      this.trigger = null;
      if (!this.enabled) return;
      if (!this.timer) this.schedulePeriodic();
      this.sendUpdates();
    });
  }

  topologyChanged() {
    if (!this.enabled) return;
    for (const [k, rt] of this.routes) {
      if (!this.r.ifaceUp(rt.iface)) { this.routes.delete(k); this.poisoned.push({ network: rt.network, mask: rt.mask }); }
    }
    this.sync();
    this.triggerUpdate();
  }

  expire() {
    const now = this.r.now;
    for (const [k, rt] of this.routes) {
      if (now - rt.time > INVALID) { this.routes.delete(k); this.poisoned.push({ network: rt.network, mask: rt.mask }); }
    }
    this.sync();
  }

  sendUpdates() {
    const r = this.r;
    for (const i of r.ifaces) {
      if (!this.ripIface(i) || this.passive.has(i.name)) continue;
      const entries = [];
      for (const c of r.ifaces) {
        if (this.ripIface(c) && c.mask) entries.push({ network: networkOf(c.ip, c.mask), mask: c.mask, metric: 0 });
      }
      for (const rt of this.routes.values()) {
        if (rt.iface === i) continue; // split horizon
        entries.push({ network: rt.network, mask: rt.mask, metric: rt.metric });
      }
      for (const p of this.poisoned) entries.push({ ...p, metric: 16 });
      r.explain?.(`RIP: sending update with ${entries.length} route(s) out ${i.name}`);
      r.sendFrame(i, RIP_MAC, 'IPv4', {
        src: i.ip, dst: RIP_GROUP, ttl: 2, ident: r.ipIdent++, proto: 'UDP',
        payload: { srcPort: 520, dstPort: 520, payload: { command: 'response', version: 2, entries } },
      });
    }
    this.poisoned = [];
  }

  receive(iface, pkt) {
    if (!this.enabled || !this.ripIface(iface)) { this.r.explain('RIP update ignored (RIP not enabled on this interface)'); return; }
    if (this.r.ownsIp(pkt.src)) return;
    let changed = false;
    for (const e of pkt.payload.payload.entries || []) {
      const key = `${e.network}/${e.mask}`;
      // ignore our own connected networks
      if (this.r.ifaces.some((i) => i.ip && i.mask && this.r.ifaceUp(i) && networkOf(i.ip, i.mask) === e.network && i.mask === e.mask)) continue;
      const metric = Math.min(16, e.metric + 1);
      const cur = this.routes.get(key);
      if (metric >= 16) {
        if (cur && cur.nextHop === pkt.src) { this.routes.delete(key); this.poisoned.push({ network: e.network, mask: e.mask }); changed = true; }
        continue;
      }
      if (!cur || cur.nextHop === pkt.src || metric < cur.metric) {
        if (!cur || cur.metric !== metric || cur.nextHop !== pkt.src) changed = true;
        this.routes.set(key, { network: e.network, mask: e.mask, nextHop: pkt.src, iface, metric, time: this.r.now });
      }
    }
    this.r.explain(`RIP update from ${pkt.src}: ${changed ? 'routing table changed' : 'no changes'}`);
    if (changed) { this.sync(); this.triggerUpdate(); }
  }

  sync() {
    this.r.dynamicRoutes = [...this.routes.values()].map((rt) => ({
      proto: 'R', network: rt.network, mask: rt.mask, nextHop: rt.nextHop, iface: rt.iface, metric: rt.metric, ad: 120, time: rt.time,
    }));
  }

  save() {
    return { enabled: this.enabled, networks: this.networks, passive: [...this.passive], autoSummary: this.autoSummary, version: this.version };
  }
  load(c = {}) {
    this.networks = c.networks || [];
    this.passive = new Set(c.passive || []);
    this.autoSummary = c.autoSummary !== false;
    this.version = c.version || 2;
    if (c.enabled) { this.enabled = false; this.enable(); }
  }
}
