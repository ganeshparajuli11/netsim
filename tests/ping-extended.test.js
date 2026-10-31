import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice } from '../src/engine/factory.js';
import { ipLength, IP_MTU } from '../src/engine/l3.js';
import { ios, cmd } from './helpers.js';

/** PC A (10.1.0.10) – R1 G0/0 | R1 G0/1 – R2 G0/0 (10.12.0.0/30) | R2 G0/1 – PC B (10.2.0.10). */
function chain() {
  const net = new Network();
  const r1 = createDevice(net, 'router', { name: 'R1' });
  const r2 = createDevice(net, 'router', { name: 'R2' });
  const a = createDevice(net, 'pc', { name: 'A' });
  const b = createDevice(net, 'pc', { name: 'B' });
  net.connect(a.getPort('FastEthernet0'), r1.getPort('GigabitEthernet0/0'));
  net.connect(r1.getPort('GigabitEthernet0/1'), r2.getPort('GigabitEthernet0/0'));
  net.connect(r2.getPort('GigabitEthernet0/1'), b.getPort('FastEthernet0'));
  ios(r1).run(`en
    conf t
    int g0/0
    ip add 10.1.0.1 255.255.255.0
    no shut
    int g0/1
    ip add 10.12.0.1 255.255.255.252
    no shut
    exit
    ip route 10.2.0.0 255.255.255.0 10.12.0.2
    end`);
  ios(r2).run(`en
    conf t
    int g0/0
    ip add 10.12.0.2 255.255.255.252
    no shut
    int g0/1
    ip add 10.2.0.1 255.255.255.0
    no shut
    exit
    ip route 10.1.0.0 255.255.255.0 10.12.0.1
    end`);
  a.setStatic({ ip: '10.1.0.10', mask: '255.255.255.0', gateway: '10.1.0.1' });
  b.setStatic({ ip: '10.2.0.10', mask: '255.255.255.0', gateway: '10.2.0.1' });
  net.settle(500);
  // warm up ARP everywhere so the first echoes are not lost
  cmd(a).run('ping 10.2.0.10', net);
  return { net, r1, r2, a, b };
}

/** Runs router CLI lines and lets the network run until the ping is done. */
function routerRun(net, c, lines) {
  let buf = '';
  c.cli.out = (t) => { buf += t; };
  for (const l of lines.split('\n').map((x) => x.trim())) c.cli.exec(l);
  net.settle(120000);
  return buf;
}

/** Answers the extended ping questions one by one, recording each question asked. */
function dialogue(net, c, answers) {
  const asked = [];
  let buf = '';
  c.cli.out = (t) => { buf += t; };
  c.cli.exec('ping');
  for (const a of answers) {
    asked.push(c.cli.prompt());
    c.cli.exec(a);
  }
  net.settle(120000);
  return { asked, out: buf, cli: c.cli };
}

test('packet length counts the IP and ICMP headers', () => {
  assert.equal(IP_MTU, 1500);
  assert.equal(ipLength({ proto: 'ICMP', payload: { type: 8, size: 72 } }), 100);
  assert.equal(ipLength({ proto: 'ICMP', payload: { type: 8, size: 1472 } }), 1500);
  assert.equal(ipLength({ proto: 'UDP', payload: {} }), 20);
});

test('one-line router ping takes repeat, size, timeout and source in any order', () => {
  const { net, r1 } = chain();
  const c = ios(r1);
  c.run('en');
  let o = routerRun(net, c, 'ping 10.2.0.10 repeat 3 size 500');
  assert.match(o, /Sending 3, 500-byte ICMP Echos to 10\.2\.0\.10, timeout is 2 seconds:/);
  assert.match(o, /!!!\nSuccess rate is 100 percent \(3\/3\)/);
  o = routerRun(net, c, 'ping 10.2.0.10 timeout 1 source g0/0 rep 2');
  assert.match(o, /timeout is 1 seconds/);
  assert.match(o, /Packet sent with a source address of 10\.1\.0\.1\n/);
  assert.match(o, /Success rate is 100 percent \(2\/2\)/);
  o = routerRun(net, c, 'ping 10.2.0.10 source 10.12.0.1 repeat 1');
  assert.match(o, /source address of 10\.12\.0\.1/);
  // the echo carries the size: 500-byte datagram = 472 bytes of data
  let seen = null;
  const orig = r1.handleIcmp.bind(r1);
  r1.handleIcmp = (iface, pkt) => { if (pkt.payload.type === 0) seen = pkt; return orig(iface, pkt); };
  routerRun(net, c, 'ping 10.2.0.10 size 500 repeat 1');
  assert.equal(seen.payload.size, 472);
  assert.equal(ipLength(seen), 500);
});

