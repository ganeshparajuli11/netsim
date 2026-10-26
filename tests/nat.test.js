import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { LABS } from '../src/ui/labs.js';
import { ios, cmd } from './helpers.js';

/** The "Share one public address" lab: PC1/PC2 on 192.168.1.0/24 behind R1, Web behind ISP. */
function office() {
  const net = new Network();
  LABS.find((l) => l.id === 'nat-overload').build(net);
  net.settle(200);
  const r1 = net.findDevice('R1');
  return { net, r1, t: ios(r1) };
}

const PAT = `en
  conf t
  access-list 1 permit 192.168.1.0 0.0.0.255
  interface g0/0
  ip nat inside
  interface g0/1
  ip nat outside
  exit
  ip nat inside source list 1 interface g0/1 overload
  end`;

const pingTwice = (net, from, ip) => {
  const pc = net.findDevice(from);
  cmd(pc).run(`ping ${ip}`, net); // the first echo may be lost to ARP on the routers
  return cmd(pc).run(`ping ${ip}`, net);
};

/** Frames seen on the cable from R1 to ISP. */
const upstream = (net) => net.events.filter((e) => e.from === 'R1' && e.to === 'ISP' && e.frame.type === 'IPv4');

test('without NAT the private LAN cannot reach the internet', () => {
  const { net } = office();
  assert.doesNotMatch(pingTwice(net, 'PC1', '203.0.113.10'), /Reply from/);
});

test('NAT overload translates pings to the outside interface address', () => {
  const { net, r1, t } = office();
  t.run(PAT);
  net.recording = true;
  assert.match(pingTwice(net, 'PC1', '203.0.113.10'), /Reply from 203\.0\.113\.10/);
  const up = upstream(net);
  assert.ok(up.length > 0);
  assert.ok(up.every((e) => e.frame.payload.src === '198.51.100.2'), 'every packet leaves R1 with the public address');
  assert.ok(net.events.some((e) => e.to === 'R1' && e.notes.some((n) => /NAT: 192\.168\.1\.10 is permitted by access list 1; new translation/.test(n))));
  // replies come back to PC1's private address
  const down = net.events.filter((e) => e.from === 'R1' && e.to === 'S1' && e.frame.payload?.payload?.type === 0);
  assert.ok(down.length > 0 && down.every((e) => e.frame.payload.dst === '192.168.1.10'));
  const o = t.run('show ip nat translations');
  assert.match(o, /Pro\s+Inside global\s+Inside local\s+Outside local\s+Outside global/);
  assert.match(o, /icmp 198\.51\.100\.2:\d+\s+192\.168\.1\.10:\d+\s+203\.0\.113\.10:\d+\s+203\.0\.113\.10:\d+/);
  assert.ok(r1.nat.misses > 0 && r1.nat.hits > 0);
});

test('two hosts using the same ICMP identifier get different global identifiers', () => {
  const { net, r1, t } = office();
  t.run(PAT);
  net.findDevice('PC1').icmpId = 77;
  net.findDevice('PC2').icmpId = 77;
  net.recording = true;
  const pc1 = cmd(net.findDevice('PC1'));
  const pc2 = cmd(net.findDevice('PC2'));
  pc1.cli.exec('ping 203.0.113.10');
  pc2.cli.exec('ping 203.0.113.10');
  net.settle(20000);
  assert.match(pc1.run('ping 203.0.113.10', net), /Reply from/);
  const tr = r1.nat.translations();
  const one = tr.find((e) => e.insideLocal === '192.168.1.10' && e.localPort === 77);
  const two = tr.find((e) => e.insideLocal === '192.168.1.11' && e.localPort === 77);
  assert.ok(one && two, 'both hosts have a translation for identifier 77');
  assert.notEqual(one.globalPort, two.globalPort);
  // both hosts still get their replies
  assert.match(pc2.run('ping 203.0.113.10', net), /Reply from 203\.0\.113\.10/);
  assert.match(pc1.run('ping 203.0.113.10', net), /Reply from 203\.0\.113\.10/);
  assert.ok(net.events.some((e) => e.notes.some((n) => /ICMP identifier 77 is already taken on 198\.51\.100\.2/.test(n))));
});

test('both PCs replies reach the right host', () => {
  const { net, t } = office();
  t.run(PAT);
  assert.match(pingTwice(net, 'PC1', '203.0.113.10'), /Reply from 203\.0\.113\.10/);
  assert.match(pingTwice(net, 'PC2', '203.0.113.10'), /Reply from 203\.0\.113\.10/);
  const o = t.run('show ip nat translations');
  assert.match(o, /192\.168\.1\.10/);
  assert.match(o, /192\.168\.1\.11/);
});

