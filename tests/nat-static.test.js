import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { LABS } from '../src/ui/labs.js';
import { ios, cmd } from './helpers.js';

/** The "Publish a server with static NAT" lab: PC1 and Srv behind R1, Home behind ISP. */
function office() {
  const net = new Network();
  LABS.find((l) => l.id === 'nat-static').build(net);
  net.settle(200);
  const r1 = net.findDevice('R1');
  return { net, r1, t: ios(r1) };
}

const STATIC = `en
  conf t
  interface g0/0
  ip nat inside
  interface g0/1
  ip nat outside
  exit
  ip nat inside source static 192.168.1.20 198.51.100.3
  end`;

const pingTwice = (net, from, ip) => {
  const pc = net.findDevice(from);
  cmd(pc).run(`ping ${ip}`, net); // the first echoes may be lost to ARP on the routers
  return cmd(pc).run(`ping ${ip}`, net);
};

function browse(net, from, url) {
  const host = net.findDevice(from);
  let res = null;
  for (let i = 0; i < 3 && res?.status !== 200; i++) {
    host.httpGet(url, (r) => { res = r; });
    net.settle(5000);
  }
  return res;
}

const between = (net, a, b) => net.events.filter((e) => e.from === a && e.to === b && e.frame.type === 'IPv4');

test('without static NAT nobody outside can reach the inside server', () => {
  const { net } = office();
  assert.doesNotMatch(pingTwice(net, 'Home', '198.51.100.3'), /Reply from/);
});

test('static NAT lets an outside host start a conversation with the inside server', () => {
  const { net, r1, t } = office();
  t.run(STATIC);
  net.recording = true;
  assert.match(pingTwice(net, 'Home', '198.51.100.3'), /Reply from 198\.51\.100\.3/);
  // towards Srv, the destination is the private address; the source is untouched
  const down = between(net, 'R1', 'S1').filter((e) => e.frame.payload.proto === 'ICMP');
  assert.ok(down.length > 0 && down.every((e) => e.frame.payload.dst === '192.168.1.20' && e.frame.payload.src === '203.0.113.10'));
  // Srv's replies leave R1 with the public address
  const up = between(net, 'R1', 'ISP');
  assert.ok(up.length > 0 && up.every((e) => e.frame.payload.src === '198.51.100.3'));
  assert.ok(net.events.some((e) => e.notes.some((n) => /R1: NAT: 198\.51\.100\.3 is statically mapped to 192\.168\.1\.20; destination rewritten/.test(n))));
  assert.ok(net.events.some((e) => e.notes.some((n) => /R1: NAT: static mapping 192\.168\.1\.20 → 198\.51\.100\.3; source address rewritten/.test(n))));
  assert.ok(r1.nat.hits > 0);
  assert.equal(r1.nat.translations().length, 0, 'static NAT does not create dynamic entries');
});

test('web browsing reaches the inside server through its public address', () => {
  const { net, t } = office();
  t.run(STATIC);
  const res = browse(net, 'Home', 'http://198.51.100.3/');
  assert.equal(res?.status, 200);
  assert.match(res.body, /It works/);
});

test('R1 answers ARP for the static global address only on the outside interface', () => {
  const { net, t } = office();
  t.run(STATIC);
  net.recording = true;
  pingTwice(net, 'Home', '198.51.100.3');
  const reply = net.events.find((e) => e.from === 'R1' && e.to === 'ISP' && e.frame.type === 'ARP' && e.frame.payload.op === 2 && e.frame.payload.senderIp === '198.51.100.3');
  assert.ok(reply, 'R1 replies to the ARP request for 198.51.100.3');
  assert.equal(reply.frame.payload.senderMac, net.findDevice('R1').getIface('GigabitEthernet0/1').mac);
  // an unmapped address in the same block gets no answer
  net.events = [];
  assert.doesNotMatch(pingTwice(net, 'Home', '198.51.100.4'), /Reply from/);
  assert.ok(!net.events.some((e) => e.from === 'R1' && e.frame.type === 'ARP' && e.frame.payload.op === 2 && e.frame.payload.senderIp === '198.51.100.4'));
  // inside, nobody gets an answer for the global address
  const r1 = net.findDevice('R1');
  assert.equal(r1.answersArpFor(r1.getIface('GigabitEthernet0/0'), '198.51.100.3'), false);
});

test('a static mapping wins over overload for the same host; other hosts are still overloaded', () => {
  const { net, r1, t } = office();
  t.run(STATIC);
  t.run(`conf t
    access-list 1 permit 192.168.1.0 0.0.0.255
    ip nat inside source list 1 interface g0/1 overload
    end`);
  net.recording = true;
  assert.match(pingTwice(net, 'Srv', '203.0.113.10'), /Reply from 203\.0\.113\.10/);
  assert.ok(between(net, 'R1', 'ISP').every((e) => e.frame.payload.src === '198.51.100.3'));
  net.events = [];
  assert.match(pingTwice(net, 'PC1', '203.0.113.10'), /Reply from 203\.0\.113\.10/);
  assert.ok(between(net, 'R1', 'ISP').every((e) => e.frame.payload.src === '198.51.100.2'));
  assert.ok(r1.nat.translations().every((e) => e.insideLocal === '192.168.1.10'));
});

test('traceroute from the inside server works through the static mapping', () => {
  const { net, t } = office();
  t.run(STATIC);
  pingTwice(net, 'Srv', '203.0.113.10');
  const out = cmd(net.findDevice('Srv')).run('tracert 203.0.113.10', net);
  assert.match(out, /198\.51\.100\.1/);
  assert.match(out, /203\.0\.113\.10/);
});

