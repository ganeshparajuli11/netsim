import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice, serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { wildcardMatch } from '../src/engine/ospf.js';
import { ios } from './helpers.js';

/** n routers on one switch, Rk at 10.0.0.k/24 on g0/0. */
function lan(n) {
  const net = new Network();
  const sw = createDevice(net, 'switch', { name: 'S1' });
  const routers = [];
  for (let k = 1; k <= n; k++) {
    const r = createDevice(net, 'router', { name: `R${k}` });
    net.connect(r.getPort('GigabitEthernet0/0'), sw.ports[k - 1]);
    ios(r).run(`en\nconf t\nint g0/0\nip address 10.0.0.${k} 255.255.255.0\nno shut\nend`);
    routers.push(r);
  }
  net.settle(100);
  return { net, routers };
}

/** Two routers joined by one cable. */
function pair() {
  const net = new Network();
  const r1 = createDevice(net, 'router', { name: 'R1' });
  const r2 = createDevice(net, 'router', { name: 'R2' });
  net.connect(r1.getPort('GigabitEthernet0/0'), r2.getPort('GigabitEthernet0/0'));
  ios(r1).run('en\nconf t\nint g0/0\nip address 10.1.0.1 255.255.255.252\nno shut\nint g0/1\nip address 192.168.1.1 255.255.255.0\nend');
  ios(r2).run('en\nconf t\nint g0/0\nip address 10.1.0.2 255.255.255.252\nno shut\nend');
  net.settle(100);
  return { net, r1, r2 };
}

const ospfOn = (r, lines) => ios(r).run(`en\nconf t\nrouter ospf 1\n${lines}\nend`);
const nbr = (r, rid) => r.ospf.neighborRows().find((x) => x.rid === rid);

test('two routers become FULL neighbours and the higher router ID is DR', () => {
  const { net, r1, r2 } = pair();
  ospfOn(r1, 'network 10.1.0.0 0.0.0.3 area 0');
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 0');
  // g0/1 (192.168.1.1) has no cable, so it is down and not used for the router ID
  assert.equal(r1.ospf.routerId, '10.1.0.1', 'highest address on an interface that is up');
  net.runFor(15000);
  assert.equal(nbr(r1, '10.1.0.2').state, '2WAY/DROTHER', 'hellos seen both ways, election still waiting');
  net.runFor(60000);
  assert.equal(nbr(r1, '10.1.0.2').state, 'FULL/DR');
  assert.equal(nbr(r2, '10.1.0.1').state, 'FULL/BDR');

  const o = ios(r1).run('en\nshow ip ospf neighbor');
  assert.match(o, /Neighbor ID\s+Pri\s+State\s+Dead Time\s+Address\s+Interface/);
  assert.match(o, /10\.1\.0\.2\s+1\s+FULL\/DR\s+00:00:\d\d\s+10\.1\.0\.2\s+GigabitEthernet0\/0/);
  assert.ok(r1.consoleLines.some((l) => /%OSPF-5-ADJCHG: Process 1, Nbr 10\.1\.0\.2 on GigabitEthernet0\/0 from LOADING to FULL, Loading Done/.test(l)));
  // the interface outside every network statement does not run OSPF
  assert.ok(!r1.ospf.ifs.has('GigabitEthernet0/1'));
});

test('DR, BDR and DROTHER roles on a shared segment', () => {
  const { net, routers } = lan(4);
  routers.forEach((r, k) => ospfOn(r, `router-id ${k + 1}.${k + 1}.${k + 1}.${k + 1}\nnetwork 10.0.0.0 0.0.0.255 area 0`));
  net.runFor(90000);
  const [r1, r2, r3, r4] = routers;
  assert.equal(nbr(r1, '4.4.4.4').state, 'FULL/DR');
  assert.equal(nbr(r1, '3.3.3.3').state, 'FULL/BDR');
  assert.equal(nbr(r1, '2.2.2.2').state, '2WAY/DROTHER', 'two DROTHERs stay in 2WAY');
  assert.equal(nbr(r4, '1.1.1.1').state, 'FULL/DROTHER');
  assert.equal(nbr(r3, '2.2.2.2').state, 'FULL/DROTHER');
  for (const r of routers) assert.equal(r.ospf.neighborRows().length, 3);
  for (const r of routers) {
    const st = r.ospf.ifs.get('GigabitEthernet0/0');
    assert.equal(st.dr, '10.0.0.4');
    assert.equal(st.bdr, '10.0.0.3');
  }
  void r2;
});

