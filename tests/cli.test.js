import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice } from '../src/engine/factory.js';
import { ios, cmd } from './helpers.js';

test('IOS modes, abbreviations and errors', () => {
  const net = new Network();
  const r = createDevice(net, 'router', { name: 'R1' });
  const t = ios(r);
  t.run('en\nconf t\nhostname Edge');
  assert.equal(t.cli.prompt(), 'Edge(config)#');
  let o = t.run('int g0/0\nip add 10.0.0.1 255.255.255.0\nno shut\nend');
  assert.equal(t.cli.prompt(), 'Edge#');
  o = t.run('sh ip int br');
  assert.match(o, /GigabitEthernet0\/0\s+10\.0\.0\.1\s+YES manual down/);
  o = t.run('shw ip route');
  assert.match(o, /Invalid input/);
  o = t.run('s');
  assert.match(o, /Ambiguous|Invalid|Incomplete/);
  o = t.run('show');
  assert.match(o, /Incomplete/);
  o = t.run('show ?');
  assert.match(o, /running-config/);
  t.run('conf t\nenable secret cisco\nend\ndisable');
  t.run('enable');
  assert.equal(t.cli.prompt(), '');
  t.run('cisco');
  assert.equal(t.cli.prompt(), 'Edge#');
  o = t.run('show run');
  assert.match(o, /hostname Edge/);
  assert.match(o, /ip address 10\.0\.0\.1 255\.255\.255\.0/);
  assert.equal(t.cli.complete('conf'), 'configure ');
});

test('router-on-a-stick with VLANs, trunk and DHCP via CLI', () => {
  const net = new Network();
  const r = createDevice(net, 'router', { name: 'R1' });
  const s = createDevice(net, 'switch', { name: 'S1' });
  const p1 = createDevice(net, 'pc', { name: 'PC1' });
  const p2 = createDevice(net, 'pc', { name: 'PC2' });
  net.connect(r.getPort('GigabitEthernet0/0'), s.getPort('GigabitEthernet0/1'));
  net.connect(p1.getPort('FastEthernet0'), s.getPort('FastEthernet0/1'));
  net.connect(p2.getPort('FastEthernet0'), s.getPort('FastEthernet0/2'));
  const sw = ios(s);
  sw.run(`enable
    configure terminal
    vlan 10
    name SALES
    vlan 20
    name ENG
    exit
    interface fa0/1
    switchport mode access
    switchport access vlan 10
    interface f0/2
    switchport access vlan 20
    int g0/1
    switchport mode trunk
    end`);
  const rt = ios(r);
  rt.run(`en
    conf t
    int g0/0
    no shut
    int g0/0.10
    encapsulation dot1Q 10
    ip address 192.168.10.1 255.255.255.0
    int g0/0.20
    encap dot1q 20
    ip add 192.168.20.1 255.255.255.0
    exit
    ip dhcp excluded-address 192.168.10.1 192.168.10.9
    ip dhcp pool V10
    network 192.168.10.0 255.255.255.0
    default-router 192.168.10.1
    ip dhcp pool V20
    network 192.168.20.0 255.255.255.0
    default-router 192.168.20.1
    end`);
  p1.setDhcp();
  p2.setDhcp();
  net.settle(20000);
  assert.equal(p1.nic.ip, '192.168.10.10');
  assert.equal(p2.nic.ip, '192.168.20.2');
  const c = cmd(p1);
  const o = c.run('ping 192.168.20.2', net);
  assert.match(o, /Received = [34]/, o);
  const vb = sw.run('show vlan brief');
  assert.match(vb, /10\s+SALES\s+active\s+Fa0\/1/);
  const tr = sw.run('show interfaces trunk');
  assert.match(tr, /Gi0\/1\s+on\s+802\.1q/);
  assert.match(rt.run('show ip dhcp binding'), /192\.168\.10\.10/);
  assert.match(rt.run('show ip route'), /C\s+192\.168\.10\.0\/24 is directly connected, GigabitEthernet0\/0\.10/);
});

