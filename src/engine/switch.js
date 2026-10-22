// Layer 2 switch with MAC learning, VLANs, 802.1Q trunks and a management SVI.

import { L3Device } from './l3.js';
import { BROADCAST_MAC, randomMac } from './util.js';
import { Stp } from './stp.js';

const MAC_AGING = 300000;

export class Switch extends L3Device {
  constructor(name, { fast = 24, gig = 2 } = {}) {
    super('switch', name);
    this.baseMac = randomMac();
    for (let i = 1; i <= fast; i++) this.addPort(`FastEthernet0/${i}`);
    for (let i = 1; i <= gig; i++) this.addPort(`GigabitEthernet0/${i}`);
    for (const p of this.ports) {
      p.sw = { mode: 'access', accessVlan: 1, nativeVlan: 1, allowed: null, description: '' };
    }
    this.vlans = new Map([[1, 'default']]);
    this.macTable = new Map(); // `${vlan}|${mac}` -> {port, time, vlan, mac}
    this.defaultTtl = 255;
    this.hostname = name;
    this.enableSecret = null;
    this.enablePassword = null;
    this.banner = '';
    this.startupConfig = null;
    this.makeIface('Vlan1', null, { isSvi: true, vlan: 1, mac: this.baseMac, shutdown: true });
    this.stp = new Stp(this);
  }

  // ---------- VLAN helpers ----------
  portVlans(p) {
    if (p.sw.mode === 'trunk') {
      const all = [...this.vlans.keys()];
      return p.sw.allowed ? all.filter((v) => p.sw.allowed.includes(v)) : all;
    }
    return [p.sw.accessVlan];
  }

  carries(p, vlan) {
    if (p.sw.mode === 'trunk') return !p.sw.allowed || p.sw.allowed.includes(vlan);
    return p.sw.accessVlan === vlan;
  }

  sviUp(i) {
    if (i.shutdown || !this.vlans.has(i.vlan)) return false;
    return this.ports.some((p) => p.isUp() && this.carries(p, i.vlan) && this.stp.forwarding(p));
  }

  ensureSvi(vlan) {
    const name = `Vlan${vlan}`;
    return this.getIface(name) || this.makeIface(name, null, { isSvi: true, vlan, mac: this.baseMac, shutdown: false });
  }

  // ---------- data plane ----------
  receive(port, frame) {
    if (frame.type === 'STP') { this.stp.receive(port, frame.payload); return; }
    if (!this.stp.forwarding(port)) { this.explain(`${port.name} is ${this.stp.state(port)} (spanning tree), frame discarded`); return; }
    let vlan;
    if (port.sw.mode === 'trunk') {
      vlan = frame.vlan ?? port.sw.nativeVlan;
      if (!this.carries(port, vlan)) { this.explain(`VLAN ${vlan} not allowed on trunk ${port.name}, dropped`); return; }
    } else {
      if (frame.vlan !== undefined && frame.vlan !== null) {
        this.explain(`tagged frame (VLAN ${frame.vlan}) received on access port ${port.name}, dropped`);
        return;
      }
      vlan = port.sw.accessVlan;
    }
    if (!this.vlans.has(vlan)) { this.explain(`VLAN ${vlan} does not exist on this switch, frame dropped`); return; }
    if (frame.src !== BROADCAST_MAC) {
      const k = `${vlan}|${frame.src}`;
      const prev = this.macTable.get(k);
      if (!prev || prev.port !== port) this.explain(`learned ${frame.src} on ${port.name} (VLAN ${vlan})`);
      this.macTable.set(k, { port, time: this.now, vlan, mac: frame.src });
    }
    this.switchFrame(port, frame, vlan);
  }

  switchFrame(inPort, frame, vlan) {
    // Management interface
    const svi = this.ifaces.find((i) => i.isSvi && i.vlan === vlan && this.ifaceUp(i));
    if (svi && inPort && (frame.dst === svi.mac || frame.dst === BROADCAST_MAC)) {
      const copy = { ...frame };
      delete copy.vlan;
      this.receiveOnIface(svi, copy);
      if (frame.dst === svi.mac) return;
    }
    if (frame.dst !== BROADCAST_MAC) {
      const e = this.macTable.get(`${vlan}|${frame.dst}`);
      if (e && this.now - e.time < MAC_AGING && e.port.link) {
        if (e.port === inPort) { this.explain(`destination ${frame.dst} is on the same port, frame filtered`); return; }
        this.explain(`MAC table: ${frame.dst} is on ${e.port.name}; forwarding there only`);
        this.egress(e.port, frame, vlan);
        return;
      }
    }
    const out = this.ports.filter((p) => p !== inPort && p.isUp() && this.carries(p, vlan) && this.stp.forwarding(p));
    this.explain(`${frame.dst === BROADCAST_MAC ? 'broadcast' : `unknown destination ${frame.dst}`}; flooding VLAN ${vlan} out ${out.length} port(s)`);
    for (const p of out) this.egress(p, frame, vlan);
  }