test('a global address outside the link subnet works when the provider routes it to R1', () => {
  const { net, r1, t } = office();
  t.run(`en
    conf t
    interface g0/0
    ip nat inside
    interface g0/1
    ip nat outside
    exit
    ip nat inside source static 192.168.1.20 192.0.2.5
    end`);
  ios(net.findDevice('ISP')).run('en\nconf t\nip route 192.0.2.0 255.255.255.0 198.51.100.2\nend');
  assert.match(pingTwice(net, 'Home', '192.0.2.5'), /Reply from 192\.0\.2\.5/);
  assert.equal(r1.answersArpFor(r1.getIface('GigabitEthernet0/1'), '192.0.2.5'), false);
});

test('static NAT commands, show output and errors', () => {
  const { r1, t } = office();
  t.run(STATIC);
  assert.match(t.run('show running-config'), /\nip nat inside source static 192\.168\.1\.20 198\.51\.100\.3\n/);
  assert.match(t.run('show ip nat translations'), /---\s+198\.51\.100\.3\s+192\.168\.1\.20\s+---\s+---/);
  assert.match(t.run('show ip nat translations verbose'), /flags: static/);
  assert.match(t.run('show ip nat statistics'), /Total active translations: 1 \(1 static, 0 dynamic; 0 extended\)/);
  // clashes and mistakes
  t.run('conf t');
  assert.match(t.run('ip nat inside source static 192.168.1.20 198.51.100.4'), /already uses one of these addresses/);
  assert.match(t.run('ip nat inside source static 192.168.1.21 198.51.100.3'), /already uses one of these addresses/);
  assert.match(t.run('ip nat inside source static 192.168.1.21 198.51.100.2'), /address of this router/);
  assert.match(t.run('ip nat inside source static 192.168.1.21 192.168.1.21'), /must be different/);
  assert.equal(t.run('ip nat inside source static 192.168.1.20 198.51.100.3'), '', 'repeating a mapping is harmless');
  assert.deepEqual(r1.nat.statics, [{ local: '192.168.1.20', global: '198.51.100.3' }]);
  // clearing dynamic translations keeps static ones
  t.run('end\nclear ip nat translation *\nconf t');
  assert.equal(r1.nat.statics.length, 1);
  assert.match(t.run('no ip nat inside source static 192.168.1.20 198.51.100.4'), /Translation not found/);
  t.run('no ip nat inside source static 192.168.1.20 198.51.100.3');
  assert.equal(r1.nat.statics.length, 0);
  assert.doesNotMatch(t.run('do show running-config'), /source static/);
});

test('static mappings are saved, and files without them still load', () => {
  const { net, t } = office();
  t.run(STATIC);
  const saved = serializeNetwork(net);
  const copy = loadNetwork(JSON.parse(JSON.stringify(saved)), new Network());
  assert.deepEqual(copy.findDevice('R1').nat.statics, [{ local: '192.168.1.20', global: '198.51.100.3' }]);
  assert.match(pingTwice(copy, 'Home', '198.51.100.3'), /Reply from 198\.51\.100\.3/);
  // a file from before static NAT: only overload rules
  const old = JSON.parse(JSON.stringify(saved));
  const r1 = (old.devices || []).find((d) => d.name === 'R1');
  const cfg = r1.config || r1;
  cfg.nat = { rules: [{ acl: 1, iface: 'GigabitEthernet0/1', overload: true }] };
  const loaded = loadNetwork(old, new Network());
  assert.deepEqual(loaded.findDevice('R1').nat.statics, []);
  assert.equal(loaded.findDevice('R1').nat.rules.length, 1);
});

test('mappings that use any router address are refused, even on an interface that is down', () => {
  const { r1, t } = office();
  t.run('en\nconf t\ninterface g0/2\nip address 10.9.9.1 255.255.255.0\nexit'); // still shut down
  assert.match(t.run('ip nat inside source static 10.9.9.1 198.51.100.5'), /10\.9\.9\.1 is an address of this router \(GigabitEthernet0\/2\)/);
  assert.match(t.run('ip nat inside source static 192.168.1.30 10.9.9.1'), /10\.9\.9\.1 is an address of this router/);
  assert.match(t.run('ip nat inside source static 192.168.1.1 198.51.100.5'), /192\.168\.1\.1 is an address of this router/);
  assert.deepEqual(r1.nat.statics, []);
});

test('ICMP errors quote the public address the outside sender used', () => {
  const { net, t } = office();
  t.run(STATIC);
  pingTwice(net, 'Home', '198.51.100.3');
  net.recording = true;
  const out = cmd(net.findDevice('Home')).run('tracert 198.51.100.3', net);
  assert.match(out, /198\.51\.100\.2/, 'R1 shows up as a hop');
  const errs = net.events.filter((e) => e.from === 'R1' && e.to === 'ISP' && e.frame.payload?.payload?.type === 11);
  assert.ok(errs.length > 0, 'R1 sends time exceeded when the TTL runs out after translation');
  assert.ok(errs.every((e) => e.frame.payload.payload.orig.dst === '198.51.100.3'));
});

test('an ICMP error from a mapped inside host has its quoted destination translated too', () => {
  const { r1, t } = office();
  t.run(STATIC);
  const pkt = {
    src: '192.168.1.20', dst: '203.0.113.10', proto: 'ICMP', ttl: 64,
    payload: { type: 3, code: 3, orig: { src: '203.0.113.10', dst: '192.168.1.20', proto: 'UDP', ports: { src: 5000, dst: 69 } } },
  };
  assert.equal(r1.nat.translateOut(r1.getIface('GigabitEthernet0/0'), r1.getIface('GigabitEthernet0/1'), pkt), true);
  assert.equal(pkt.src, '198.51.100.3');
  assert.equal(pkt.payload.orig.dst, '198.51.100.3');
});
