// DHCP server and client logic (DISCOVER / OFFER / REQUEST / ACK).

import { inSubnet, ipToInt, intToIp, networkOf, broadcastOf } from './util.js';

export class DhcpServer {
  constructor(device) {
    this.device = device;
    this.pools = [];      // {name, network, mask, defaultRouter, dns, startIp, maxUsers, enabled}
    this.excluded = [];   // [[lo, hi]]
    this.bindings = new Map(); // mac -> {ip, pool, time}
    this.offers = new Map();   // mac -> ip
    this.enabled = true;
  }

  poolFor(ip) {
    return this.pools.find((p) => p.enabled !== false && p.network && p.mask && inSubnet(ip, p.network, p.mask)) || null;
  }

  isExcluded(ip) {
    const n = ipToInt(ip);
    return this.excluded.some(([lo, hi]) => n >= ipToInt(lo) && n <= ipToInt(hi || lo));
  }

  inUse(ip, mac) {
    for (const [m, b] of this.bindings) if (b.ip === ip && m !== mac) return true;
    for (const [m, o] of this.offers) if (o === ip && m !== mac) return true;
    return this.device.ifaces.some((i) => i.ip === ip);
  }

  allocate(pool, mac) {
    const b = this.bindings.get(mac);
    if (b && b.pool === pool.name) return b.ip;
    const net = ipToInt(networkOf(pool.network, pool.mask));
    const bc = ipToInt(broadcastOf(pool.network, pool.mask));
    let start = pool.startIp ? ipToInt(pool.startIp) : net + 1;
    if (start <= net) start = net + 1;
    let count = 0;
    const max = pool.maxUsers || Infinity;
    for (let n = start; n < bc && count < max; n++, count++) {
      const ip = intToIp(n);
      if (pool.defaultRouter === ip || this.isExcluded(ip) || this.inUse(ip, mac)) continue;
      return ip;
    }
    return null;
  }

  /**
   * Handle a DHCP message that arrived on `iface`.
   * reply(msg, {relay}) sends the response.
   */
  handle(iface, pkt, reply) {
    if (!this.enabled) return;
    const m = pkt.payload.payload;
    const scopeIp = m.giaddr && m.giaddr !== '0.0.0.0' ? m.giaddr : iface.ip;
    if (!scopeIp) return;
    const pool = this.poolFor(scopeIp);
    const dev = this.device;
    if (!pool) { dev.explain(`DHCP ${m.msg}: no pool for subnet of ${scopeIp}`); return; }
    const base = {
      op: 'BOOTREPLY', xid: m.xid, chaddr: m.chaddr, giaddr: m.giaddr || '0.0.0.0',
      siaddr: iface.ip,
      options: { mask: pool.mask, router: pool.defaultRouter || null, dns: pool.dns || null, serverId: iface.ip, lease: 86400 },
    };
    if (m.msg === 'DISCOVER') {
      const ip = this.allocate(pool, m.chaddr);
      if (!ip) { dev.explain(`DHCP pool ${pool.name} exhausted`); return; }
      this.offers.set(m.chaddr, ip);
      dev.explain(`DHCP DISCOVER from ${m.chaddr}: offering ${ip} from pool ${pool.name}`);
      reply({ ...base, msg: 'OFFER', yiaddr: ip });
    } else if (m.msg === 'REQUEST') {
      if (m.options?.serverId && m.options.serverId !== iface.ip) {
        this.offers.delete(m.chaddr);
        return; // client chose another server
      }
      const want = m.options?.requestedIp || m.ciaddr;
      const ok = want && inSubnet(want, pool.network, pool.mask) && !this.inUse(want, m.chaddr) && !this.isExcluded(want);
      if (!ok) {
        dev.explain(`DHCP REQUEST for ${want} refused (NAK)`);
        reply({ ...base, msg: 'NAK', yiaddr: '0.0.0.0' });
        return;
      }
      this.offers.delete(m.chaddr);
      this.bindings.set(m.chaddr, { ip: want, pool: pool.name, time: dev.now });
      dev.explain(`DHCP REQUEST: leasing ${want} to ${m.chaddr}`);
      reply({ ...base, msg: 'ACK', yiaddr: want });
    } else if (m.msg === 'RELEASE') {
      this.bindings.delete(m.chaddr);
      dev.explain(`DHCP RELEASE from ${m.chaddr}`);
    }
  }

