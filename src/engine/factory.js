import { Network } from './network.js';
import { Device } from './device.js';
import { PC, Laptop, Server, Hub } from './host.js';
import { Switch } from './switch.js';
import { Router } from './router.js';

export const DEVICE_TYPES = {
  router: { label: 'Router', prefix: 'Router', make: (n) => new Router(n) },
  switch: { label: 'Switch', prefix: 'Switch', make: (n) => new Switch(n) },
  hub: { label: 'Hub', prefix: 'Hub', make: (n) => new Hub(n) },
  pc: { label: 'PC', prefix: 'PC', make: (n) => new PC(n) },
  laptop: { label: 'Laptop', prefix: 'Laptop', make: (n) => new Laptop(n) },
  server: { label: 'Server', prefix: 'Server', make: (n) => new Server(n) },
};

export function createDevice(net, type, { name, x = 0, y = 0 } = {}) {
  const t = DEVICE_TYPES[type];
  if (!t) throw new Error(`Unknown device type ${type}`);
  const d = t.make(name || net.uniqueName(t.prefix));
  d.x = x;
  d.y = y;
  net.addDevice(d);
  return d;
}

export function serializeNetwork(net, extra = {}) {
  return {
    format: 'opennetsim',
    version: 1,
    ...extra,
    devices: [...net.devices.values()].map((d) => d.serialize()),
    links: [...net.links.values()].map((l) => ({
      a: { device: l.a.device.id, port: l.a.name },
      b: { device: l.b.device.id, port: l.b.name },
      type: l.type,
    })),
    notes: net.notes || [],
  };
}

export function loadNetwork(data, net = new Network()) {
  if (!data || !Array.isArray(data.devices)) throw new Error('Not a valid topology file');
  const map = new Map();
  for (const dd of data.devices) {
    const t = DEVICE_TYPES[dd.type];
    if (!t) continue;
    const d = t.make(dd.name);
    if (dd.id) { d.id = dd.id; Device.bumpId(dd.id); }
    d.x = dd.x || 0;
    d.y = dd.y || 0;
    net.addDevice(d);
    d.loadConfig(dd.config || {});
    if (dd.config && dd.config.powered === false) d.powered = false;
    map.set(dd.id || dd.name, d);
  }
  for (const l of data.links || []) {
    const da = map.get(l.a.device) || net.findDevice(l.a.device);
    const db = map.get(l.b.device) || net.findDevice(l.b.device);
    if (!da || !db) continue;
    const pa = da.getPort(l.a.port);
    const pb = db.getPort(l.b.port);
    if (pa && pb && !pa.link && !pb.link) net.connect(pa, pb, l.type);
  }
  net.notes = data.notes || [];
  return net;
}