test('TCP (web browsing) goes through PAT and the server only sees the public address', () => {
  const { net, r1, t } = office();
  t.run(PAT);
  const web = net.findDevice('Web');
  const seen = [];
  const orig = web.onTcp.bind(web);
  web.onTcp = (i, pkt) => { seen.push(pkt.src); return orig(i, pkt); };
  const pc = net.findDevice('PC1');
  let res = null;
  // the first requests may be lost while R1 and ISP resolve ARP
  for (let k = 0; k < 3 && res?.status !== 200; k++) {
    res = null;
    pc.httpGet('http://203.0.113.10/', (r) => { res = r; });
    net.settle(10000);
  }
  assert.equal(res?.status, 200);
  assert.ok(seen.length > 0 && seen.every((s) => s === '198.51.100.2'));
  assert.ok(r1.nat.translations().some((e) => e.proto === 'tcp' && e.outsidePort === 80 && e.insideLocal === '192.168.1.10'));
  assert.match(t.run('show ip nat translations'), /tcp\s+198\.51\.100\.2:\d+\s+192\.168\.1\.10:\d+\s+203\.0\.113\.10:80/);
});

test('hosts the access list does not permit are not translated', () => {
  const { net, r1, t } = office();
  t.run(PAT.replace('access-list 1 permit 192.168.1.0 0.0.0.255', 'access-list 1 permit host 192.168.1.10'));
  net.recording = true;
  assert.match(pingTwice(net, 'PC1', '203.0.113.10'), /Reply from/);
  assert.doesNotMatch(pingTwice(net, 'PC2', '203.0.113.10'), /Reply from/);
  assert.ok(!r1.nat.translations().some((e) => e.insideLocal === '192.168.1.11'));
  assert.ok(net.events.some((e) => e.notes.some((n) => /source 192\.168\.1\.11 is not permitted by access list 1/.test(n))));
});

test('traceroute works through NAT (ICMP errors are translated back)', () => {
  const { net, t } = office();
  t.run(PAT);
  pingTwice(net, 'PC1', '203.0.113.10');
  const o = cmd(net.findDevice('PC1')).run('tracert 203.0.113.10', net);
  assert.match(o, /198\.51\.100\.1/, 'the provider router shows up as a hop');
  assert.match(o, /203\.0\.113\.10/);
  assert.match(o, /Trace complete/);
});

test('translations time out and can be cleared', () => {
  const { net, r1, t } = office();
  t.run(PAT);
  pingTwice(net, 'PC1', '203.0.113.10');
  assert.ok(r1.nat.translations().length > 0);
  net.schedule(61000, () => {});
  net.settle(62000);
  assert.equal(r1.nat.translations().length, 0, 'ICMP translations expire after 60 s idle');
  pingTwice(net, 'PC1', '203.0.113.10');
  assert.ok(r1.nat.translations().length > 0);
  t.run('clear ip nat translation *');
  assert.equal(r1.nat.translations().length, 0);
});

test('unsolicited traffic from outside reaches the router itself, not an inside host', () => {
  const { net, t } = office();
  t.run(PAT);
  pingTwice(net, 'PC1', '203.0.113.10');
  // the outside host even uses the identifier of PC1's translation
  net.findDevice('Web').icmpId = net.findDevice('R1').nat.translations()[0].globalPort;
  net.recording = true;
  assert.match(pingTwice(net, 'Web', '198.51.100.2'), /Reply from 198\.51\.100\.2/);
  assert.ok(!net.events.some((e) => e.from === 'R1' && e.to === 'S1'), 'nothing is passed to the inside LAN');
});

test('running-config, statistics and removing the rule', () => {
  const { net, r1, t } = office();
  t.run(PAT);
  pingTwice(net, 'PC1', '203.0.113.10');
  const rc = t.run('show running-config');
  assert.match(rc, /interface GigabitEthernet0\/0\n(?: .*\n)* ip nat inside\n/);
  assert.match(rc, /interface GigabitEthernet0\/1\n(?: .*\n)* ip nat outside\n/);
  assert.match(rc, /ip nat inside source list 1 interface GigabitEthernet0\/1 overload/);
  const st = t.run('show ip nat statistics');
  assert.match(st, /Total active translations: [1-9]/);
  assert.match(st, /Outside interfaces:\n  GigabitEthernet0\/1/);
  assert.match(st, /Inside interfaces:\n  GigabitEthernet0\/0/);
  assert.match(st, /access-list 1 interface GigabitEthernet0\/1 refcount [1-9]/);
  t.run('conf t\nno ip nat inside source list 1 interface g0/1 overload\nend');
  assert.equal(r1.nat.rules.length, 0);
  assert.doesNotMatch(t.run('show running-config'), /ip nat inside source/);
  t.run('conf t\nint g0/0\nno ip nat inside\nend');
  assert.equal(r1.getIface('GigabitEthernet0/0').nat, undefined);
});