test('priority 0 never becomes DR, a higher priority beats a higher router ID', () => {
  const { net, routers } = lan(3);
  const [r1, r2, r3] = routers;
  ios(r3).run('en\nconf t\nint g0/0\nip ospf priority 0\nend');
  ios(r1).run('en\nconf t\nint g0/0\nip ospf priority 50\nend');
  routers.forEach((r) => ospfOn(r, 'network 10.0.0.0 0.0.0.255 area 0'));
  net.runFor(90000);
  assert.equal(nbr(r2, '10.0.0.1').state, 'FULL/DR');
  assert.equal(nbr(r1, '10.0.0.2').state, 'FULL/BDR');
  assert.equal(nbr(r1, '10.0.0.3').state, 'FULL/DROTHER');
  assert.match(ios(r1).run('en\nshow ip ospf neighbor'), /10\.0\.0\.3\s+0\s+FULL\/DROTHER/);
  assert.match(ios(r3).run('en\nshow run'), /interface GigabitEthernet0\/0\n[^!]*ip ospf priority 0/);
});

test('a router that joins later does not take over the DR role', () => {
  const { net, routers } = lan(3);
  const [r1, r2, r3] = routers;
  ospfOn(r1, 'network 10.0.0.0 0.0.0.255 area 0');
  ospfOn(r2, 'network 10.0.0.0 0.0.0.255 area 0');
  net.runFor(90000);
  assert.equal(nbr(r1, '10.0.0.2').state, 'FULL/DR');
  ospfOn(r3, 'network 10.0.0.0 0.0.0.255 area 0');
  net.runFor(60000);
  assert.equal(nbr(r3, '10.0.0.2').state, 'FULL/DR', 'the existing DR keeps its job');
  assert.equal(nbr(r3, '10.0.0.1').state, 'FULL/BDR');
  assert.equal(nbr(r1, '10.0.0.3').state, 'FULL/DROTHER');
});

test('mismatched hello settings or areas stop neighbours forming, and the inspector says why', () => {
  const { net, r1, r2 } = pair();
  ospfOn(r1, 'network 10.1.0.0 0.0.0.3 area 0');
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 1');
  net.recording = true;
  net.runFor(60000);
  assert.equal(r1.ospf.neighborRows().length, 0);
  let notes = net.events.flatMap((e) => e.notes);
  assert.ok(notes.some((n) => /R1: OSPF hello from 10\.1\.0\.2 ignored: it is in area 1, this interface is in area 0/.test(n)), notes.join('\n'));

  ospfOn(r2, 'no network 10.1.0.0 0.0.0.3 area 1\nnetwork 10.1.0.0 0.0.0.3 area 0');
  ios(r2).run('en\nconf t\nint g0/0\nip ospf hello-interval 5\nend');
  assert.equal(r2.ospf.ifs.get('GigabitEthernet0/0').dead, 20, 'dead interval follows hello x4');
  net.events = [];
  net.runFor(60000);
  assert.equal(r1.ospf.neighborRows().length, 0);
  notes = net.events.flatMap((e) => e.notes);
  assert.ok(notes.some((n) => /R1: OSPF hello from 10\.1\.0\.2 ignored: hello interval 5 s does not match 10 s/.test(n)));

  ios(r1).run('en\nconf t\nint g0/0\nip ospf hello-interval 5\nend');
  net.runFor(60000);
  assert.equal(nbr(r1, '10.1.0.2').state.split('/')[0], 'FULL');
  assert.match(ios(r1).run('en\nshow run'), / ip ospf hello-interval 5/);
});

test('hellos explain the path from INIT to 2WAY to FULL', () => {
  const { net, r1, r2 } = pair();
  net.recording = true;
  ospfOn(r1, 'network 10.1.0.0 0.0.0.3 area 0');
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 0');
  net.runFor(70000);
  const notes = net.events.flatMap((e) => e.notes);
  assert.ok(notes.some((n) => /new neighbour, state INIT/.test(n)));
  assert.ok(notes.some((n) => /lists my router ID, so we can hear each other: state 2WAY/.test(n)));
  assert.ok(notes.some((n) => /OSPF election on GigabitEthernet0\/0: DR is/.test(n)));
  assert.ok(notes.some((n) => /adjacency is FULL/.test(n)));
  const ospfEvents = net.events.filter((e) => e.protocol === 'OSPF');
  assert.ok(ospfEvents.some((e) => /^OSPF hello from /.test(e.summary)));
  assert.ok(ospfEvents.some((e) => /^OSPF database description from /.test(e.summary)));
  void r1;
});