test('RIP between three routers and an ACL', () => {
  const net = new Network();
  const [r1, r2, r3] = ['R1', 'R2', 'R3'].map((n) => createDevice(net, 'router', { name: n }));
  const a = createDevice(net, 'pc', { name: 'A' });
  const b = createDevice(net, 'pc', { name: 'B' });
  net.connect(r1.getPort('GigabitEthernet0/1'), r2.getPort('GigabitEthernet0/0'));
  net.connect(r2.getPort('GigabitEthernet0/1'), r3.getPort('GigabitEthernet0/0'));
  net.connect(a.getPort('FastEthernet0'), r1.getPort('GigabitEthernet0/0'));
  net.connect(b.getPort('FastEthernet0'), r3.getPort('GigabitEthernet0/1'));
  ios(r1).run(`en
    conf t
    int g0/0
    ip add 10.1.0.1 255.255.255.0
    no shut
    int g0/1
    ip add 10.12.0.1 255.255.255.252
    no shut
    router rip
    version 2
    no auto-summary
    network 10.0.0.0
    end`);
  ios(r2).run(`en
    conf t
    int g0/0
    ip add 10.12.0.2 255.255.255.252
    no shut
    int g0/1
    ip add 10.23.0.1 255.255.255.252
    no shut
    router rip
    version 2
    network 10.0.0.0
    end`);
  ios(r3).run(`en
    conf t
    int g0/0
    ip add 10.23.0.2 255.255.255.252
    no shut
    int g0/1
    ip add 10.3.0.1 255.255.255.0
    no shut
    router rip
    version 2
    network 10.0.0.0
    end`);
  a.setStatic({ ip: '10.1.0.10', mask: '255.255.255.0', gateway: '10.1.0.1' });
  b.setStatic({ ip: '10.3.0.10', mask: '255.255.255.0', gateway: '10.3.0.1' });
  net.runFor(2000);
  const route = ios(r1);
  route.run('en');
  const rtab = route.run('show ip route');
  assert.match(rtab, /R\s+10\.3\.0\.0\/24 \[120\/2\] via 10\.12\.0\.2/, rtab);
  const c = cmd(a);
  // the first echoes are lost while each router ARPs for its next hop (as on real routers)
  let o = c.run('ping 10.3.0.10', net);
  assert.match(o, /Received = [1234]/, o);
  o = c.run('ping 10.3.0.10', net);
  assert.match(o, /Received = 4/, o);
  o = c.run('tracert 10.3.0.10', net);
  assert.match(o, /10\.12\.0\.2/);
  // block A at R3 with a standard ACL outbound towards B
  ios(r3).run(`en
    conf t
    access-list 10 deny host 10.1.0.10
    access-list 10 permit any
    int g0/1
    ip access-group 10 out
    end`);
  o = c.run('ping 10.3.0.10', net);
  assert.match(o, /Destination host unreachable/, o);
  const acl = ios(r3);
  acl.run('en');
  assert.match(acl.run('show access-lists'), /deny 10\.1\.0\.10 \(\d+ match/);
});

test('spanning tree blocks one port in a triangle and traffic still flows', () => {
  const net = new Network();
  const [s1, s2, s3] = ['S1', 'S2', 'S3'].map((n) => createDevice(net, 'switch', { name: n }));
  net.connect(s1.getPort('GigabitEthernet0/1'), s2.getPort('GigabitEthernet0/1'));
  net.connect(s2.getPort('GigabitEthernet0/2'), s3.getPort('GigabitEthernet0/1'));
  net.connect(s3.getPort('GigabitEthernet0/2'), s1.getPort('GigabitEthernet0/2'));
  const a = createDevice(net, 'pc');
  const b = createDevice(net, 'pc');
  net.connect(a.getPort('FastEthernet0'), s1.getPort('FastEthernet0/1'));
  net.connect(b.getPort('FastEthernet0'), s3.getPort('FastEthernet0/1'));
  a.setStatic({ ip: '10.0.0.1', mask: '255.0.0.0' });
  b.setStatic({ ip: '10.0.0.2', mask: '255.0.0.0' });
  const blocked = [s1, s2, s3].flatMap((s) => s.ports.filter((p) => p.isUp() && !s.stp.forwarding(p)));
  assert.equal(blocked.length, 1);
  const o = cmd(a).run('ping 10.0.0.2', net);
  assert.match(o, /Received = 4/);
  const t = ios(s1); t.run('en');
  assert.match(t.run('show spanning-tree'), /Root ID/);
});

test('DNS and HTTP from a server', () => {
  const net = new Network();
  const s = createDevice(net, 'switch');
  const pc = createDevice(net, 'pc');
  const srv = createDevice(net, 'server');
  net.connect(pc.getPort('FastEthernet0'), s.getPort('FastEthernet0/1'));
  net.connect(srv.getPort('FastEthernet0'), s.getPort('FastEthernet0/2'));
  srv.setStatic({ ip: '10.0.0.100', mask: '255.255.255.0' });
  srv.dns.enabled = true;
  srv.dns.records.push({ name: 'www.lab.local', ip: '10.0.0.100' });
  pc.setStatic({ ip: '10.0.0.1', mask: '255.255.255.0', dns: '10.0.0.100' });
  const o = cmd(pc).run('ping www.lab.local', net);
  assert.match(o, /Pinging 10\.0\.0\.100/);
  let page = null;
  pc.httpGet('http://www.lab.local/', (r) => (page = r));
  net.settle(10000);
  assert.equal(page.status, 200);
});
