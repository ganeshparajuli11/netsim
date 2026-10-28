import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice, serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { ios, cmd } from './helpers.js';

/** Staff and Guest on R1 G0/0 (192.168.1.0/24), Files on R1 G0/1 (192.168.99.0/24). */
function office() {
  const net = new Network();
  const r1 = createDevice(net, 'router', { name: 'R1' });
  const sw = createDevice(net, 'switch', { name: 'S1' });
  const staff = createDevice(net, 'pc', { name: 'Staff' });
  const guest = createDevice(net, 'pc', { name: 'Guest' });
  const files = createDevice(net, 'server', { name: 'Files' });
  net.connect(r1.getPort('GigabitEthernet0/0'), sw.getPort('GigabitEthernet0/1'));
  net.connect(staff.getPort('FastEthernet0'), sw.getPort('FastEthernet0/1'));
  net.connect(guest.getPort('FastEthernet0'), sw.getPort('FastEthernet0/2'));
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
  staff.setStatic({ ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
  guest.setStatic({ ip: '192.168.1.50', mask: '255.255.255.0', gateway: '192.168.1.1' });
  files.setStatic({ ip: '192.168.99.10', mask: '255.255.255.0', gateway: '192.168.99.1' });
  net.settle(500);
  const t = ios(r1);
  t.run('en');
  return { net, r1, t };
}

const pings = (net, from, ip) => {
  const pc = net.findDevice(from);
  cmd(pc).run(`ping ${ip}`, net); // the first echo may be lost to ARP on the router
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

test('a named standard list filters like a numbered one and shows its name and sequence numbers', () => {
  const { net, t } = office();
  const out = t.run(`conf t
    ip access-list standard NO-GUEST
    deny host 192.168.1.50
    permit any
    int g0/1
    ip access-group NO-GUEST out
    end`);
  assert.doesNotMatch(out, /% /, out);
  assert.match(pings(net, 'Staff', '192.168.99.10'), /Received = 4/);
  assert.match(pings(net, 'Guest', '192.168.99.10'), /Destination host unreachable/);
  const sh = t.run('show access-lists');
  assert.match(sh, /Standard IP access list NO-GUEST\n {4}10 deny 192\.168\.1\.50 \(\d+ match\(es\)\)\n {4}20 permit any \(\d+ match/, sh);
  assert.match(t.run('show ip access-lists NO-GUEST'), /NO-GUEST/);
  assert.equal(t.run('show access-lists OTHER'), '\n');
  const rc = t.run('show running-config');
  assert.match(rc, /ip access-group NO-GUEST out/);
  assert.match(rc, /ip access-list standard NO-GUEST\n deny 192\.168\.1\.50\n permit any\n/);
});

test('the prompt shows the list mode, and other config commands still work from it', () => {
  const { t } = office();
  t.run('conf t');
  t.run('ip access-list extended WEB');
  assert.equal(t.cli.prompt(), 'R1(config-ext-nacl)#');
  t.run('exit');
  assert.equal(t.cli.prompt(), 'R1(config)#');
  t.run('ip access-list standard MGMT');
  assert.equal(t.cli.prompt(), 'R1(config-std-nacl)#');
  t.run('interface g0/0'); // falls back to global config
  assert.equal(t.cli.prompt(), 'R1(config-if)#');
  t.run('end');
  assert.equal(t.cli.prompt(), 'R1#');
});

test('sequence numbers insert lines between others and "no <seq>" removes one line', () => {
  const { net, r1, t } = office();
  t.run(`conf t
    ip access-list standard FILES
    permit any
    int g0/1
    ip access-group FILES out
    end`);
  assert.match(pings(net, 'Guest', '192.168.99.10'), /Received = 4/);
  // line 5 is checked before line 10
  t.run('conf t\nip access-list standard FILES\n5 deny host 192.168.1.50\nend');
  assert.deepEqual(r1.acl.lists.get('FILES').map((r) => r.seq), [5, 10]);
  assert.match(pings(net, 'Guest', '192.168.99.10'), /Destination host unreachable/);
  assert.match(pings(net, 'Staff', '192.168.99.10'), /Received = 4/);
  // a line without a number goes after the last one
  t.run('conf t\nip access-list standard FILES\ndeny 10.0.0.0 0.255.255.255\nend');
  assert.deepEqual(r1.acl.lists.get('FILES').map((r) => r.seq), [5, 10, 20]);
  t.run('conf t\nip access-list standard FILES\nno 5\nend');
  assert.deepEqual(r1.acl.lists.get('FILES').map((r) => r.seq), [10, 20]);
  assert.match(pings(net, 'Guest', '192.168.99.10'), /Received = 4/);
  // errors
  let out = t.run('conf t\nip access-list standard FILES\n10 deny host 192.168.1.10');
  assert.match(out, /% Duplicate sequence number 10/);
  out = t.run('no 7');
  assert.match(out, /% Line 7 does not exist in access list FILES/);
  t.run('end');
});

test('"no permit|deny …" removes the matching line, and resequence renumbers the list', () => {
  const { r1, t } = office();
  t.run(`conf t
    ip access-list extended EDGE
    deny icmp host 192.168.1.50 any
    3 permit tcp any host 192.168.99.10 eq 80
    permit ip any any
    no deny icmp host 192.168.1.50 any
    exit
    ip access-list resequence EDGE 100 5
    end`);
  const rules = r1.acl.lists.get('EDGE');
  assert.deepEqual(rules.map((r) => [r.seq, r.action, r.proto]), [[100, 'permit', 'tcp'], [105, 'permit', 'ip']]);
  assert.match(t.run('conf t\nip access-list extended EDGE\nno deny udp any any'), /% No matching entry/);
  t.run('end');
});

test('a named extended list blocks the website but not ping, and the inspector names the line', () => {
  const { net, t } = office();
  t.run(`conf t
    ip access-list extended FILES-OUT
    remark guests may ping but not browse
    deny tcp host 192.168.1.50 host 192.168.99.10 eq www
    permit ip any any
    int g0/1
    ip access-group FILES-OUT out
    end`);
  assert.match(pings(net, 'Guest', '192.168.99.10'), /Received = 4/);
  assert.equal(browse(net, 'Guest', 'http://192.168.99.10/')?.status, undefined);
  assert.equal(browse(net, 'Staff', 'http://192.168.99.10/')?.status, 200);
  // remarks go into the running config, not into show access-lists
  assert.match(t.run('show running-config'), /ip access-list extended FILES-OUT\n remark guests may ping but not browse\n deny tcp host 192\.168\.1\.50 host 192\.168\.99\.10 eq 80\n permit ip any any/);
  const sh = t.run('show access-lists FILES-OUT');
  assert.doesNotMatch(sh, /remark/);
  assert.match(sh, /Extended IP access list FILES-OUT\n {4}20 deny tcp host 192\.168\.1\.50 host 192\.168\.99\.10 eq 80 \(\d+ match/);
  // simulation notes
  net.events = [];
  net.recording = true;
  browse(net, 'Guest', 'http://192.168.99.10/');
  const notes = net.events.flatMap((e) => e.notes || []);
  assert.ok(notes.some((n) => /ACL FILES-OUT out on GigabitEthernet0\/1: DENIED by line 20 \(deny tcp host 192\.168\.1\.50 host 192\.168\.99\.10 eq 80\)/.test(n)), notes.join('\n'));
});

test('numbered lists can be edited in list mode too', () => {
  const { r1, t } = office();
  t.run(`conf t
    access-list 10 permit any
    ip access-list standard 10
    5 deny host 192.168.1.50
    end`);
  assert.deepEqual(r1.acl.lists.get(10).map((r) => r.seq), [5, 10]);
  assert.match(t.run('show access-lists 10'), /Standard IP access list 10\n {4}5 deny 192\.168\.1\.50\n {4}10 permit any/);
  // a numbered list is still shown as access-list lines
  assert.match(t.run('show running-config'), /access-list 10 deny 192\.168\.1\.50\naccess-list 10 permit any/);
  const out = t.run('conf t\nip access-list extended 10');
  assert.match(out, /% 10 is not an extended access list number/);
  t.run('end');
});

test('names keep their type, must look like names, and can be removed', () => {
  const { r1, t } = office();
  t.run('conf t\nip access-list standard ALPHA\npermit any\nexit');
  let out = t.run('ip access-list extended ALPHA');
  assert.match(out, /% ALPHA is already a standard access list/);
  assert.equal(t.cli.mode, 'config');
  out = t.run('ip access-list standard 9LIVES');
  assert.match(out, /% Access list names start with a letter/);
  out = t.run('no ip access-list extended ALPHA');
  assert.match(out, /% ALPHA is a standard access list/);
  t.run('no ip access-list standard ALPHA');
  assert.equal(r1.acl.lists.has('ALPHA'), false);
  t.run('end');
});

test('an applied named list with no entries, or one that does not exist, filters nothing', () => {
  const { net, t } = office();
  t.run(`conf t
    ip access-list standard EMPTY
    int g0/1
    ip access-group EMPTY out
    int g0/0
    ip access-group MISSING in
    end`);
  assert.match(pings(net, 'Guest', '192.168.99.10'), /Received = 4/);
});

test('NAT overload can use a named list', () => {
  const { r1, t } = office();
  t.run(`conf t
    ip access-list standard INSIDE
    permit 192.168.1.0 0.0.0.255
    int g0/0
    ip nat inside
    int g0/1
    ip nat outside
    exit
    ip nat inside source list INSIDE interface g0/1 overload
    end`);
  assert.deepEqual(r1.nat.rules, [{ acl: 'INSIDE', iface: 'GigabitEthernet0/1', overload: true }]);
  assert.match(t.run('show running-config'), /ip nat inside source list INSIDE interface GigabitEthernet0\/1 overload/);
  const copy = loadNetwork(JSON.parse(JSON.stringify(serializeNetwork(r1.net))), new Network());
  assert.deepEqual(copy.findDevice('R1').nat.rules, [{ acl: 'INSIDE', iface: 'GigabitEthernet0/1', overload: true }]);
});

test('help lists the named list commands', () => {
  const { t } = office();
  t.run('conf t');
  assert.match(t.run('ip access-list ?'), /standard[\s\S]*extended|extended[\s\S]*standard/);
  t.run('ip access-list extended WEB');
  const h = t.run('?');
  for (const w of ['permit', 'deny', 'remark', 'no', '<0-4294967295>']) assert.ok(h.includes(w), h);
  t.run('end');
});

test('named lists, sequence numbers and remarks survive saving and loading', () => {
  const { net, t } = office();
  t.run(`conf t
    access-list 1 permit 192.168.1.0 0.0.0.255
    ip access-list extended FILES-OUT
    remark keep guests off the website
    15 deny tcp host 192.168.1.50 host 192.168.99.10 eq 80
    40 permit ip any any
    int g0/1
    ip access-group FILES-OUT out
    end`);
  const copy = loadNetwork(JSON.parse(JSON.stringify(serializeNetwork(net))), new Network());
  const r = copy.findDevice('R1');
  assert.equal(r.getIface('GigabitEthernet0/1').aclOut, 'FILES-OUT');
  assert.equal(r.acl.typeOf('FILES-OUT'), 'extended');
  assert.deepEqual(r.acl.lists.get('FILES-OUT').map((x) => [x.seq, x.action]), [[10, 'remark'], [15, 'deny'], [40, 'permit']]);
  assert.equal(r.acl.lists.get('FILES-OUT')[0].text, 'keep guests off the website');
  assert.deepEqual(r.acl.lists.get(1).map((x) => x.seq), [10]);
  assert.equal(browse(copy, 'Guest', 'http://192.168.99.10/')?.status, undefined);
  assert.equal(browse(copy, 'Staff', 'http://192.168.99.10/')?.status, 200);
});

test('files saved before named lists still load, with lines numbered 10, 20, 30', () => {
  const { net, r1 } = office();
  const data = JSON.parse(JSON.stringify(serializeNetwork(net)));
  const dev = data.devices.find((d) => d.name === 'R1');
  const cfg = dev.config;
  // the old format: [number, rules without sequence numbers], and access groups as numbers
  cfg.acls = [[10, [{ action: 'deny', src: { ip: '192.168.1.50', wildcard: '0.0.0.0' } }, { action: 'permit', src: { any: true } }]]];
  const g1 = cfg.ifaces.find((i) => i.name === 'GigabitEthernet0/1');
  g1.aclOut = 10;
  const copy = loadNetwork(data, new Network());
  const r = copy.findDevice('R1');
  assert.deepEqual(r.acl.lists.get(10).map((x) => x.seq), [10, 20]);
  assert.equal(r.getIface('GigabitEthernet0/1').aclOut, 10);
  assert.match(pings(copy, 'Guest', '192.168.99.10'), /Destination host unreachable/);
  assert.match(pings(copy, 'Staff', '192.168.99.10'), /Received = 4/);
  assert.ok(r1);
});

test('every access list edit tells the app the configuration changed, so it is autosaved', () => {
  const { net, t } = office();
  let n = 0;
  net.on('config', () => { n++; });
  const steps = [
    'conf t',
    'ip access-list extended EDGE',
    'permit ip any any',
    '5 deny icmp any any',
    'no 5',
    'deny udp any any',
    'no deny udp any any',
    'exit',
    'ip access-list resequence EDGE 1 1',
    'access-list 10 permit any',
    'no access-list 10',
    'interface g0/1',
    'ip access-group EDGE out',
    'no ip access-group EDGE out',
    'exit',
    'no ip access-list extended EDGE',
  ];
  const counts = steps.map((line) => { const before = n; t.run(line); return n > before; });
  assert.deepEqual(counts, [false, ...steps.slice(1).map((l) => l !== 'exit' && l !== 'interface g0/1')]);
  // failed edits do not
  const before = n;
  t.run('ip access-list standard S\nexit');
  const mid = n;
  t.run('ip access-list standard S\n10 permit any\n10 deny any\nno 99\nend');
  assert.equal(mid - before, 1);
  assert.equal(n - mid, 1);
});