test('a silent neighbour is removed when its dead timer runs out', () => {
  const { net, r1, r2 } = pair();
  ospfOn(r1, 'network 10.1.0.0 0.0.0.3 area 0');
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 0');
  net.runFor(90000);
  assert.ok(nbr(r1, '10.1.0.2'));
  // stop R2 sending hellos without taking R1's link down
  ospfOn(r2, 'passive-interface g0/0');
  net.runFor(20000);
  assert.ok(nbr(r1, '10.1.0.2'), 'still within the dead interval');
  net.runFor(30000);
  assert.equal(nbr(r1, '10.1.0.2'), undefined);
  assert.ok(r1.consoleLines.some((l) => /Nbr 10\.1\.0\.2 on GigabitEthernet0\/0 from FULL to DOWN, Dead timer expired/.test(l)));
  assert.match(ios(r2).run('en\nshow run'), /router ospf 1\n log-adjacency-changes\n passive-interface GigabitEthernet0\/0\n network 10\.1\.0\.0 0\.0\.0\.3 area 0/);
});

test('shutting an interface drops its neighbours at once', () => {
  const { net, r1, r2 } = pair();
  ospfOn(r1, 'network 10.1.0.0 0.0.0.3 area 0');
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 0');
  net.runFor(90000);
  ios(r1).run('en\nconf t\nint g0/0\nshutdown\nend');
  net.settle(10);
  assert.equal(r1.ospf.neighborRows().length, 0);
  assert.ok(r1.consoleLines.some((l) => /from FULL to DOWN, Interface down or detached/.test(l)));
});

test('router-id changes wait for clear ip ospf process once neighbours exist', () => {
  const { net, r1, r2 } = pair();
  ospfOn(r1, 'router-id 1.1.1.1\nnetwork 10.1.0.0 0.0.0.3 area 0');
  assert.equal(r1.ospf.routerId, '1.1.1.1', 'applies at once with no neighbours');
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 0');
  net.runFor(90000);
  const o = ospfOn(r1, 'router-id 9.9.9.9');
  assert.match(o, /Reload or use "clear ip ospf process" command, for this to take effect/);
  assert.equal(r1.ospf.routerId, '1.1.1.1');
  assert.match(ios(r1).run('en\nclear ip ospf process'), /Reset ALL OSPF processes\?/);
  assert.equal(r1.ospf.routerId, '9.9.9.9');
  net.runFor(90000);
  assert.equal(nbr(r2, '9.9.9.9').state.split('/')[0], 'FULL');
  assert.equal(nbr(r2, '1.1.1.1'), undefined);
});

test('duplicate router IDs are reported and never become neighbours', () => {
  const { net, r1, r2 } = pair();
  ospfOn(r1, 'router-id 5.5.5.5\nnetwork 10.1.0.0 0.0.0.3 area 0');
  ospfOn(r2, 'router-id 5.5.5.5\nnetwork 10.1.0.0 0.0.0.3 area 0');
  net.runFor(30000);
  assert.equal(r1.ospf.neighborRows().length, 0);
  assert.ok(r1.consoleLines.some((l) => /%OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id 5\.5\.5\.5 from 10\.1\.0\.2/.test(l)));
});

