// End devices: PC, Laptop and Server. One NIC, optional DHCP client, optional services.

import { L3Device } from './l3.js';
import { Device } from './device.js';
import { DhcpClient, DhcpServer } from './dhcp.js';
import { isValidIp, BROADCAST_MAC } from './util.js';

export class Host extends L3Device {
  constructor(type, name) {
    super(type, name);
    const port = this.addPort('FastEthernet0');
    this.nic = this.makeIface('FastEthernet0', port);
    this.ipMode = 'static';
    this.dnsServer = null;
    this.defaultTtl = 128;
    this.dhcp = new DhcpClient(this, this.nic);
    this.dhcp.onChange = () => this.net?.emit('config', this);
    this.udpHandlers.set(68, (_i, pkt) => this.dhcp.handle(pkt));
    this.nextEphemeral = 49152 + Math.floor(Math.random() * 1000);

    // Services (only enabled on servers by default, but any host can run them)
    this.dhcpServer = new DhcpServer(this);
    this.dhcpServer.enabled = false;
    this.dns = { enabled: false, records: [] }; // {name, ip}
    this.http = { enabled: false, pages: { 'index.html': '<h1>It works!</h1><p>Served by this simulated server.</p>' } };
    this.udpHandlers.set(67, (iface, pkt) => {
      if (!this.dhcpServer.enabled) return;
      this.dhcpServer.handle(iface, pkt, (msg) => this.dhcpReply(iface, msg));
    });
    this.udpHandlers.set(53, (iface, pkt) => this.dnsServe(iface, pkt));
  }

  dhcpReply(iface, msg) {
    if (msg.giaddr && msg.giaddr !== '0.0.0.0') {
      this.sendUdp(msg.giaddr, 67, 67, msg);
    } else {
      this.sendUdp('255.255.255.255', 67, 68, msg, { iface });
    }
  }

  applyIp(ip, mask, gw, dns) {
    this.nic.ip = ip || null;
    this.nic.mask = mask || null;
    this.defaultGateway = gw || null;
    if (dns !== undefined) this.dnsServer = dns || null;
    this.clearArp();
    this.net?.emit('config', this);
  }

  setStatic({ ip, mask, gateway, dns }) {
    this.dhcp.stop();
    this.ipMode = 'static';
    this.applyIp(ip, mask, gateway, dns);
  }

  setDhcp() {
    this.ipMode = 'dhcp';
    this.applyIp(null, null, null, null);
    if (this.nic.port.isUp()) this.dhcp.start();
  }

  onPortChange(port, up) {
    super.onPortChange(port, up);
    if (up && this.ipMode === 'dhcp' && this.dhcp.state !== 'bound') this.dhcp.start();
  }

  // ------------- DNS -------------
  resolveName(name, cb) {
    if (isValidIp(name)) { cb(name); return; }
    const local = this.dns.enabled && this.dns.records.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (local) { cb(local.ip); return; }
    if (!this.dnsServer) { cb(null); return; }
    const port = this.nextEphemeral++;
    let done = false;
    const finish = (ip) => {
      if (done) return;
      done = true;
      this.udpHandlers.delete(port);
      cb(ip);
    };
    this.udpHandlers.set(port, (_i, pkt) => {
      const m = pkt.payload.payload;
      finish(m.answer || null);
    });
    const r = this.sendUdp(this.dnsServer, port, 53, { qr: 0, name, type: 'A' });
    if (r !== 'ok') { finish(null); return; }
    this.net.schedule(2000, () => finish(null));
  }

  dnsServe(_iface, pkt) {
    const m = pkt.payload.payload;
    if (!this.dns.enabled || m.qr) { this.explain('DNS service is off, query dropped'); return; }
    const rec = this.dns.records.find((r) => r.name.toLowerCase() === String(m.name).toLowerCase());
    this.explain(rec ? `DNS: ${m.name} → ${rec.ip}` : `DNS: no record for ${m.name}`);
    this.sendUdp(pkt.src, 53, pkt.payload.srcPort, { qr: 1, name: m.name, type: 'A', answer: rec ? rec.ip : null, rcode: rec ? 0 : 3 });
  }

