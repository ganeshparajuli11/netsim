// Router: routed interfaces, 802.1Q sub-interfaces, static routes, RIPv2, OSPF, DHCP server/relay, ACLs.

import { L3Device } from './l3.js';
import { DhcpServer } from './dhcp.js';
import { Rip } from './rip.js';
import { Ospf, validInt } from './ospf.js';
import { Acl } from './acl.js';
import { Nat } from './nat.js';

export class Router extends L3Device {
  constructor(name, { gig = 3 } = {}) {
    super('router', name);
    for (let i = 0; i < gig; i++) {
      const p = this.addPort(`GigabitEthernet0/${i}`);
      p.shutdown = true; // routers ship with interfaces administratively down
      this.makeIface(p.name, p);
    }
    this.forwarding = true;
    this.proxyArp = true;
    this.queueOnArp = false; // first packet is dropped while ARP resolves (the classic ".!!!!")
    this.defaultTtl = 255;
    this.hostname = name;
    this.enableSecret = null;
    this.enablePassword = null;
    this.banner = '';
    this.startupConfig = null;
    this.dhcpServer = new DhcpServer(this);
    this.rip = new Rip(this);
    this.ospf = new Ospf(this);
    this.acl = new Acl(this);
    this.nat = new Nat(this);
    this.udpHandlers.set(67, (iface, pkt) => this.onDhcp(iface, pkt));
    this.udpHandlers.set(520, (iface, pkt) => this.rip.receive(iface, pkt));
  }

  physical(i) { return i.parent || i; }

  /** Creates (or returns) a sub-interface such as GigabitEthernet0/0.10 */
  subinterface(name) {
    const existing = this.getIface(name);
    if (existing) return existing;
    const [base] = name.split('.');
    const parent = this.getIface(base);
    if (!parent || parent.parent) return null;
    return this.makeIface(parent.name + name.slice(base.length), parent.port, { parent, vlan: null, mac: parent.mac });
  }

  ifaceUp(i) {
    if (i.parent) return i.port.isUp() && !i.shutdown && i.vlan !== null;
    return !!(i.port && i.port.isUp());
  }

  ifaceStatus(i) {
    if (i.parent) {
      if (i.port.shutdown || i.shutdown) return { status: 'administratively down', protocol: 'down' };
    } else if (i.port.shutdown) return { status: 'administratively down', protocol: 'down' };
    const up = this.ifaceUp(i);
    return { status: i.port.isUp() ? 'up' : 'down', protocol: up ? 'up' : 'down' };
  }

  onOspf(iface, pkt) { this.ospf.receive(iface, pkt); }

  filterIn(iface, pkt) { return this.acl.check(iface, 'in', pkt); }
  filterOut(iface, pkt, untranslated = pkt) {
    if (this.acl.check(iface, 'out', pkt, untranslated)) return true;
    this.nat.discardCreated(); // the flow never left, so its new translation is not kept
    return false;
  }
  translateOut(inIface, outIface, pkt) { return this.nat.translateOut(inIface, outIface, pkt); }
  answersArpFor(iface, ip) { return this.nat.ownsGlobal(iface, ip); }

  /** Outside → inside NAT happens after the inbound ACL and before routing. */
  handleIp(iface, pkt, frame) {
    const match = this.nat.inboundMatch(iface, pkt);
    if (match) {
      if (!this.filterIn(iface, pkt)) return;
      this.nat.translateIn(match, pkt);
      this.forward(iface, pkt, { inChecked: true });
      return;
    }
    super.handleIp(iface, pkt, frame);
  }

  onDhcp(iface, pkt) {
    const m = pkt.payload.payload;
    // Relay: a reply coming back from a remote server for one of our interfaces
    if (m.op === 'BOOTREPLY') {
      const out = this.ifaces.find((i) => i.ip && i.ip === m.giaddr);
      if (out) {
        this.explain(`DHCP relay: forwarding ${m.msg} from ${pkt.src} to clients on ${out.name}`);
        this.sendUdp('255.255.255.255', 67, 68, m, { iface: out });
      }
      return;
    }
    if (iface.helpers && iface.helpers.length && pkt.dst === '255.255.255.255') {
      for (const h of iface.helpers) {
        this.explain(`DHCP relay (ip helper-address): forwarding ${m.msg} to ${h} with giaddr ${iface.ip}`);
        this.sendUdp(h, 67, 67, { ...m, giaddr: iface.ip });
      }
      return;
    }
    this.dhcpServer.handle(iface, pkt, (msg) => {
      if (msg.giaddr && msg.giaddr !== '0.0.0.0') this.sendUdp(msg.giaddr, 67, 67, msg);
      else this.sendUdp('255.255.255.255', 67, 68, msg, { iface });
    });
  }