test('network statements: wildcard matching, most specific wins, CLI checks', () => {
  assert.ok(wildcardMatch('10.1.2.3', '10.0.0.0', '0.255.255.255'));
  assert.ok(!wildcardMatch('11.1.2.3', '10.0.0.0', '0.255.255.255'));
  assert.ok(wildcardMatch('10.1.0.2', '10.1.0.2', '0.0.0.0'));
  const { r1 } = pair();
  const t = ios(r1);
  t.run('en\nconf t\nrouter ospf 1');
  t.run('network 10.0.0.0 0.255.255.255 area 0\nnetwork 10.1.0.1 0.0.0.0 area 2');
  assert.equal(r1.ospf.areaOf(r1.getIface('GigabitEthernet0/0')), 2);
  assert.match(t.run('network 10.0.0.0 0.255.255.255 area 3'), /already configured in another area/);
  assert.match(t.run('network 10.0.0.0'), /% Incomplete command\./);
  assert.match(t.run('router-id 0.0.0.0'), /not allowed/);
  t.run('network 192.168.1.0 0.0.0.255 area 0.0.0.0');
  assert.deepEqual(r1.ospf.networks.at(-1), { ip: '192.168.1.0', wildcard: '0.0.0.255', area: 0 });
  // the network address is normalised like on real routers
  t.run('network 172.16.5.9 0.0.255.255 area 0');
  assert.equal(r1.ospf.networks.at(-1).ip, '172.16.0.0');
  assert.match(t.run('exit\nrouter ospf 2'), /one OSPF process per router; process 1 is already running/);
  t.run('no router ospf 1');
  assert.equal(r1.ospf.enabled, false);
  assert.equal(t.run('do show ip ospf neighbor'), '\n');
  assert.match(t.run('int g0/0\nip ospf priority 256'), /between 0 and 255/);
});

test('RIP commands still work in router configuration mode next to OSPF', () => {
  const { r1 } = pair();
  const t = ios(r1);
  t.run('en\nconf t\nrouter rip\nversion 2\nnetwork 10.0.0.0\nexit\nrouter ospf 1\nnetwork 10.1.0.0 0.0.0.3 area 0\npassive-interface g0/1\nexit');
  assert.deepEqual(r1.rip.networks, ['10.0.0.0']);
  assert.equal(r1.rip.passive.size, 0, 'passive-interface went to OSPF');
  assert.ok(r1.ospf.passive.has('GigabitEthernet0/1'));
  const run = t.run('do show run');
  assert.match(run, /router rip\n version 2\n network 10\.0\.0\.0/);
  assert.match(run, /router ospf 1\n log-adjacency-changes\n passive-interface GigabitEthernet0\/1\n network 10\.1\.0\.0 0\.0\.0\.3 area 0/);
});

test('OSPF config survives save/load, and older files without OSPF still open', () => {
  const { net, r1, r2 } = pair();
  ospfOn(r1, 'router-id 1.1.1.1\nnetwork 10.1.0.0 0.0.0.3 area 0');
  ios(r1).run('en\nconf t\nint g0/0\nip ospf dead-interval 60\nend');
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 0');
  ios(r2).run('en\nconf t\nint g0/0\nip ospf dead-interval 60\nend');
  const data = JSON.parse(JSON.stringify(serializeNetwork(net)));
  const copy = loadNetwork(data, new Network());
  copy.runFor(120000);
  const c1 = copy.findDevice('R1');
  assert.equal(c1.ospf.routerId, '1.1.1.1');
  assert.equal(c1.getIface('GigabitEthernet0/0').ospf.dead, 60);
  assert.equal(nbr(c1, '10.1.0.2').state.split('/')[0], 'FULL');

  // a file saved before OSPF existed: no "ospf" keys anywhere
  for (const d of data.devices) {
    delete d.config.ospf;
    for (const i of d.config.ifaces || []) delete i.ospf;
  }
  const old = loadNetwork(data, new Network());
  assert.equal(old.findDevice('R1').ospf.enabled, false);
  assert.equal(old.findDevice('R1').getIface('GigabitEthernet0/0').ospf, undefined);
});

test('startup-config and reload keep OSPF', () => {
  const { net, r1, r2 } = pair();
  ospfOn(r1, 'network 10.1.0.0 0.0.0.3 area 0');
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 0');
  ios(r1).run('en\nwrite memory');
  ios(r1).run('en\nreload');
  net.runFor(90000);
  assert.equal(r1.ospf.enabled, true);
  assert.equal(nbr(r1, '10.1.0.2').state.split('/')[0], 'FULL');
});

test('hellos from outside the interface subnet are ignored', () => {
  const { net, routers } = lan(2);
  const [r1, r2] = routers;
  ios(r2).run('en\nconf t\nint g0/0\nip address 10.9.0.2 255.255.255.0\nend');
  ospfOn(r1, 'network 10.0.0.0 0.255.255.255 area 0');
  ospfOn(r2, 'network 10.0.0.0 0.255.255.255 area 0');
  net.recording = true;
  net.runFor(60000);
  assert.equal(r1.ospf.neighborRows().length, 0);
  const notes = net.events.flatMap((e) => e.notes);
  assert.ok(notes.some((n) => /R1: OSPF hello from 10\.9\.0\.2 ignored: it is not in my subnet 10\.0\.0\.0/.test(n)), notes.join('\n'));
});

