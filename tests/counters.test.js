import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice, serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { ios, cmd } from './helpers.js';

/** Two PCs on S1 Fa0/1 and Fa0/2, R1 G0/0 on S1 G0/1 (192.168.1.0/24), Files on R1 G0/1 (192.168.99.0/24). */
function office() {
  const net = new Network();
  const r1 = createDevice(net, 'router', { name: 'R1' });
  const sw = createDevice(net, 'switch', { name: 'S1' });
  const a = createDevice(net, 'pc', { name: 'A' });
  const b = createDevice(net, 'pc', { name: 'B' });
  const files = createDevice(net, 'server', { name: 'Files' });
  net.connect(r1.getPort('GigabitEthernet0/0'), sw.getPort('GigabitEthernet0/1'));
  net.connect(a.getPort('FastEthernet0'), sw.getPort('FastEthernet0/1'));
  net.connect(b.getPort('FastEthernet0'), sw.getPort('FastEthernet0/2'));
  net.connect(files.getPort('FastEthernet0'), r1.getPort('GigabitEthernet0/1'));
  ios(r1).run(`en
    conf t
    int g0/0
    ip add 192.168.1.1 255.255.255.0
    no shut
    int g0/1
    ip add 192.168.99.1 255.255.255.0
    no shut
    end`);
  a.setStatic({ ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
  b.setStatic({ ip: '192.168.1.20', mask: '255.255.255.0', gateway: '192.168.1.1' });
  files.setStatic({ ip: '192.168.99.10', mask: '255.255.255.0', gateway: '192.168.99.1' });
  net.settle(500);
  return { net, r1, sw, a, b, files };
}

const ping = (net, host, ip) => cmd(host).run(`ping ${ip}`, net);
const ok = (out) => /Received = [1-9]/.test(out);
const zero = (p) => Object.values(p.counters).every((v) => v === 0);
/** Reads one number from show interfaces output, e.g. num(out, 'packets input'). */
const num = (out, what) => Number(new RegExp(`(\\d+) ${what}`).exec(out)?.[1]);

test('ports count frames in and out, and broadcasts', () => {
  const { net, sw, a, b } = office();
  for (const d of [sw, a, b]) d.clearCounters();
  assert.ok(ok(ping(net, a, '192.168.1.20')));
  const pa = a.getPort('FastEthernet0');
  const s1 = sw.getPort('FastEthernet0/1');
  const s2 = sw.getPort('FastEthernet0/2');
  // ARP request + 4 echo requests leave A, ARP reply + 4 echo replies come back
  assert.equal(pa.counters.outPackets, 5);
  assert.equal(pa.counters.inPackets, 5);
  assert.equal(pa.counters.outBroadcasts, 1);
  // whatever leaves one end of a cable arrives at the other
  assert.equal(s1.counters.inPackets, pa.counters.outPackets);
  assert.equal(s1.counters.outPackets, pa.counters.inPackets);
  assert.equal(s1.counters.inBroadcasts, 1);
  // the ARP broadcast was flooded to B and to the router as well
  assert.equal(s2.counters.outBroadcasts, 1);
  assert.equal(sw.getPort('GigabitEthernet0/1').counters.outBroadcasts, 1);
  assert.equal(s1.counters.inDrops + s1.counters.outDrops, 0);
  // unconnected ports stay at zero
  assert.ok(zero(sw.getPort('FastEthernet0/5')));
});

test('show interfaces prints the counters for physical interfaces', () => {
  const { net, sw, a } = office();
  ping(net, a, '192.168.1.20');
  const t = ios(sw);
  t.run('en');
  const out = t.run('show interfaces fa0/1');
  const p = sw.getPort('FastEthernet0/1');
  assert.match(out, /Last clearing of "show interface" counters never/);
  assert.equal(num(out, 'packets input'), p.counters.inPackets);
  assert.equal(num(out, 'packets output'), p.counters.outPackets);
  assert.match(out, /\d+ packets input, 1 broadcasts, 0 input drops/);
  assert.match(out, /\d+ packets output, \d+ broadcasts, 0 output drops/);
  // the switch's management SVI has no counters of its own
  t.run('conf t\nint vlan 1\nip add 192.168.1.2 255.255.255.0\nno shut\nend');
  assert.doesNotMatch(t.run('show interfaces vlan1'), /packets input/);
});

test('router subinterfaces show no counters; the physical interface does', () => {
  const { r1 } = office();
  const t = ios(r1);
  t.run('en\nconf t\nint g0/2.10\nencapsulation dot1q 10\nip add 10.0.10.1 255.255.255.0\nend');
  assert.doesNotMatch(t.run('show interfaces g0/2.10'), /packets input/);
  assert.match(t.run('show interfaces g0/2'), /0 packets input, 0 broadcasts, 0 input drops/);
});

test('clear counters zeroes every port and records when', () => {
  const { net, sw, a } = office();
  ping(net, a, '192.168.1.20');
  const t = ios(sw);
  t.run('en');
  net.runFor(65000);
  const out = t.run('clear counters');
  assert.match(out, /Clear "show interface" counters on all interfaces \[confirm\]/);
  assert.ok(sw.ports.every(zero));
  net.runFor(5000);
  assert.match(t.run('show interfaces fa0/1'), /Last clearing of "show interface" counters 00:00:05/);
  // user mode can't clear
  const u = ios(sw);
  assert.match(u.run('clear counters'), /%/);
});

test('clear counters <if> clears one port only', () => {
  const { net, sw, a } = office();
  ping(net, a, '192.168.1.20');
  const t = ios(sw);
  t.run('en\nclear counters fa0/1');
  assert.ok(zero(sw.getPort('FastEthernet0/1')));
  assert.ok(!zero(sw.getPort('FastEthernet0/2')));
  assert.match(t.run('show interfaces fa0/2'), /counters never/);
  // on a router, a subinterface name clears its physical port
  const { net: n2, r1, a: a2 } = office();
  ping(n2, a2, '192.168.1.1');
  const r = ios(r1);
  r.run('en\nconf t\nint g0/0.5\nend');
  assert.ok(!zero(r1.getPort('GigabitEthernet0/0')));
  r.run('clear counters g0/0.5');
  assert.ok(zero(r1.getPort('GigabitEthernet0/0')));
  assert.match(r.run('clear counters g0/9'), /Invalid|%/);
});

test('reload starts the counters from zero again', () => {
  const { net, sw, a } = office();
  ping(net, a, '192.168.1.20');
  const t = ios(sw);
  t.run('en\nclear counters');
  ping(net, a, '192.168.1.20');
  t.run('reload');
  assert.ok(sw.ports.every((p) => p.countersClearedAt === null));
  assert.ok(sw.getPort('FastEthernet0/3').counters.inPackets === 0);
});

test('an inbound access list deny counts as an input drop on that interface', () => {
  const { net, r1, a, b } = office();
  const t = ios(r1);
  t.run(`en
    conf t
    access-list 10 deny host 192.168.1.20
    access-list 10 permit any
    int g0/0
    ip access-group 10 in
    end
    clear counters`);
  assert.ok(ok(ping(net, a, '192.168.99.10')));
  assert.equal(r1.getPort('GigabitEthernet0/0').counters.inDrops, 0);
  assert.ok(!ok(ping(net, b, '192.168.99.10')));
  const g0 = r1.getPort('GigabitEthernet0/0');
  assert.equal(g0.counters.inDrops, 4);
  assert.match(t.run('show interfaces g0/0'), / 4 input drops/);
  assert.equal(r1.getPort('GigabitEthernet0/1').counters.outDrops, 0);
});

test('an outbound access list deny counts as an output drop', () => {
  const { net, r1, b } = office();
  const t = ios(r1);
  t.run(`en
    conf t
    access-list 10 deny host 192.168.1.20
    access-list 10 permit any
    int g0/1
    ip access-group 10 out
    end
    clear counters`);
  assert.ok(!ok(ping(net, b, '192.168.99.10')));
  assert.equal(r1.getPort('GigabitEthernet0/1').counters.outDrops, 4);
  assert.equal(r1.getPort('GigabitEthernet0/0').counters.inDrops, 0);
  assert.match(t.run('show interfaces g0/1'), / 4 output drops/);
});

test('the packet inspector says when a denied packet becomes a drop', () => {
  const { net, r1, b } = office();
  ios(r1).run('en\nconf t\naccess-list 10 deny any\nint g0/0\nip access-group 10 in\nend');
  net.recording = true;
  ping(net, b, '192.168.99.10');
  const notes = net.events.flatMap((e) => e.notes);
  assert.ok(notes.some((n) => /counts as an input drop on GigabitEthernet0\/0/.test(n)), notes.join('\n'));
});

test('a port security violation and a tagged frame on an access port count as input drops', () => {
  const { net, sw, a } = office();
  const t = ios(sw);
  t.run(`en
    conf t
    int fa0/1
    switchport mode access
    switchport port-security
    switchport port-security mac-address sticky
    switchport port-security violation restrict
    end`);
  assert.ok(ok(ping(net, a, '192.168.1.20')));
  const rogue = createDevice(net, 'laptop', { name: 'Rogue' });
  rogue.setStatic({ ip: '192.168.1.66', mask: '255.255.255.0' });
  const p = sw.getPort('FastEthernet0/1');
  net.disconnect(p.link.id);
  net.connect(rogue.getPort('FastEthernet0'), p);
  t.run('clear counters fa0/1');
  ping(net, rogue, '192.168.1.20');
  assert.ok(p.counters.inDrops > 0);
  assert.equal(p.counters.inDrops, p.counters.inPackets);
  // a tagged frame on an access port is discarded too
  const before = p.counters.inDrops;
  net.transmit(rogue.getPort('FastEthernet0'), { src: '0000.0000.0001', dst: 'FFFF.FFFF.FFFF', type: 'ARP', vlan: 20, payload: {} });
  net.settle(100);
  assert.equal(p.counters.inDrops, before + 1);
});

test('a port blocked by spanning tree counts the frames it discards', () => {
  const net = new Network();
  const s1 = createDevice(net, 'switch', { name: 'S1' });
  const s2 = createDevice(net, 'switch', { name: 'S2' });
  const pc = createDevice(net, 'pc', { name: 'PC' });
  net.connect(s1.getPort('GigabitEthernet0/1'), s2.getPort('GigabitEthernet0/1'));
  net.connect(s1.getPort('GigabitEthernet0/2'), s2.getPort('GigabitEthernet0/2'));
  net.connect(pc.getPort('FastEthernet0'), s1.getPort('FastEthernet0/1'));
  pc.setStatic({ ip: '10.0.0.1', mask: '255.255.255.0' });
  net.settle(500);
  const blocked = [s1, s2].flatMap((s) => s.ports.filter((p) => p.isUp() && !s.stp.forwarding(p)));
  assert.equal(blocked.length, 1);
  ping(net, pc, '10.0.0.2'); // nobody answers, so the ARP broadcasts are flooded everywhere
  assert.ok(blocked[0].counters.inDrops > 0);
  // the blocked port neither forwards nor sends anything
  assert.equal(blocked[0].counters.outPackets, 0);
});

test('a hub counts what it repeats', () => {
  const net = new Network();
  const hub = createDevice(net, 'hub', { name: 'H' });
  const a = createDevice(net, 'pc', { name: 'A' });
  const b = createDevice(net, 'pc', { name: 'B' });
  net.connect(a.getPort('FastEthernet0'), hub.getPort('Port0'));
  net.connect(b.getPort('FastEthernet0'), hub.getPort('Port1'));
  a.setStatic({ ip: '10.0.0.1', mask: '255.255.255.0' });
  b.setStatic({ ip: '10.0.0.2', mask: '255.255.255.0' });
  net.settle(500);
  assert.ok(ok(ping(net, a, '10.0.0.2')));
  const p0 = hub.getPort('Port0');
  const p1 = hub.getPort('Port1');
  assert.equal(p0.counters.inPackets, p1.counters.outPackets);
  assert.equal(p1.counters.inPackets, p0.counters.outPackets);
});

test('counters are not saved, and older files load with zero counters', () => {
  const { net, sw, a } = office();
  ping(net, a, '192.168.1.20');
  const json = JSON.stringify(serializeNetwork(net));
  assert.doesNotMatch(json, /inPackets|counters/);
  const loaded = loadNetwork(JSON.parse(json));
  const s = loaded.findDevice('S1');
  assert.ok(s.ports.every((p) => p.counters.inDrops === 0 && p.countersClearedAt === null));
  assert.match(ios(s).run('show interfaces fa0/1'), /counters never/);
});
