import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice, serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { ios, cmd } from './helpers.js';

const ospfOn = (r, lines) => ios(r).run(`en\nconf t\nrouter ospf 1\n${lines}\nend`);
const oRoutes = (r, network) => r.routes().filter((x) => x.proto === 'O' && (!network || x.network === network));

/**
 * Four routers in a ring with a PC at each end:
 *   PC1 - R1 -(g0/1)- R2 - R4 - PC4
 *          \-(g0/2)- R3 -/
 */
function ring({ slowR2 = true } = {}) {
  const net = new Network();
  const R = {};
  for (const n of ['R1', 'R2', 'R3', 'R4']) R[n] = createDevice(net, 'router', { name: n });
  const link = (a, pa, b, pb) => net.connect(R[a].getPort(pa), R[b].getPort(pb));
  link('R1', 'GigabitEthernet0/1', 'R2', 'GigabitEthernet0/0');
  link('R1', 'GigabitEthernet0/2', 'R3', 'GigabitEthernet0/0');
  link('R2', 'GigabitEthernet0/1', 'R4', 'GigabitEthernet0/1');
  link('R3', 'GigabitEthernet0/1', 'R4', 'GigabitEthernet0/2');
  const pc1 = createDevice(net, 'pc', { name: 'PC1' });
  const pc4 = createDevice(net, 'pc', { name: 'PC4' });
  net.connect(pc1.getPort('FastEthernet0'), R.R1.getPort('GigabitEthernet0/0'));
  net.connect(pc4.getPort('FastEthernet0'), R.R4.getPort('GigabitEthernet0/0'));
  const cfg = {
    R1: [['g0/0', '10.1.0.1 255.255.255.0'], ['g0/1', '10.12.0.1 255.255.255.252'], ['g0/2', '10.13.0.1 255.255.255.252']],
    R2: [['g0/0', '10.12.0.2 255.255.255.252'], ['g0/1', '10.24.0.1 255.255.255.252']],
    R3: [['g0/0', '10.13.0.2 255.255.255.252'], ['g0/1', '10.34.0.1 255.255.255.252']],
    R4: [['g0/0', '10.4.0.1 255.255.255.0'], ['g0/1', '10.24.0.2 255.255.255.252'], ['g0/2', '10.34.0.2 255.255.255.252']],
  };
  for (const [r, list] of Object.entries(cfg)) {
    ios(R[r]).run(`en\nconf t\n${list.map(([i, a]) => `int ${i}\nip address ${a}\nno shut`).join('\n')}\nend`);
  }
  if (slowR2) {
    for (const [r, i] of [['R1', 'g0/1'], ['R2', 'g0/0'], ['R2', 'g0/1'], ['R4', 'g0/1']]) ios(R[r]).run(`en\nconf t\nint ${i}\nbandwidth 10000\nend`);
  }
  pc1.setStatic({ ip: '10.1.0.10', mask: '255.255.255.0', gateway: '10.1.0.1' });
  pc4.setStatic({ ip: '10.4.0.10', mask: '255.255.255.0', gateway: '10.4.0.1' });
  net.settle(100);
  return { net, R, pc1, pc4 };
}

const allOspf = (R) => { for (const r of Object.values(R)) ospfOn(r, 'network 10.0.0.0 0.255.255.255 area 0'); };

test('OSPF installs lowest-cost routes, with cost = 100 Mbit/s / bandwidth', () => {
  const { net, R, pc1 } = ring();
  allOspf(R);
  net.runFor(70000);
  const [via] = oRoutes(R.R1, '10.4.0.0');
  assert.ok(via, 'R1 learned PC4\'s LAN');
  assert.equal(via.nextHop, '10.13.0.2', 'the gigabit path through R3 wins');
  assert.equal(via.metric, 3, '1 (R1-R3) + 1 (R3-R4) + 1 (R4 LAN)');
  assert.equal(via.ad, 110);
  assert.equal(oRoutes(R.R1, '10.4.0.0').length, 1, 'no equal-cost second path');

  const table = ios(R.R1).run('en\nshow ip route');
  assert.match(table, /O\s+10\.4\.0\.0\/24 \[110\/3\] via 10\.13\.0\.2, \d\d:\d\d:\d\d, GigabitEthernet0\/2/);
  assert.match(table, /O\s+10\.24\.0\.0\/30 \[110\/12\] via 10\.13\.0\.2/);
  const only = ios(R.R1).run('en\nshow ip route ospf');
  assert.doesNotMatch(only, /^C /m);
  assert.match(only, /O\s+10\.34\.0\.0\/30 \[110\/2\]/);
  assert.match(ios(R.R1).run('en\nshow ip route 10.4.0.10'), /Known via "ospf 1", distance 110, metric 3/);
  assert.match(ios(R.R1).run('en\nshow interfaces g0/1'), /BW 10000 Kbit/);
  assert.match(ios(R.R1).run('en\nshow ip ospf interface brief'), /Gi0\/1\s+1\s+0\s+10\.12\.0\.1\/30\s+10\s+\w+\s+1\/1/);

  const o = cmd(pc1).run('ping 10.4.0.10', net);
  assert.match(o, /Reply from 10\.4\.0\.10/);
});