  egress(port, frame, vlan) {
    const f = { ...frame };
    if (port.sw.mode === 'trunk' && vlan !== port.sw.nativeVlan) f.vlan = vlan;
    else delete f.vlan;
    this.net.transmit(port, f);
  }

  emitFrame(iface, frame) {
    // frames from our own SVI enter the switching fabric
    this.switchFrame(null, frame, iface.vlan);
    return true;
  }

  onPortChange(port, up) {
    super.onPortChange(port, up);
    if (!up) for (const [k, e] of this.macTable) if (e.port === port) this.macTable.delete(k);
    this.stp.portChanged(port, up);
    const state = port.shutdown ? 'administratively down' : up ? 'up' : 'down';
    this.syslog(`%LINK-${up ? 3 : 5}-UPDOWN: Interface ${port.name}, changed state to ${state}`);
    if (!port.shutdown) this.syslog(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${port.name}, changed state to ${up ? 'up' : 'down'}`);
  }

  macEntries() {
    const out = [];
    for (const e of this.macTable.values()) {
      if (this.now - e.time < MAC_AGING && e.port.link) out.push(e);
    }
    return out.sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
  }

  /** Factory defaults (VLANs survive, as they live in vlan.dat on real switches). */
  resetConfig() {
    for (const p of this.ports) {
      p.shutdown = false;
      p.sw = { mode: 'access', accessVlan: 1, nativeVlan: 1, allowed: null, description: '' };
    }
    this.ifaces = [];
    this.makeIface('Vlan1', null, { isSvi: true, vlan: 1, mac: this.baseMac, shutdown: true });
    this.defaultGateway = null;
    this.stp.enabled = true;
    this.stp.priority = 32768;
    this.stp.markDirty();
    this.enableSecret = null;
    this.enablePassword = null;
    this.banner = '';
    this.hostname = 'Switch';
    this.macTable.clear();
    this.clearArp();
  }

  saveConfig() {
    return {
      hostname: this.hostname,
      enableSecret: this.enableSecret,
      enablePassword: this.enablePassword,
      banner: this.banner,
      vlans: [...this.vlans.entries()],
      ports: this.ports.map((p) => ({ name: p.name, shutdown: p.shutdown, mac: p.mac, ...p.sw })),
      svis: this.ifaces.filter((i) => i.isSvi).map((i) => ({ name: i.name, vlan: i.vlan, ip: i.ip, mask: i.mask, shutdown: i.shutdown })),
      defaultGateway: this.defaultGateway,
      baseMac: this.baseMac,
      stp: this.stp.save(),
      startupConfig: this.startupConfig,
      powered: this.powered,
    };
  }

  loadConfig(c = {}) {
    if (c.hostname) { this.hostname = c.hostname; }
    this.enableSecret = c.enableSecret || null;
    this.enablePassword = c.enablePassword || null;
    this.banner = c.banner || '';
    if (c.baseMac) this.baseMac = c.baseMac;
    if (c.vlans) this.vlans = new Map(c.vlans.map(([k, v]) => [Number(k), v]));
    for (const pc of c.ports || []) {
      const p = this.getPort(pc.name);
      if (!p) continue;
      p.shutdown = !!pc.shutdown;
      if (pc.mac) p.mac = pc.mac;
      p.sw = { mode: pc.mode || 'access', accessVlan: pc.accessVlan || 1, nativeVlan: pc.nativeVlan || 1, allowed: pc.allowed || null, description: pc.description || '' };
    }
    if (c.svis) {
      this.ifaces = this.ifaces.filter((i) => !i.isSvi);
      for (const s of c.svis) this.makeIface(s.name, null, { isSvi: true, vlan: s.vlan, mac: this.baseMac, ip: s.ip, mask: s.mask, shutdown: !!s.shutdown });
    }
    this.defaultGateway = c.defaultGateway || null;
    if (c.stp) this.stp.load(c.stp);
    this.startupConfig = c.startupConfig || null;
  }
}
