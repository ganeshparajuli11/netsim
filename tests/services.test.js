import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice, serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { ios, cmd } from './helpers.js';

test('DHCP relay with ip helper-address to a server on another subnet', () => {
  const net = new Network();
  const r = createDevice(net, 'router', { name: 'R1' });
  const srv = createDevice(net, 'server', { name: 'DHCP' });
  const pc = createDevice(net, 'pc', { name: 'PC' });
  net.connect(srv.getPort('FastEthernet0'), r.getPort('GigabitEthernet0/1'));
  net.connect(pc.getPort('FastEthernet0'), r.getPort('GigabitEthernet0/0'));
  ios(r).run(`en
    conf t
    int g0/0
    ip add 192.168.50.1 255.255.255.0
    ip helper-address 10.9.9.10
    no shut
    int g0/1
    ip add 10.9.9.1 255.255.255.0
    no shut
    end`);
  srv.setStatic({ ip: '10.9.9.10', mask: '255.255.255.0', gateway: '10.9.9.1' });
  srv.dhcpServer.enabled = true;
  srv.dhcpServer.pools.push({ name: 'remote', network: '192.168.50.0', mask: '255.255.255.0', defaultRouter: '192.168.50.1', dns: '10.9.9.10', startIp: '192.168.50.100', maxUsers: 20 });
  pc.setDhcp();
  net.settle(20000);
  assert.equal(pc.nic.ip, '192.168.50.100');
  assert.equal(pc.defaultGateway, '192.168.50.1');
});

test('save and load keeps configuration and connectivity', () => {
  const net = new Network();
  const r = createDevice(net, 'router', { name: 'R1' });
  const a = createDevice(net, 'pc', { name: 'A' });
  net.connect(a.getPort('FastEthernet0'), r.getPort('GigabitEthernet0/0'));
  ios(r).run('en\nconf t\nint g0/0\nip add 10.0.0.1 255.255.255.0\nno shut\nend');
  a.setStatic({ ip: '10.0.0.2', mask: '255.255.255.0', gateway: '10.0.0.1' });
  const copy = loadNetwork(JSON.parse(JSON.stringify(serializeNetwork(net))), new Network());
  const o = cmd(copy.findDevice('A')).run('ping 10.0.0.1', copy);
  assert.match(o, /Received = 4/);
});

test('copy run start, erase and reload', () => {
  const net = new Network();
  const r = createDevice(net, 'router', { name: 'R1' });
  const t = ios(r);
  t.run('en\nconf t\nhostname Core\nint g0/0\nip add 10.0.0.1 255.255.255.0\nend\ncopy running-config startup-config');
  t.run('conf t\nhostname Changed\nend\nreload');
  t.run('en');
  assert.equal(t.cli.prompt(), 'Core#');
  t.run('erase startup-config\nreload');
  t.run('en');
  assert.equal(t.cli.prompt(), 'Router#');
  assert.match(t.run('show ip int brief'), /GigabitEthernet0\/0\s+unassigned/);
});

test('switch SVI management and ping from switch', () => {
  const net = new Network();
  const s = createDevice(net, 'switch', { name: 'S1' });
  const a = createDevice(net, 'pc', { name: 'A' });
  net.connect(a.getPort('FastEthernet0'), s.getPort('FastEthernet0/3'));
  a.setStatic({ ip: '10.0.0.2', mask: '255.255.255.0' });
  const t = ios(s);
  t.run('en\nconf t\ninterface vlan 1\nip address 10.0.0.250 255.255.255.0\nno shutdown\nend');
  assert.match(cmd(a).run('ping 10.0.0.250', net), /Received = 4/);
  t.run('ping 10.0.0.2');
  net.settle(20000);
  assert.match(t.out, /Success rate is 100 percent/);
});
