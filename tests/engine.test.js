import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice } from '../src/engine/factory.js';

function lan() {
  const net = new Network();
  const sw = createDevice(net, 'switch');
  const a = createDevice(net, 'pc');
  const b = createDevice(net, 'pc');
  net.connect(a.getPort('FastEthernet0'), sw.getPort('FastEthernet0/1'));
  net.connect(b.getPort('FastEthernet0'), sw.getPort('FastEthernet0/2'));
  a.setStatic({ ip: '192.168.1.10', mask: '255.255.255.0' });
  b.setStatic({ ip: '192.168.1.11', mask: '255.255.255.0' });
  return { net, sw, a, b };
}

function pingAll(net, from, dst, opts = {}) {
  const res = [];
  let done = null;
  from.ping(dst, { count: 4, ...opts, onResult: (r) => res.push(r), onDone: (s) => (done = s) });
  net.settle(60000);
  return { res, done };
}

test('two PCs on a switch can ping', () => {
  const { net, sw, a } = lan();
  const { res, done } = pingAll(net, a, '192.168.1.11');
  assert.equal(done.received, 4, JSON.stringify(res));
  assert.equal(sw.macEntries().length, 2);
});

test('different subnet without gateway fails', () => {
  const { net, a } = lan();
  const { done } = pingAll(net, a, '10.0.0.1');
  assert.equal(done.received, 0);
});

test('router between two LANs', () => {
  const net = new Network();
  const r = createDevice(net, 'router');
  const a = createDevice(net, 'pc');
  const b = createDevice(net, 'pc');
  net.connect(a.getPort('FastEthernet0'), r.getPort('GigabitEthernet0/0'));
  net.connect(b.getPort('FastEthernet0'), r.getPort('GigabitEthernet0/1'));
  const g0 = r.getIface('GigabitEthernet0/0'); g0.ip = '10.0.1.1'; g0.mask = '255.255.255.0';
  const g1 = r.getIface('GigabitEthernet0/1'); g1.ip = '10.0.2.1'; g1.mask = '255.255.255.0';
  r.getPort('GigabitEthernet0/0').shutdown = false; net.notifyPort(r.getPort('GigabitEthernet0/0'));
  r.getPort('GigabitEthernet0/1').shutdown = false; net.notifyPort(r.getPort('GigabitEthernet0/1'));
  a.setStatic({ ip: '10.0.1.10', mask: '255.255.255.0', gateway: '10.0.1.1' });
  b.setStatic({ ip: '10.0.2.10', mask: '255.255.255.0', gateway: '10.0.2.1' });
  const { res, done } = pingAll(net, a, '10.0.2.10');
  // router drops the first packet while it ARPs for b
  assert.ok(done.received >= 3, JSON.stringify(res));
  const tr = [];
  let fin = false;
  a.traceroute('10.0.2.10', { onHop: (h) => tr.push(h), onDone: () => (fin = true) });
  net.settle(60000);
  assert.ok(fin);
  assert.equal(tr.length, 2);
  assert.equal(tr[0].probes[0].from, '10.0.1.1');
});