test('router ping refuses bad option values and keeps the keyword errors', () => {
  const { net, r1 } = chain();
  const c = ios(r1);
  c.run('en');
  assert.match(routerRun(net, c, 'ping 10.2.0.10 size 20'), /% A decimal number between 36 and 18024\./);
  assert.match(routerRun(net, c, 'ping 10.2.0.10 size 20000'), /between 36 and 18024/);
  assert.match(routerRun(net, c, 'ping 10.2.0.10 repeat 0'), /between 1 and 2147483647/);
  assert.match(routerRun(net, c, 'ping 10.2.0.10 timeout 4000'), /between 0 and 3600/);
  assert.match(routerRun(net, c, 'ping 10.2.0.10 source 10.99.0.1'), /% Invalid source address/);
  assert.match(routerRun(net, c, 'ping 10.2.0.10 s 100'), /% Ambiguous command/);
  assert.match(routerRun(net, c, 'ping 10.2.0.10 repeat 2 repeat 3'), /% Invalid input detected/);
  // ? lists every option
  const help = c.cli.help('ping 10.2.0.10 ');
  for (const w of ['repeat', 'size', 'source', 'timeout', 'df-bit', '<cr>']) assert.ok(help.includes(w), help);
  assert.match(help, /df-bit\s+Set the Don't Fragment bit/);
  // after one option, the rest are still offered
  const rest = c.cli.help('ping 10.2.0.10 repeat 3 ');
  assert.ok(rest.includes('size') && !rest.includes('repeat'), rest);
});

test('extended ping asks each question and uses the answers', () => {
  const { net, r1 } = chain();
  const c = ios(r1);
  c.run('en');
  const { asked, out, cli } = dialogue(net, c, ['', '10.2.0.10', '3', '200', '1', 'y', 'g0/0', 'no']);
  assert.deepEqual(asked, [
    'Protocol [ip]: ', 'Target IP address: ', 'Repeat count [5]: ', 'Datagram size [100]: ',
    'Timeout in seconds [2]: ', 'Extended commands [n]: ', 'Source address or interface: ', 'Set DF bit in IP header? [no]: ',
  ]);
  assert.match(out, /Sending 3, 200-byte ICMP Echos to 10\.2\.0\.10, timeout is 1 seconds:/);
  assert.match(out, /source address of 10\.1\.0\.1/);
  assert.match(out, /Success rate is 100 percent \(3\/3\)/);
  assert.equal(cli.dialog, null);
  assert.equal(cli.prompt(), 'R1#');
  // answers are not saved in the command history
  assert.ok(!cli.history.includes('10.2.0.10'));
});

test('extended ping uses the defaults and skips the extended questions', () => {
  const { net, r1 } = chain();
  const c = ios(r1);
  c.run('en');
  const { asked, out } = dialogue(net, c, ['ip', '10.2.0.10', '', '', '', '']);
  assert.equal(asked.length, 6);
  assert.match(out, /Sending 5, 100-byte ICMP Echos to 10\.2\.0\.10, timeout is 2 seconds:/);
  assert.match(out, /Success rate is 100 percent \(5\/5\)/);
});

test('extended ping stops at a bad answer', () => {
  const { net, r1 } = chain();
  const c = ios(r1);
  c.run('en');
  let r = dialogue(net, c, ['', 'banana']);
  assert.match(r.out, /% Bad IP address/);
  assert.equal(r.cli.dialog, null);
  r = dialogue(net, c, ['', '10.2.0.10', '', '10']);
  assert.match(r.out, /% A decimal number between 36 and 18024\./);
  assert.doesNotMatch(r.out, /Sending/);
  r = dialogue(net, c, ['ipx']);
  assert.match(r.out, /% Unknown protocol "ipx"/);
  r = dialogue(net, c, ['', '10.2.0.10', '', '', '', 'y', 'g0/9']);
  assert.match(r.out, /% Invalid source address or interface/);
  r = dialogue(net, c, ['', '10.2.0.10', '', '', '', 'maybe']);
  assert.match(r.out, /answer 'yes' or 'no'/);
  // Ctrl+C in the terminal drops the dialogue
  c.cli.exec('ping');
  assert.equal(c.cli.prompt(), 'Protocol [ip]: ');
  c.cli.abortDialog();
  assert.equal(c.cli.prompt(), 'R1#');
});

test('extended ping is only offered in privileged mode', () => {
  const { r1 } = chain();
  const c = ios(r1);
  assert.match(c.run('ping'), /% Incomplete command/);
  assert.equal(c.cli.dialog, null);
});

test('DF bit: a router drops a packet too big for the next link and says so', () => {
  const { net, r1, r2 } = chain();
  const c = ios(r1);
  c.run('en');
  // fits the 1500-byte MTU exactly
  let o = routerRun(net, c, 'ping 10.2.0.10 size 1500 df-bit repeat 2');
  assert.match(o, /Packet sent with the DF bit set/);
  assert.match(o, /!!\n/);
  // too big to leave R1 with DF set: refused locally
  o = routerRun(net, c, 'ping 10.2.0.10 size 1501 df-bit repeat 3');
  assert.match(o, /MMM\nSuccess rate is 0 percent \(0\/3\)/);
  // without DF it would be fragmented, and still arrives; both routers explain the fragmenting
  const explained = [];
  for (const r of [r1, r2]) {
    const origExplain = r.explain.bind(r);
    r.explain = (t) => { explained.push(t); return origExplain(t); };
  }
  o = routerRun(net, c, 'ping 10.2.0.10 size 4000 repeat 2');
  assert.match(o, /!!\nSuccess rate is 100 percent/);
  assert.ok(explained.some((t) => /4000-byte packet is larger than the 1500-byte MTU of GigabitEthernet0\/1, so it would be split into 3 fragments/.test(t)), explained.join('\n'));
});

test('PC ping -l sets the data size and -f the DF bit', () => {
  const { net, a } = chain();
  let o = cmd(a).run('ping -n 2 -l 1000 10.2.0.10', net);
  assert.match(o, /Pinging 10\.2\.0\.10 with 1000 bytes of data:/);
  assert.match(o, /Reply from 10\.2\.0\.10: bytes=1000 time/);
  assert.match(o, /Received = 2/);
  // 1472 bytes of data + 28 bytes of headers = 1500: fits with DF set
  o = cmd(a).run('ping -n 1 -f -l 1472 10.2.0.10', net);
  assert.match(o, /bytes=1472/);
  // one byte more can't leave the PC with DF set
  o = cmd(a).run('ping -n 2 -f -l 1473 10.2.0.10', net);
  assert.match(o, /Packet needs to be fragmented but DF set\.\nPacket needs to be fragmented but DF set\./);
  assert.match(o, /Lost = 2/);
  // without -f it is fragmented and gets through
  o = cmd(a).run('ping -n 1 -l 3000 10.2.0.10', net);
  assert.match(o, /bytes=3000/);
});

test('a router answers a too-big DF packet with ICMP fragmentation needed', () => {
  const { net, r1, a } = chain();
  // A's own link is fine; force the check at R1 by sending a DF packet that only R1 must judge:
  // send it from A straight onto the wire with a size that exceeds the MTU on R1's way out.
  const explained = [];
  const origExplain = r1.explain.bind(r1);
  r1.explain = (t) => { explained.push(t); return origExplain(t); };
  // bypass A's own MTU check so the packet reaches R1 (as from a host with a bigger MTU)
  a.fitsMtu = () => true;
  const o = cmd(a).run('ping -n 2 -f -l 1600 10.2.0.10', net);
  assert.match(o, /Reply from 10\.1\.0\.1: Packet needs to be fragmented but DF set\./, o);
  assert.ok(explained.some((t) => /Don't Fragment bit set; dropping it and sending ICMP "fragmentation needed" to 10\.1\.0\.10/.test(t)), explained.join('\n'));
});

test('the echo reply keeps the request DF bit and size', () => {
  const { net, b, a } = chain();
  let reply = null;
  const orig = a.handleIcmp.bind(a);
  a.handleIcmp = (iface, pkt) => { if (pkt.payload.type === 0) reply = pkt; return orig(iface, pkt); };
  cmd(a).run('ping -n 1 -f -l 600 10.2.0.10', net);
  assert.equal(reply.df, true);
  assert.equal(reply.payload.size, 600);
  void b;
});

test('PC ping explains bad flags and supports -i and -w', () => {
  const { net, a } = chain();
  assert.match(cmd(a).run('ping -l 70000 10.2.0.10', net), /Bad value for option -l, valid range is from 0 to 65500\./);
  assert.match(cmd(a).run('ping -n', net), /Value must be supplied for option -n\./);
  assert.match(cmd(a).run('ping -x 10.2.0.10', net), /Bad option -x\./);
  // TTL 1 expires at the first router
  const o = cmd(a).run('ping -n 1 -i 1 10.2.0.10', net);
  assert.match(o, /Reply from 10\.1\.0\.1: TTL expired in transit\./);
  assert.match(cmd(a).run('ping -n 1 -w 500 10.1.0.99', net), /Request timed out./);
  assert.match(cmd(a).run('help', net), /-l size/);
});
