import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { LABS } from '../src/ui/labs.js';
import { ios } from './helpers.js';

const SOLUTIONS = {
  'first-lan': (n) => {
    n.findDevice('PC0').setStatic({ ip: '192.168.1.10', mask: '255.255.255.0' });
    n.findDevice('PC1').setStatic({ ip: '192.168.1.11', mask: '255.255.255.0' });
  },
  'router-basics': (n) => {
    ios(n.findDevice('R1')).run(`en
      conf t
      int g0/0
      ip add 10.1.1.1 255.255.255.0
      no shut
      int g0/1
      ip add 10.2.2.1 255.255.255.0
      no shut
      end`);
    n.findDevice('PC-A').defaultGateway = '10.1.1.1';
    n.findDevice('PC-B').defaultGateway = '10.2.2.1';
  },
  dhcp: (n) => ios(n.findDevice('R1')).run(`en
      conf t
      int g0/0
      ip add 192.168.10.1 255.255.255.0
      no shut
      exit
      ip dhcp excluded-address 192.168.10.1 192.168.10.9
      ip dhcp pool LAN
      network 192.168.10.0 255.255.255.0
      default-router 192.168.10.1
      end`),
  vlans: (n) => {
    ios(n.findDevice('S1')).run(`en
      conf t
      vlan 10
      name SALES
      vlan 20
      name ENG
      interface range fa0/1 - 2
      switchport mode access
      switchport access vlan 10
      interface range fa0/11 - 12
      switchport mode access
      switchport access vlan 20
      interface g0/1
      switchport mode trunk
      end`);
    ios(n.findDevice('R1')).run(`en
      conf t
      interface g0/0
      no shutdown
      interface g0/0.10
      encapsulation dot1Q 10
      ip address 192.168.10.1 255.255.255.0
      interface g0/0.20
      encapsulation dot1Q 20
      ip address 192.168.20.1 255.255.255.0
      end`);
  },
  static: (n) => {
    ios(n.findDevice('R1')).run('en\nconf t\nip route 172.16.2.0 255.255.255.0 10.0.0.2\nend');
    ios(n.findDevice('R2')).run('en\nconf t\nip route 172.16.1.0 255.255.255.0 10.0.0.1\nend');
  },
  'default-routes': (n) => ios(n.findDevice('R1')).run(`en
      conf t
      ip route 0.0.0.0 0.0.0.0 10.0.0.2
      ip route 0.0.0.0 0.0.0.0 10.0.1.2 10
      end`),
  rip: (n) => {
    for (const r of ['R1', 'R2', 'R3']) ios(n.findDevice(r)).run('en\nconf t\nrouter rip\nversion 2\nno auto-summary\nnetwork 10.0.0.0\nend');
  },
  ospf: (n) => {
    for (const r of ['R1', 'R2', 'R3', 'R4']) ios(n.findDevice(r)).run('en\nconf t\nrouter ospf 1\nnetwork 10.0.0.0 0.255.255.255 area 0\nend');
  },
  acl: (n) => ios(n.findDevice('R1')).run(`en
      conf t
      access-list 10 deny host 192.168.1.50
      access-list 10 permit any
      interface g0/1
      ip access-group 10 out
      end`),
  'nat-overload': (n) => ios(n.findDevice('R1')).run(`en
      conf t
      access-list 1 permit 192.168.1.0 0.0.0.255
      interface g0/0
      ip nat inside
      interface g0/1
      ip nat outside
      exit
      ip nat inside source list 1 interface g0/1 overload
      end`),
  'nat-static': (n) => ios(n.findDevice('R1')).run(`en
      conf t
      interface g0/0
      ip nat inside
      interface g0/1
      ip nat outside
      exit
      ip nat inside source static 192.168.1.20 198.51.100.3
      end`),
  stp: (n) => ios(n.findDevice('S1')).run('en\nconf t\nspanning-tree vlan 1 priority 4096\nend'),
};

for (const lab of LABS) {
  test(`lab "${lab.title}" starts unsolved and can be solved`, () => {
    const net = new Network();
    lab.build(net);
    net.settle(200);
    const before = lab.checks.map((c) => !!c.fn(net));
    assert.ok(before.some((x) => !x), `lab ${lab.id} is already solved`);
    assert.ok(SOLUTIONS[lab.id], `no solution for ${lab.id}`);
    SOLUTIONS[lab.id](net);
    net.settle(5000);
    const after = lab.checks.map((c) => !!c.fn(net));
    assert.deepEqual(after, lab.checks.map(() => true), `${lab.id}: ${lab.checks.map((c, i) => `${after[i] ? 'ok' : 'FAIL'} ${c.text}`).join('; ')}`);
  });
}