test('OSPF reroutes around a failed link, and equal costs share the load', () => {
  const { net, R } = ring();
  allOspf(R);
  net.runFor(70000);
  ios(R.R1).run('en\nconf t\nint g0/2\nshutdown\nend');
  net.runFor(5000);
  const [via] = oRoutes(R.R1, '10.4.0.0');
  assert.equal(via.nextHop, '10.12.0.2');
  assert.equal(via.metric, 21, '10 + 10 + 1 over the slow path');
  const back = oRoutes(R.R4, '10.1.0.0');
  assert.equal(back.length, 1);
  assert.equal(back[0].nextHop, '10.24.0.1', 'R4 learned about the failure by flooding');

  // without the slow links both paths cost the same, so both are installed
  const eq = ring({ slowR2: false });
  allOspf(eq.R);
  eq.net.runFor(70000);
  const paths = oRoutes(eq.R.R1, '10.4.0.0').map((x) => x.nextHop).sort();
  assert.deepEqual(paths, ['10.12.0.2', '10.13.0.2']);
});

test('ip ospf cost and auto-cost reference-bandwidth change the path', () => {
  const { net, R } = ring({ slowR2: false });
  allOspf(R);
  ios(R.R1).run('en\nconf t\nint g0/2\nip ospf cost 50\nend');
  net.runFor(70000);
  assert.deepEqual(oRoutes(R.R1, '10.4.0.0').map((x) => [x.nextHop, x.metric]), [['10.12.0.2', 3]]);
  assert.match(ios(R.R1).run('en\nshow run'), /interface GigabitEthernet0\/2\n ip address 10\.13\.0\.1 255\.255\.255\.252\n ip ospf cost 50/);

  ios(R.R1).run('en\nconf t\nint g0/2\nno ip ospf cost\nend');
  const msg = ospfOn(R.R1, 'auto-cost reference-bandwidth 10000');
  assert.match(msg, /Reference bandwidth is changed/);
  assert.equal(R.R1.ospf.ifs.get('GigabitEthernet0/1').cost, 10, '10 000 Mbit/s / 1000 Mbit/s');
  assert.match(ios(R.R1).run('en\nshow ip protocols'), /Reference bandwidth unit is 10000 mbps/);
  assert.match(ios(R.R1).run('en\nshow run'), / auto-cost reference-bandwidth 10000/);
  ospfOn(R.R1, 'no auto-cost reference-bandwidth');
  assert.equal(R.R1.ospf.ifs.get('GigabitEthernet0/1').cost, 1);
});

test('database exchange uses requests, updates and acknowledgements, and the inspector explains it', () => {
  const { net, R } = ring();
  net.recording = true;
  allOspf(R);
  net.runFor(70000);
  const notes = net.events.flatMap((e) => e.notes);
  assert.ok(notes.some((n) => /state LOADING, asking for them with a link-state request/.test(n)));
  assert.ok(notes.some((n) => /every LSA requested from .* has arrived, adjacency is FULL/.test(n)));
  assert.ok(notes.some((n) => /link-state update from .*: new router LSA .* added to my database/.test(n)));
  assert.ok(notes.some((n) => /ran shortest path first \(Dijkstra\)/.test(n)));
  const summaries = net.events.filter((e) => e.protocol === 'OSPF').map((e) => e.summary);
  for (const kind of ['link-state request', 'link-state update', 'link-state acknowledgement']) {
    assert.ok(summaries.some((s) => s.startsWith(`OSPF ${kind} from `)), kind);
  }
  // every router ends up with the same database
  const keys = (r) => [...r.ospf.lsdb.values()].filter((l) => !l.maxAge).map((l) => `${l.type}:${l.id}:${l.adv}:${l.seq}`).sort().join(',');
  for (const r of ['R2', 'R3', 'R4']) assert.equal(keys(R[r]), keys(R.R1), r);
  const db = ios(R.R1).run('en\nshow ip ospf database');
  assert.match(db, /Router Link States \(Area 0\)/);
  assert.match(db, /Net Link States \(Area 0\)/);
  assert.equal(db.match(/0x8000000/g).length, 8, 'four router LSAs and four network LSAs');
});