test('two routers claiming one router ID do not share a neighbour entry', () => {
  const { net, routers } = lan(3);
  const [r1, r2, r3] = routers;
  ospfOn(r1, 'network 10.0.0.0 0.0.0.255 area 0');
  ospfOn(r2, 'router-id 7.7.7.7\nnetwork 10.0.0.0 0.0.0.255 area 0');
  net.runFor(3000);
  ospfOn(r3, 'router-id 7.7.7.7\nnetwork 10.0.0.0 0.0.0.255 area 0');
  net.runFor(90000);
  const rows = r1.ospf.neighborRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ip, '10.0.0.2', 'the first router keeps the entry');
  assert.ok(r1.consoleLines.some((l) => /DUP_RTRID_NBR: OSPF detected duplicate router-id 7\.7\.7\.7 from 10\.0\.0\.3/.test(l)));
});

test('losing two-way contact with the DR triggers a new election', () => {
  const { net, routers } = lan(3);
  const [r1, , r3] = routers;
  routers.forEach((r) => ospfOn(r, 'network 10.0.0.0 0.0.0.255 area 0'));
  net.runFor(90000);
  const st = r1.ospf.ifs.get('GigabitEthernet0/0');
  assert.equal(st.dr, '10.0.0.3');
  // R3 keeps declaring itself DR, but its hello no longer lists R1 (one-way)
  r1.ospf.receive(r1.getIface('GigabitEthernet0/0'), {
    src: '10.0.0.3', dst: '224.0.0.5', proto: 'OSPF',
    payload: { version: 2, type: 'Hello', routerId: r3.ospf.routerId, area: 0, mask: '255.255.255.0', hello: 10, dead: 40, priority: 1, dr: '10.0.0.3', bdr: '10.0.0.2', neighbors: ['10.0.0.2'] },
  });
  assert.equal(nbr(r1, '10.0.0.3').state.split('/')[0], 'INIT');
  assert.notEqual(st.dr, '10.0.0.3', 'a one-way neighbour cannot stay DR');
});

test('clear ip ospf <n> process only resets a running process; adjacency logging can be turned off', () => {
  const { net, r1, r2 } = pair();
  ospfOn(r1, 'network 10.1.0.0 0.0.0.3 area 0\nno log-adjacency-changes');
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 0');
  net.runFor(90000);
  assert.ok(nbr(r1, '10.1.0.2'));
  assert.ok(!r1.consoleLines.some((l) => /ADJCHG/.test(l)), 'logging is off');
  assert.ok(r2.consoleLines.some((l) => /ADJCHG/.test(l)));
  assert.match(ios(r1).run('en\nclear ip ospf 2 process'), /Process 2 is not running/);
  assert.ok(nbr(r1, '10.1.0.2'), 'process 1 was not reset');
  assert.match(ios(r1).run('en\nshow run'), /router ospf 1\n no log-adjacency-changes/);
  const copy = loadNetwork(JSON.parse(JSON.stringify(serializeNetwork(net))), new Network());
  assert.equal(copy.findDevice('R1').ospf.logAdjacency, false);
  assert.equal(copy.findDevice('R2').ospf.logAdjacency, true);
});

test('OSPF configuration changes notify the UI for autosave, and the neighbour filter takes short names', () => {
  const { net, r1, r2 } = pair();
  let events = 0;
  net.on('config', () => { events++; });
  ospfOn(r1, 'network 10.1.0.0 0.0.0.3 area 0');
  assert.ok(events >= 2, 'router ospf and network both notify');
  const before = events;
  ios(r1).run('en\nconf t\nint g0/0\nip ospf priority 5\nend');
  assert.ok(events > before);
  ospfOn(r2, 'network 10.1.0.0 0.0.0.3 area 0');
  net.runFor(90000);
  assert.match(ios(r1).run('en\nshow ip ospf neighbor g0/0'), /10\.1\.0\.2\s+1\s+FULL/);
  assert.doesNotMatch(ios(r1).run('en\nshow ip ospf neighbor g0/1'), /10\.1\.0\.2/);
});