  onPortChange(port, up) {
    super.onPortChange(port, up);
    const state = port.shutdown ? 'administratively down' : up ? 'up' : 'down';
    this.syslog(`%LINK-${up ? 3 : 5}-CHANGED: Interface ${port.name}, changed state to ${state}`);
    if (!port.shutdown || !up) this.syslog(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${port.name}, changed state to ${up ? 'up' : 'down'}`);
    this.rip.topologyChanged();
    this.ospf.topologyChanged();
  }

  /** Factory defaults (used by reload without a startup-config). */
  resetConfig() {
    this.ifaces = this.ifaces.filter((i) => !i.parent);
    for (const i of this.ifaces) {
      Object.assign(i, { ip: null, mask: null, description: '', helpers: [], aclIn: null, aclOut: null, ospf: undefined, bandwidth: undefined, nat: undefined });
      i.port.shutdown = true;
    }
    this.staticRoutes = [];
    this.rip.disable();
    this.ospf.disable();
    this.dhcpServer = new DhcpServer(this);
    this.rip = new Rip(this);
    this.ospf = new Ospf(this);
    this.acl = new Acl(this);
    this.nat = new Nat(this);
    this.enableSecret = null;
    this.enablePassword = null;
    this.banner = '';
    this.hostname = 'Router';
    this.clearArp();
  }

  saveConfig() {
    return {
      hostname: this.hostname,
      enableSecret: this.enableSecret,
      enablePassword: this.enablePassword,
      banner: this.banner,
      ifaces: this.ifaces.map((i) => ({
        name: i.name, ip: i.ip, mask: i.mask, description: i.description || '',
        shutdown: i.parent ? i.shutdown : i.port.shutdown, vlan: i.vlan, nativeVlan: !!i.nativeVlan,
        sub: !!i.parent, mac: i.mac, helpers: i.helpers || [], aclIn: i.aclIn || null, aclOut: i.aclOut || null,
        rip: i.ripPassive ? { passive: true } : undefined,
        ospf: i.ospf && Object.keys(i.ospf).length ? { ...i.ospf } : undefined,
        bandwidth: i.bandwidth || undefined,
        nat: i.nat || undefined,
      })),
      staticRoutes: this.staticRoutes,
      dhcp: this.dhcpServer.save(),
      rip: this.rip.save(),
      ospf: this.ospf.enabled ? this.ospf.save() : undefined,
      acls: this.acl.save(),
      nat: this.nat.rules.length || this.nat.statics.length ? this.nat.save() : undefined,
      startupConfig: this.startupConfig,
      powered: this.powered,
    };
  }

  loadConfig(c = {}) {
    if (c.hostname) this.hostname = c.hostname;
    this.enableSecret = c.enableSecret || null;
    this.enablePassword = c.enablePassword || null;
    this.banner = c.banner || '';
    for (const ic of c.ifaces || []) {
      const i = ic.sub ? this.subinterface(ic.name) : this.getIface(ic.name);
      if (!i) continue;
      i.ip = ic.ip || null;
      i.mask = ic.mask || null;
      i.description = ic.description || '';
      i.helpers = ic.helpers || [];
      i.aclIn = ic.aclIn || null;
      i.aclOut = ic.aclOut || null;
      i.ripPassive = !!ic.rip?.passive;
      i.ospf = ic.ospf ? { ...ic.ospf } : undefined;
      i.bandwidth = validInt(ic.bandwidth, 1, 10000000);
      i.nat = ic.nat === 'inside' || ic.nat === 'outside' ? ic.nat : undefined;
      if (ic.sub) { i.shutdown = !!ic.shutdown; i.vlan = ic.vlan ?? null; i.nativeVlan = !!ic.nativeVlan; }
      else {
        i.port.shutdown = !!ic.shutdown;
        if (ic.mac) { i.port.mac = ic.mac; i.mac = ic.mac; }
      }
    }
    for (const i of this.ifaces) if (i.parent) i.mac = i.parent.mac;
    this.staticRoutes = c.staticRoutes || [];
    if (c.dhcp) this.dhcpServer.load(c.dhcp);
    if (c.rip) this.rip.load(c.rip);
    if (c.ospf) this.ospf.load(c.ospf);
    if (c.acls) this.acl.load(c.acls);
    this.nat.load(c.nat || {});
    this.startupConfig = c.startupConfig || null;
  }
}