  save() {
    return { pools: this.pools, excluded: this.excluded, enabled: this.enabled };
  }
  load(c = {}) {
    this.pools = c.pools || [];
    this.excluded = c.excluded || [];
    this.enabled = c.enabled !== false;
  }
}

/** Client side state machine for a host interface. */
export class DhcpClient {
  constructor(host, iface) {
    this.host = host;
    this.iface = iface;
    this.state = 'idle';
    this.xid = 0;
    this.timer = null;
    this.tries = 0;
    this.onChange = null;
  }

  start() {
    this.stopTimer();
    this.state = 'selecting';
    this.tries = 0;
    this.xid = Math.floor(Math.random() * 0xffffffff);
    this.sendDiscover();
  }

  stop() {
    this.stopTimer();
    this.state = 'idle';
  }

  stopTimer() {
    if (this.timer) { this.host.net?.cancel(this.timer); this.timer = null; }
  }

  sendDiscover() {
    const h = this.host;
    this.tries++;
    h.sendUdp('255.255.255.255', 68, 67, {
      op: 'BOOTREQUEST', msg: 'DISCOVER', xid: this.xid, chaddr: this.iface.mac, ciaddr: '0.0.0.0', giaddr: '0.0.0.0', options: {},
    }, { iface: this.iface, src: '0.0.0.0' });
    this.timer = h.net.schedule(3000, () => {
      this.timer = null;
      if (this.state === 'bound') return;
      if (this.tries < 3) { this.sendDiscover(); return; }
      this.fail();
    });
  }

  fail() {
    this.state = 'failed';
    const h = this.host;
    const tail = this.iface.mac.replace(/\./g, '');
    const a = parseInt(tail.slice(8, 10), 16) % 254 + 1;
    const b = parseInt(tail.slice(10, 12), 16) % 254 + 1;
    h.applyIp(`169.254.${a}.${b}`, '255.255.0.0', null, null);
    this.onChange?.('failed');
  }

  handle(pkt) {
    const m = pkt.payload.payload;
    if (m.xid !== this.xid || m.chaddr !== this.iface.mac) return;
    const h = this.host;
    if (m.msg === 'OFFER' && this.state === 'selecting') {
      this.state = 'requesting';
      h.explain(`DHCP OFFER of ${m.yiaddr}; requesting it`);
      h.sendUdp('255.255.255.255', 68, 67, {
        op: 'BOOTREQUEST', msg: 'REQUEST', xid: this.xid, chaddr: this.iface.mac, ciaddr: '0.0.0.0', giaddr: '0.0.0.0',
        options: { requestedIp: m.yiaddr, serverId: m.options.serverId },
      }, { iface: this.iface, src: '0.0.0.0' });
    } else if (m.msg === 'ACK' && this.state === 'requesting') {
      this.stopTimer();
      this.state = 'bound';
      this.server = m.options.serverId;
      h.explain(`DHCP ACK: configured ${m.yiaddr}/${m.options.mask}`);
      h.applyIp(m.yiaddr, m.options.mask, m.options.router, m.options.dns);
      this.onChange?.('bound');
    } else if (m.msg === 'NAK') {
      h.explain('DHCP NAK; restarting');
      this.start();
    }
  }

  release() {
    const h = this.host;
    if (this.state === 'bound' && this.iface.ip) {
      h.sendUdp(this.server || '255.255.255.255', 68, 67, {
        op: 'BOOTREQUEST', msg: 'RELEASE', xid: this.xid, chaddr: this.iface.mac, ciaddr: this.iface.ip, giaddr: '0.0.0.0', options: {},
      }, this.server ? {} : { iface: this.iface });
    }
    this.stop();
    h.applyIp(null, null, null, null);
  }
}