test('routers on a shared segment route straight to each other, not through the DR', () => {
  const net = new Network();
  const sw = createDevice(net, 'switch', { name: 'S1' });
  const routers = [];
  for (let k = 1; k <= 3; k++) {
    const r = createDevice(net, 'router', { name: `R${k}` });
    const pc = createDevice(net, 'pc', { name: `PC${k}` });
    net.connect(r.getPort('GigabitEthernet0/0'), sw.ports[k - 1]);
    net.connect(pc.getPort('FastEthernet0'), r.getPort('GigabitEthernet0/1'));
    ios(r).run(`en\nconf t\nint g0/0\nip address 10.0.0.${k} 255.255.255.0\nno shut\nint g0/1\nip address 192.168.${k}.1 255.255.255.0\nno shut\nend`);
    ospfOn(r, `router-id ${k}.${k}.${k}.${k}\nnetwork 10.0.0.0 0.0.0.255 area 0\nnetwork 192.168.${k}.0 0.0.0.255 area 0\npassive-interface g0/1`);
    routers.push(r);
  }
  net.runFor(80000);
  const [r1, r2] = routers;
  assert.equal(r1.ospf.ifs.get('GigabitEthernet0/0').dr, '10.0.0.3');
  const [toR2] = oRoutes(r1, '192.168.2.0');
  assert.equal(toR2.nextHop, '10.0.0.2', 'DROTHER to DROTHER goes direct');
  assert.equal(toR2.metric, 2);
  assert.equal(oRoutes(r2, '192.168.1.0')[0].nextHop, '10.0.0.1');
  assert.match(ios(r1).run('en\nshow ip protocols'), /Routing Protocol is "ospf 1"[\s\S]*Router ID 1\.1\.1\.1[\s\S]*Passive Interface\(s\):\n\s+GigabitEthernet0\/1[\s\S]*2\.2\.2\.2\s+110/);
});

test('OSPF (distance 110) is preferred over RIP (distance 120)', () => {
  const { net, R } = ring({ slowR2: false });
  for (const r of Object.values(R)) ios(r).run('en\nconf t\nrouter rip\nversion 2\nno auto-summary\nnetwork 10.0.0.0\nend');
  net.runFor(40000);
  assert.ok(R.R1.routes().some((x) => x.proto === 'R' && x.network === '10.4.0.0'));
  allOspf(R);
  net.runFor(70000);
  const best = R.R1.routes().filter((x) => x.network === '10.4.0.0');
  assert.ok(best.length && best.every((x) => x.proto === 'O'));
  assert.match(ios(R.R1).run('en\nshow ip protocols'), /Routing Protocol is "rip"[\s\S]*Routing Protocol is "ospf 1"/);
});

test('after clear ip ospf process a router replaces its old LSAs with newer copies', () => {
  const { net, R } = ring();
  allOspf(R);
  net.runFor(70000);
  const rid = R.R1.ospf.routerId;
  const before = R.R2.ospf.lsdb.get(`router:${rid}:${rid}`).seq;
  ios(R.R1).run('en\nclear ip ospf process');
  net.runFor(70000);
  const mine = R.R1.ospf.lsdb.get(`router:${rid}:${rid}`);
  assert.ok(mine.seq > before, 'restarted router jumped past its old sequence number');
  assert.equal(R.R2.ospf.lsdb.get(`router:${rid}:${rid}`).seq, mine.seq);
  assert.equal(oRoutes(R.R1, '10.4.0.0')[0]?.nextHop, '10.13.0.2');
  assert.equal(oRoutes(R.R4, '10.1.0.0')[0]?.nextHop, '10.34.0.1');
});

test('no router ospf removes OSPF routes; neighbours drop them after the dead interval', () => {
  const { net, R } = ring();
  allOspf(R);
  net.runFor(70000);
  ios(R.R4).run('en\nconf t\nno router ospf 1\nend');
  assert.equal(oRoutes(R.R4).length, 0);
  net.runFor(50000);
  assert.equal(oRoutes(R.R1, '10.4.0.0').length, 0, 'R4\'s LAN is gone');
  assert.ok(oRoutes(R.R1, '10.34.0.0').length, 'R3\'s side of the old link is still known');
});

test('bandwidth, ip ospf cost and reference bandwidth survive save and load; old files still open', () => {
  const { net, R } = ring();
  allOspf(R);
  ios(R.R1).run('en\nconf t\nint g0/2\nip ospf cost 7\nrouter ospf 1\nauto-cost reference-bandwidth 1000\nend');
  const saved = serializeNetwork(net);
  const copy = loadNetwork(JSON.parse(JSON.stringify(saved)), new Network());
  const r1 = copy.findDevice('R1');
  assert.equal(r1.getIface('GigabitEthernet0/1').bandwidth, 10000);
  assert.equal(r1.getIface('GigabitEthernet0/2').ospf.cost, 7);
  assert.equal(r1.ospf.referenceBw, 1000);
  copy.runFor(70000);
  assert.equal(oRoutes(copy.findDevice('R1'), '10.4.0.0')[0]?.nextHop, '10.13.0.2');

  // a file saved before these fields existed
  const old = JSON.parse(JSON.stringify(saved));
  for (const d of old.devices) {
    if (d.type !== 'router' || !d.config) continue;
    for (const i of d.config.ifaces || []) { delete i.bandwidth; if (i.ospf) delete i.ospf.cost; }
    if (d.config.ospf) delete d.config.ospf.referenceBw;
  }
  const legacy = loadNetwork(old, new Network());
  const l1 = legacy.findDevice('R1');
  assert.equal(l1.ospf.referenceBw, 100);
  assert.equal(l1.ospf.ifaceCost(l1.getIface('GigabitEthernet0/1')), 1);
  legacy.runFor(70000);
  assert.equal(oRoutes(l1, '10.4.0.0').length, 2, 'equal costs without the bandwidth settings');
});