test('NAT settings survive save and load, and older files without them still open', () => {
  const { net, t } = office();
  t.run(PAT);
  const saved = serializeNetwork(net);
  const copy = loadNetwork(JSON.parse(JSON.stringify(saved)), new Network());
  const r = copy.findDevice('R1');
  assert.equal(r.getIface('GigabitEthernet0/0').nat, 'inside');
  assert.equal(r.getIface('GigabitEthernet0/1').nat, 'outside');
  assert.deepEqual(r.nat.rules, [{ acl: 1, iface: 'GigabitEthernet0/1', overload: true }]);
  assert.match(pingTwice(copy, 'PC2', '203.0.113.10'), /Reply from/);

  // a file saved before NAT existed
  const old = JSON.parse(JSON.stringify(saved));
  for (const d of old.devices) {
    if (!d.config) continue;
    delete d.config.nat;
    for (const i of d.config.ifaces || []) delete i.nat;
  }
  const oldNet = loadNetwork(old, new Network());
  const r2 = oldNet.findDevice('R1');
  assert.equal(r2.nat.rules.length, 0);
  assert.equal(r2.getIface('GigabitEthernet0/0').nat, undefined);
});

test('NAT commands are refused on switches', () => {
  const net = new Network();
  LABS.find((l) => l.id === 'nat-overload').build(net);
  const s = ios(net.findDevice('S1'));
  assert.match(s.run('en\nconf t\nip nat inside source list 1 interface vlan1 overload'), /Invalid input/);
});

test('several rules on one interface: the first access list that permits the source is used', () => {
  const { net, r1, t } = office();
  t.run(`en
    conf t
    access-list 1 permit host 192.168.1.10
    access-list 2 permit host 192.168.1.11
    interface g0/0
    ip nat inside
    interface g0/1
    ip nat outside
    exit
    ip nat inside source list 1 interface g0/1 overload
    ip nat inside source list 2 interface g0/1 overload
    end`);
  assert.match(pingTwice(net, 'PC1', '203.0.113.10'), /Reply from/);
  assert.match(pingTwice(net, 'PC2', '203.0.113.10'), /Reply from/);
  assert.ok(r1.nat.translations().some((e) => e.insideLocal === '192.168.1.11'));
});

test('ICMP errors about translated TCP traffic reach the inside host', () => {
  const { net, t } = office();
  t.run(PAT);
  pingTwice(net, 'PC1', '203.0.113.10'); // warm up ARP
  net.recording = true;
  const pc = net.findDevice('PC1');
  pc.httpGet('http://192.0.2.99/', () => {}); // the provider has no route to 192.0.2.0/24
  net.settle(5000);
  const back = net.events.find((e) => e.from === 'R1' && e.to === 'S1' && e.frame.payload?.proto === 'ICMP' && e.frame.payload.payload.type === 3);
  assert.ok(back, 'the unreachable message is passed to the LAN');
  assert.equal(back.frame.payload.dst, '192.168.1.10');
  assert.equal(back.frame.payload.payload.orig.src, '192.168.1.10');
});

test('an outbound ACL drop after NAT reports to the inside host and keeps no translation', () => {
  const { net, r1, t } = office();
  t.run(PAT);
  t.run(`conf t
    access-list 101 deny icmp any host 203.0.113.10
    access-list 101 permit ip any any
    interface g0/1
    ip access-group 101 out
    end`);
  net.recording = true;
  const o = pingTwice(net, 'PC1', '203.0.113.10');
  assert.doesNotMatch(o, /Reply from 203/);
  assert.match(o, /Reply from 192\.168\.1\.1: Destination host unreachable/);
  assert.ok(!r1.nat.translations().some((e) => e.proto === 'icmp'), 'denied flows leave no translation');
});

test('"no ip nat" on a switch port is refused, not a crash', () => {
  const net = new Network();
  LABS.find((l) => l.id === 'nat-overload').build(net);
  const s = ios(net.findDevice('S1'));
  assert.match(s.run('en\nconf t\ninterface fa0/1\nno ip nat inside'), /Invalid input/);
});