  // ------------- HTTP (single request/response over a simplified TCP) -------------
  onTcp(_iface, pkt) {
    const seg = pkt.payload;
    const m = seg.payload || {};
    if (seg.dstPort === 80 && m.method) {
      if (!this.http.enabled) { this.explain('HTTP service is off; connection refused'); return; }
      const path = (m.path || '/').replace(/^\//, '') || 'index.html';
      const body = this.http.pages[path];
      this.explain(`HTTP ${m.method} /${path} → ${body !== undefined ? '200' : '404'}`);
      this.sendIp({ dst: pkt.src, proto: 'TCP', payload: { srcPort: 80, dstPort: seg.srcPort, payload: { status: body !== undefined ? 200 : 404, body: body ?? '<h1>404 Not Found</h1>' } } });
      return;
    }
    const h = this.udpHandlers.get(`tcp:${seg.dstPort}`);
    if (h) h(pkt);
  }

  httpGet(target, cb) {
    const m = String(target).replace(/^https?:\/\//, '').match(/^([^/]+)(\/.*)?$/);
    if (!m) { cb({ error: 'Invalid URL' }); return; }
    const [, host, path = '/'] = m;
    this.resolveName(host, (ip) => {
      if (!ip) { cb({ error: `Could not resolve ${host}` }); return; }
      const port = this.nextEphemeral++;
      let done = false;
      const finish = (r) => { if (done) return; done = true; this.udpHandlers.delete(`tcp:${port}`); cb(r); };
      this.udpHandlers.set(`tcp:${port}`, (pkt) => finish({ status: pkt.payload.payload.status, body: pkt.payload.payload.body, ip }));
      const r = this.sendIp({ dst: ip, proto: 'TCP', payload: { srcPort: port, dstPort: 80, payload: { method: 'GET', path, host } } });
      if (r !== 'ok') { finish({ error: 'Request timed out' }); return; }
      this.net.schedule(3000, () => finish({ error: 'Request timed out' }));
    });
  }

  saveConfig() {
    return {
      ipMode: this.ipMode,
      ip: this.ipMode === 'static' ? this.nic.ip : null,
      mask: this.ipMode === 'static' ? this.nic.mask : null,
      gateway: this.ipMode === 'static' ? this.defaultGateway : null,
      dns: this.ipMode === 'static' ? this.dnsServer : null,
      mac: this.nic.mac,
      dhcpServer: this.dhcpServer.save(),
      dnsService: this.dns,
      http: this.http,
      powered: this.powered,
    };
  }

  loadConfig(c = {}) {
    if (c.mac) { this.nic.mac = c.mac; this.nic.port.mac = c.mac; }
    if (c.dhcpServer) this.dhcpServer.load(c.dhcpServer);
    if (c.dnsService) this.dns = { enabled: !!c.dnsService.enabled, records: c.dnsService.records || [] };
    if (c.http) this.http = c.http;
    if (c.ipMode === 'dhcp') { this.ipMode = 'dhcp'; }
    else this.setStatic({ ip: c.ip, mask: c.mask, gateway: c.gateway, dns: c.dns });
  }
}

export class PC extends Host { constructor(name) { super('pc', name); } }
export class Laptop extends Host { constructor(name) { super('laptop', name); } }
export class Server extends Host {
  constructor(name) {
    super('server', name);
    this.http.enabled = true;
  }
}

/** Layer 1 hub: repeats everything out of every other port. */
export class Hub extends Device {
  constructor(name, ports = 8) {
    super('hub', name);
    for (let i = 0; i < ports; i++) this.addPort(`Port${i}`);
  }
  receive(port, frame) {
    const out = this.ports.filter((p) => p !== port && p.isUp());
    this.explain(`hub repeats the signal out ${out.length} other port(s)`);
    for (const p of out) this.net.transmit(p, frame);
  }
  saveConfig() { return { powered: this.powered }; }
}

export { BROADCAST_MAC };
