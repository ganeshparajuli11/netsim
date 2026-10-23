import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { LABS } from '../src/ui/labs.js';
import { ios, cmd } from './helpers.js';

/** Branch R1 with two links to ISP; PC1 behind R1, Web behind ISP. Reuses the lab topology. */
function edge() {
  const net = new Network();
  LABS.find((l) => l.id === 'default-routes').build(net);
  net.settle(200);
  const r1 = net.findDevice('R1');
  const t = ios(r1);
  t.run('en\nconf t');
  return { net, r1, t };
}

const pingOk = (net, from, ip) => {
  const pc = net.findDevice(from);
  cmd(pc).run(`ping ${ip}`, net); // first round may lose an echo to ARP
  return cmd(pc).run(`ping ${ip}`, net);
};

test('default route sets the gateway of last resort and forwards unknown traffic', () => {
  const { net, t } = edge();
  let o = t.run('do show ip route');
  assert.match(o, /Gateway of last resort is not set/);
  assert.match(pingOk(net, 'PC1', '203.0.113.10'), /Destination host unreachable|Request timed out/);

  t.run('ip route 0.0.0.0 0.0.0.0 10.0.0.2');
  o = t.run('do show ip route');
  assert.match(o, /Gateway of last resort is 10\.0\.0\.2 to network 0\.0\.0\.0/);
  assert.match(o, /S\*\s+0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.0\.2/);
  assert.match(pingOk(net, 'PC1', '203.0.113.10'), /Reply from 203\.0\.113\.10/);

  o = t.run('do show ip route 8.8.8.8');
  assert.match(o, /Routing entry for 0\.0\.0\.0\/0, supernet/);
  assert.match(o, /Known via "static", distance 1, metric 0, candidate default path/);
});

test('a floating static route waits until the preferred route disappears', () => {
  const { net, r1, t } = edge();
  t.run('ip route 0.0.0.0 0.0.0.0 10.0.0.2\nip route 0.0.0.0 0.0.0.0 10.0.1.2 10');
  let o = t.run('do show ip route static');
  assert.match(o, /S\*\s+0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.0\.2/);
  assert.doesNotMatch(o, /10\.0\.1\.2/);
  assert.doesNotMatch(o, /directly connected/); // only static routes are listed

  t.run('int g0/1\nshutdown\nexit');
  net.settle(100);
  o = t.run('do show ip route');
  assert.match(o, /Gateway of last resort is 10\.0\.1\.2/);
  assert.match(o, /S\*\s+0\.0\.0\.0\/0 \[10\/0\] via 10\.0\.1\.2/);
  assert.match(pingOk(net, 'PC1', '203.0.113.10'), /Reply from 203\.0\.113\.10/);
  assert.equal(r1.lookup('203.0.113.10').iface.name, 'GigabitEthernet0/2');

  t.run('int g0/1\nno shutdown\nexit');
  net.settle(100);
  assert.equal(r1.lookup('203.0.113.10').nextHop, '10.0.0.2');
});

test('simulation mode explains default and floating route decisions', () => {
  const { net, t } = edge();
  t.run('ip route 0.0.0.0 0.0.0.0 10.0.1.2 10\nint g0/1\nshutdown\nexit');
  pingOk(net, 'PC1', '203.0.113.10');
  net.recording = true;
  cmd(net.findDevice('PC1')).run('ping -n 1 203.0.113.10', net);
  const notes = net.events.flatMap((e) => e.notes);
  assert.ok(notes.some((n) => /R1: .*default route \(gateway of last resort\)/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => /R1: this is a floating static route \(distance 10\)/.test(n)));
});

test('static route forms, distance limits, removal and running-config', () => {
  const { r1, t } = edge();
  t.run('ip route 0.0.0.0 0.0.0.0 g0/1 5');
  assert.deepEqual(r1.staticRoutes.at(-1), { network: '0.0.0.0', mask: '0.0.0.0', nextHop: null, iface: 'GigabitEthernet0/1', ad: 5 });
  t.run('ip route 172.16.0.0 255.255.0.0 g0/2 10.0.1.2 20');
  assert.deepEqual(r1.staticRoutes.at(-1), { network: '172.16.0.0', mask: '255.255.0.0', nextHop: '10.0.1.2', iface: 'GigabitEthernet0/2', ad: 20 });
  let o = t.run('do show ip route');
  assert.match(o, /Gateway of last resort is 0\.0\.0\.0 to network 0\.0\.0\.0/);
  assert.match(o, /S\*\s+0\.0\.0\.0\/0 is directly connected, GigabitEthernet0\/1/);

  assert.match(t.run('ip route 10.9.0.0 255.255.0.0 10.0.0.2 0'), /Distance must be between 1 and 255/);
  assert.match(t.run('ip route 10.9.0.0 255.255.0.0 10.0.0.2 256'), /Distance must be between 1 and 255/);

  // distance 255: kept in the config, never installed
  t.run('ip route 10.9.0.0 255.255.0.0 10.0.0.2 255');
  assert.ok(r1.staticRoutes.some((r) => r.network === '10.9.0.0'));
  assert.ok(!r1.routes().some((r) => r.network === '10.9.0.0'));

  o = t.run('do show running-config');
  assert.match(o, /ip route 0\.0\.0\.0 0\.0\.0\.0 GigabitEthernet0\/1 5/);
  assert.match(o, /ip route 172\.16\.0\.0 255\.255\.0\.0 GigabitEthernet0\/2 10\.0\.1\.2 20/);
  assert.match(o, /ip route 10\.9\.0\.0 255\.255\.0\.0 10\.0\.0\.2 255/);

  // re-entering the same path replaces its distance; "no" ignores the distance
  t.run('ip route 10.9.0.0 255.255.0.0 10.0.0.2 7');
  assert.equal(r1.staticRoutes.filter((r) => r.network === '10.9.0.0').length, 1);
  assert.equal(r1.staticRoutes.find((r) => r.network === '10.9.0.0').ad, 7);
  t.run('no ip route 10.9.0.0 255.255.0.0 10.0.0.2 7');
  t.run('no ip route 0.0.0.0 0.0.0.0 g0/1');
  assert.ok(!r1.staticRoutes.some((r) => r.network === '10.9.0.0' || r.network === '0.0.0.0'));
});

test('older saved files without a route distance still load as distance 1', () => {
  const { net, r1 } = edge();
  r1.staticRoutes = [{ network: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.0.0.2', iface: null }];
  const copy = loadNetwork(JSON.parse(JSON.stringify(serializeNetwork(net))), new Network());
  const r = copy.findDevice('R1').gatewayOfLastResort();
  assert.equal(r.nextHop, '10.0.0.2');
  assert.equal(r.ad, 1);
});

test('default routes lab: a primary route alone does not pass the failover check', () => {
  const lab = LABS.find((l) => l.id === 'default-routes');
  const net = new Network();
  lab.build(net);
  net.settle(200);
  ios(net.findDevice('R1')).run('en\nconf t\nip route 0.0.0.0 0.0.0.0 10.0.0.2\nend');
  const res = lab.checks.map((c) => !!c.fn(net));
  assert.deepEqual(res, [true, false, true, false]);
  // same distance on both links is not a floating route
  ios(net.findDevice('R1')).run('en\nconf t\nip route 0.0.0.0 0.0.0.0 10.0.1.2\nend');
  assert.equal(!!lab.checks[1].fn(net), false);
});
