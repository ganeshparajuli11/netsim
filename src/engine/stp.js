// Spanning tree (802.1D style, one common instance).
// To keep simulation mode readable the tree is computed by the same rules a real
// bridge would apply (lowest bridge ID wins root, lowest path cost wins root port,
// lowest sender wins designated port) but without flooding hello BPDUs every 2 seconds.

const PORT_COST = (name) => (/^gig/i.test(name) ? 4 : 19);

export class Stp {
  constructor(sw) {
    this.sw = sw;
    this.enabled = true;
    this.priority = 32768;
    this.roles = new Map(); // port -> {role, cost}
    this.rootId = null;
    this.rootCost = 0;
    this.rootPort = null;
  }

  get bridgeId() { return `${String(this.priority).padStart(5, '0')}.${this.sw.baseMac}`; }

  markDirty() { if (this.sw.net) this.sw.net.stpDirty = true; }

  ensure() {
    const net = this.sw.net;
    if (net && net.stpDirty !== false) computeStp(net);
  }

  role(port) {
    this.ensure();
    return this.roles.get(port)?.role || 'designated';
  }

  forwarding(port) {
    if (!this.enabled) return true;
    return this.role(port) !== 'alternate';
  }

  state(port) {
    if (!port.isUp()) return 'disabled';
    return this.forwarding(port) ? 'forwarding' : 'blocking';
  }

  portChanged() { this.markDirty(); }
  receive() { /* BPDUs are not exchanged in this model */ }

  save() { return { enabled: this.enabled, priority: this.priority }; }
  load(c = {}) { this.enabled = c.enabled !== false; this.priority = c.priority ?? 32768; this.markDirty(); }
}

function cmp(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

export function computeStp(net) {
  net.stpDirty = false;
  const switches = [...net.devices.values()].filter((d) => d.stp);
  for (const s of switches) {
    s.stp.roles = new Map();
    s.stp.rootId = s.stp.bridgeId;
    s.stp.rootCost = 0;
    s.stp.rootPort = null;
  }
  const active = switches.filter((s) => s.stp.enabled && s.powered);
  const isBridgeLink = (p) => p.isUp() && p.peer.device.stp && p.peer.device.stp.enabled && p.peer.device.powered;

  // connected components
  const seen = new Set();
  for (const start of active) {
    if (seen.has(start)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const s = stack.pop();
      comp.push(s);
      for (const p of s.ports) {
        if (!isBridgeLink(p)) continue;
        const n = p.peer.device;
        if (!seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    const root = comp.reduce((a, b) => (a.stp.bridgeId < b.stp.bridgeId ? a : b));
    // Dijkstra-like relaxation on (cost, senderBridgeId, senderPort)
    const best = new Map([[root, { cost: 0, via: null }]]);
    const queue = [root];
    while (queue.length) {
      queue.sort((a, b) => best.get(a).cost - best.get(b).cost);
      const s = queue.shift();
      const sc = best.get(s).cost;
      for (const p of s.ports) {
        if (!isBridgeLink(p)) continue;
        const n = p.peer.device;
        const cost = sc + PORT_COST(p.peer.name);
        const cand = [cost, s.stp.bridgeId, p.name];
        const cur = best.get(n);
        const curKey = cur?.via ? [cur.cost, cur.via.port.device.stp.bridgeId, cur.via.port.name] : null;
        if (n === root) continue;
        if (!cur || cmp(cand, curKey) < 0) {
          best.set(n, { cost, via: { port: p, local: p.peer } });
          if (!queue.includes(n)) queue.push(n);
        }
      }
    }
    for (const s of comp) {
      const b = best.get(s);
      s.stp.rootId = root.stp.bridgeId;
      s.stp.rootCost = b ? b.cost : 0;
      s.stp.rootPort = b?.via ? b.via.local : null;
    }
    // port roles per segment
    for (const s of comp) {
      for (const p of s.ports) {
        if (!p.isUp()) { s.stp.roles.set(p, { role: 'disabled', cost: PORT_COST(p.name) }); continue; }
        if (!isBridgeLink(p)) { s.stp.roles.set(p, { role: 'designated', cost: PORT_COST(p.name) }); continue; }
        if (s.stp.rootPort === p) { s.stp.roles.set(p, { role: 'root', cost: PORT_COST(p.name) }); continue; }
        const n = p.peer.device;
        const mine = [s.stp.rootCost, s.stp.bridgeId, p.name];
        const theirs = [n.stp.rootCost, n.stp.bridgeId, p.peer.name];
        s.stp.roles.set(p, { role: cmp(mine, theirs) < 0 ? 'designated' : 'alternate', cost: PORT_COST(p.name) });
      }
    }
  }
}
