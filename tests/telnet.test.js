import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice, serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { defaultVty, loadVty, VTY_LINES } from '../src/engine/telnet.js';
import { ios, cmd } from './helpers.js';

/** Admin PC (10.1.0.10) – R1 G0/0 | R1 G0/1 – S1 Fa0/1, S1 management SVI 10.2.0.2, PC B (10.2.0.10) on S1 Fa0/2. */
function lab() {
  const net = new Network();
  const r1 = createDevice(net, 'router', { name: 'R1' });
  const s1 = createDevice(net, 'switch', { name: 'S1' });
  const admin = createDevice(net, 'pc', { name: 'Admin' });
  const b = createDevice(net, 'pc', { name: 'B' });
  net.connect(admin.getPort('FastEthernet0'), r1.getPort('GigabitEthernet0/0'));
  net.connect(r1.getPort('GigabitEthernet0/1'), s1.getPort('FastEthernet0/1'));
  net.connect(b.getPort('FastEthernet0'), s1.getPort('FastEthernet0/2'));
  ios(r1).run(`en
    conf t
    int g0/0
    ip add 10.1.0.1 255.255.255.0
    no shut
    int g0/1
    ip add 10.2.0.1 255.255.255.0
    no shut
    end`);
  ios(s1).run(`en
    conf t
    int vlan 1
    ip add 10.2.0.2 255.255.255.0
    no shut
    exit
    ip default-gateway 10.2.0.1
    end`);
  admin.setStatic({ ip: '10.1.0.10', mask: '255.255.255.0', gateway: '10.1.0.1' });
  b.setStatic({ ip: '10.2.0.10', mask: '255.255.255.0', gateway: '10.2.0.1' });
  net.settle(5000);
  return { net, r1, s1, admin, b };
}

function vty(dev, lines) {
  ios(dev).run(`en\nconf t\nline vty 0 4\n${lines}\nend`);
}

test('vty lines ask for a password by default, so a router without one refuses Telnet', () => {
  const { net, admin } = lab();
  const c = cmd(admin);
  const out = c.run('telnet 10.1.0.1', net);
  assert.match(out, /^Trying 10\.1\.0\.1 \.\.\.Open/);
  assert.match(out, /Password required, but none set/);
  assert.match(out, /\[Connection to 10\.1\.0\.1 closed by foreign host\]/);
  assert.equal(c.cli.prompt(), 'C:\\>');
  assert.equal(c.cli.busy, null);
});

test('login with the vty password, then enable, configure and log out remotely', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'password class\nlogin');
  ios(r1).run('en\nconf t\nenable secret topsecret\nbanner motd #Authorised staff only#\nend');
  const c = cmd(admin);
  let out = c.run('telnet 10.1.0.1', net);
  assert.match(out, /Authorised staff only/);
  assert.match(out, /User Access Verification\n\nPassword: $/);
  assert.equal(c.cli.awaitPassword, true, 'the terminal hides the password');

  out = c.run('class', net);
  assert.equal(c.cli.prompt(), 'R1>');
  assert.equal(c.cli.awaitPassword, false);
  assert.equal(c.cli.busy, null);

  c.run('enable', net);
  assert.equal(c.cli.awaitPassword, true);
  c.run('topsecret', net);
  assert.equal(c.cli.prompt(), 'R1#');

  out = c.run('show users', net);
  assert.match(out, /\*\s+vty 0\s+10\.1\.0\.10\s+privileged EXEC/);

  c.run('configure terminal', net);
  assert.equal(c.cli.mode, 'config');
  c.run('hostname EDGE', net);
  assert.equal(c.cli.prompt(), 'EDGE(config)#');
  assert.equal(r1.hostname, 'EDGE', 'the command changed the real router');
  out = c.run('end', net);
  assert.match(out, /Configured from console by vty0 \(10\.1\.0\.10\)/);

  out = c.run('exit', net);
  assert.match(out, /\[Connection to 10\.1\.0\.1 closed by foreign host\]/);
  assert.equal(c.cli.prompt(), 'C:\\>');
  assert.equal(r1.telnet.sessions.size, 0, 'the vty line is free again');
  assert.match(c.run('ipconfig', net), /IPv4 Address/, 'back at the local prompt');
});

test('enable over Telnet needs an enable password; the console does not', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'no login');
  const c = cmd(admin);
  c.run('telnet 10.1.0.1', net);
  assert.equal(c.cli.prompt(), 'R1>', 'no login lets the user straight in');
  const out = c.run('enable', net);
  assert.match(out, /% No password set/);
  assert.equal(c.cli.prompt(), 'R1>');
  const con = ios(r1);
  con.run('enable');
  assert.equal(con.cli.mode, 'priv');
});

test('three wrong passwords close the session', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'password class\nlogin');
  const c = cmd(admin);
  c.run('telnet 10.1.0.1', net);
  assert.match(c.run('nope', net), /^Password: $/);
  c.run('wrong', net);
  const out = c.run('again', net);
  assert.match(out, /% Bad passwords/);
  assert.match(out, /closed by foreign host/);
  assert.equal(c.cli.remote, null);
  assert.equal(r1.telnet.sessions.size, 0);
});

test('a switch management address takes Telnet through a router', () => {
  const { net, s1, admin } = lab();
  vty(s1, 'password sw\nlogin');
  const c = cmd(admin);
  c.run('telnet 10.2.0.2', net);
  c.run('sw', net);
  assert.equal(c.cli.prompt(), 'S1>');
  const out = c.run('show ip interface brief', net);
  assert.match(out, /Vlan1\s+10\.2\.0\.2/);
});

test('transport input none or ssh refuses Telnet; a closed port answers with a reset', () => {
  const { net, r1, b, admin } = lab();
  vty(r1, 'password class\nlogin\ntransport input ssh');
  const c = cmd(admin);
  assert.match(c.run('telnet 10.1.0.1', net), /% Connection refused by remote host/);
  assert.match(ios(r1).run('en\nshow running-config'), /line vty 0 4\n password class\n login\n transport input ssh\n/);
  vty(r1, 'transport input none');
  assert.match(c.run('telnet 10.1.0.1', net), /refused/);
  vty(r1, 'transport input telnet ssh');
  assert.equal(r1.vty.transport, 'telnet ssh');
  assert.match(c.run('telnet 10.1.0.1', net), /Password: $/);

  const c2 = cmd(admin);
  assert.match(c2.run('telnet 10.2.0.10', net), /% Connection refused by remote host/, 'a PC runs no Telnet server');
  assert.match(c2.run('telnet 10.1.0.1 2323', net), /Trying 10\.1\.0\.1 port 2323 \.\.\.\n% Connection refused/);
  void b;
});

test('no answer means the connection times out; a bad target is reported', () => {
  const { net, admin } = lab();
  const c = cmd(admin);
  assert.match(c.run('telnet 10.1.0.99', net), /% Connection timed out; remote host not responding/);
  assert.match(c.run('telnet', net), /Usage: telnet <host> \[port\]/);
  assert.match(c.run('telnet 10.1.0.1 99999', net), /Bad port number/);
  admin.setStatic({ ip: '10.1.0.10', mask: '255.255.255.0' });
  assert.match(c.run('telnet 10.9.9.9', net), /% No route to host/);
});

test('an extended access list on the router can block Telnet to the switch behind it', () => {
  const { net, r1, s1, admin } = lab();
  vty(s1, 'password sw\nlogin');
  ios(r1).run(`en
    conf t
    access-list 110 deny tcp any host 10.2.0.2 eq 23
    access-list 110 permit ip any any
    int g0/0
    ip access-group 110 in
    end`);
  const c = cmd(admin);
  assert.match(c.run('telnet 10.2.0.2', net), /timed out/);
  assert.match(cmd(admin).run('ping 10.2.0.2', net), /Received = [34]/, 'ping still works');
  assert.match(ios(r1).run('en\nshow access-lists'), /deny tcp any host 10\.2\.0\.2 eq 23 \(3 match/, 'the SYN and both retries were denied');
});

test('Ctrl+C stops a long remote ping and the session carries on', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'no login');
  const c = cmd(admin);
  c.run('telnet 10.1.0.1', net);
  c.cli.exec('ping 10.1.0.99 repeat 100');
  net.runFor(3000);
  assert.ok(c.cli.busy, 'the PC waits for the remote ping');
  c.cli.cancel();
  net.settle(5000);
  assert.equal(c.cli.busy, null);
  assert.equal(c.cli.prompt(), 'R1>');
  assert.match(c.run('show users', net), /vty 0/);
});

test('the router allows five Telnet sessions at once', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'no login');
  const clients = [];
  for (let i = 0; i < VTY_LINES; i++) {
    const c = cmd(admin);
    c.run('telnet 10.1.0.1', net);
    assert.equal(c.cli.prompt(), 'R1>');
    clients.push(c);
  }
  assert.match(cmd(admin).run('telnet 10.1.0.1', net), /refused/);
  assert.match(ios(r1).run('en\nshow users'), /vty 4\s+10\.1\.0\.10/);
  clients[2].run('logout', net);
  assert.match(cmd(admin).run('telnet 10.1.0.1', net), /Open/);
  assert.match(ios(r1).run('en\nshow users'), /vty 2/);
});

test('reloading the router ends Telnet sessions', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'no login');
  ios(r1).run('en\nwrite memory');
  const c = cmd(admin);
  c.run('telnet 10.1.0.1', net);
  ios(r1).run('en\nreload');
  net.settle(5000);
  assert.equal(c.cli.remote, null);
  assert.match(c.cli.prompt(), /C:\\>/);
});

test('the session explains itself in simulation mode', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'password class\nlogin');
  net.recording = true;
  const c = cmd(admin);
  c.run('telnet 10.1.0.1', net);
  c.run('class', net);
  c.run('exit', net);
  const ev = net.events.filter((e) => e.protocol === 'Telnet');
  const flags = ev.map((e) => e.frame.payload.payload.flags);
  assert.deepEqual(flags.slice(0, 3), ['SYN', 'SYN-ACK', 'ACK'], 'three-way handshake');
  assert.ok(flags.includes('FIN') && flags.includes('FIN-ACK'));
  const notes = ev.flatMap((e) => e.notes).join('\n');
  assert.match(notes, /vty 0 is free, so R1 answers with SYN-ACK/);
  assert.match(notes, /handshake complete/);
  assert.match(notes, /vty password is correct/);
  const pw = ev.find((e) => e.frame.payload.payload.payload?.line === 'class');
  assert.equal(pw.frame.payload.payload.payload.secret, true, 'the password travels in plain text, marked for the inspector');
  assert.match(notes, /plain text/);
  assert.match(ev[0].summary, /^Telnet 10\.1\.0\.10:\d+ → 10\.1\.0\.1:23 SYN$/);
  // sequence numbers count the bytes each side sent
  const syn = ev[0].frame.payload.payload;
  const synAck = ev[1].frame.payload.payload;
  assert.equal(synAck.ack, syn.seq + 1);
});

test('vty settings appear in the running config and survive save and load; old files open with defaults', () => {
  const { net, r1, s1 } = lab();
  vty(r1, 'password class\nno login\ntransport input telnet');
  vty(s1, 'password sw\nlogin');
  assert.match(ios(r1).run('en\nshow running-config'), /line vty 0 4\n password class\n no login\n transport input telnet\n/);
  const saved = JSON.parse(JSON.stringify(serializeNetwork(net)));
  const copy = loadNetwork(saved, new Network());
  assert.deepEqual(copy.findDevice('R1').vty, { login: false, password: 'class', transport: 'telnet' });
  assert.deepEqual(copy.findDevice('S1').vty, { login: true, password: 'sw', transport: 'all' });

  for (const d of saved.devices) delete d.config?.vty;
  const old = loadNetwork(saved, new Network());
  assert.deepEqual(old.findDevice('R1').vty, defaultVty());
  assert.deepEqual(loadVty({ transport: 'carrier pigeon', login: 'yes' }), defaultVty());

  // console line settings don't touch the vty lines
  ios(r1).run('en\nconf t\nline con 0\npassword console\nlogin\nend');
  assert.equal(r1.vty.password, 'class');
  assert.match(ios(r1).run('en\nconf t\nline vty 0 16'), /Vty lines are numbered 0 to 15/);
  assert.match(ios(r1).run('en\nconf t\nline vty 0 4\nlogin local'), /no user accounts yet/);
});

test('Ctrl+C at a remote extended ping question ends the dialogue', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'no login');
  ios(r1).run('en\nconf t\nenable secret top\nend');
  const c = cmd(admin);
  c.run('telnet 10.1.0.1', net);
  c.run('enable', net);
  c.run('top', net);
  c.run('ping', net);
  assert.match(c.cli.prompt(), /Protocol \[ip\]:/);
  c.cli.abortDialog();
  net.settle(5000);
  assert.equal(c.cli.prompt(), 'R1#');
  assert.equal(c.cli.busy, null);
});

test('a handshake that never completes gives its vty line back', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'no login');
  // five SYNs whose senders never finish the handshake
  for (let i = 0; i < VTY_LINES; i++) {
    admin.sendIp({ dst: '10.1.0.1', proto: 'TCP', payload: { srcPort: 40000 + i, dstPort: 23, flags: 'SYN', seq: 1 } });
  }
  net.runFor(100);
  assert.equal(r1.telnet.sessions.size, VTY_LINES);
  net.settle(20000);
  assert.equal(r1.telnet.sessions.size, 0);
  assert.match(cmd(admin).run('telnet 10.1.0.1', net), /Open/);
});

test('Ctrl+C at the login password prompt closes the session', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'password class\nlogin');
  const c = cmd(admin);
  c.run('telnet 10.1.0.1', net);
  assert.equal(c.cli.awaitPassword, true);
  c.cli.abortDialog();
  net.settle(5000);
  assert.equal(c.cli.remote, null);
  assert.equal(c.cli.busy, null);
  assert.equal(r1.telnet.sessions.size, 0);
});

test('a long, quiet remote command keeps the session alive; a dead link is detected', () => {
  const { net, r1, admin } = lab();
  vty(r1, 'no login');
  const c = cmd(admin);
  c.run('telnet 10.1.0.1', net);
  c.cli.exec('ping 10.1.0.99 repeat 1 timeout 60');
  net.runFor(45000);
  assert.ok(c.cli.remote, 'still connected after 45 s of silence from the ping');
  net.settle(60000);
  assert.equal(c.cli.busy, null);
  assert.equal(c.cli.prompt(), 'R1>');

  // the router stops answering: after 30 s the PC gives up
  const p = r1.getPort('GigabitEthernet0/0');
  c.cli.exec('show version');
  p.shutdown = true;
  net.notifyPort(p);
  net.settle(60000);
  assert.equal(c.cli.remote, null);
  assert.match(c.cli.prompt(), /C:\\>/);
});

test('cancelling while the name is looked up does not open a session later', () => {
  const { net, r1, admin, b } = lab();
  vty(r1, 'no login');
  b.setStatic({ ip: '10.2.0.10', mask: '255.255.255.0', gateway: '10.2.0.1' });
  b.dns = { enabled: true, records: [{ name: 'r1.lab', ip: '10.1.0.1' }] };
  admin.setStatic({ ip: '10.1.0.10', mask: '255.255.255.0', gateway: '10.1.0.1', dns: '10.2.0.10' });
  const c = cmd(admin);
  c.cli.exec('telnet r1.lab');
  c.cli.cancel();
  net.settle(10000);
  assert.equal(c.cli.remote, null);
  assert.equal(r1.telnet.sessions.size, 0);
  assert.match(c.run('telnet r1.lab', net), /Trying 10\.1\.0\.1 \.\.\.Open/);
});

test('web requests and port-80 connection attempts to a router are refused cleanly', () => {
  const { net, admin } = lab();
  net.recording = true;
  let res = null;
  admin.httpGet('10.1.0.1', (r) => { res = r; });
  net.settle(5000);
  assert.match(res.error, /refused/);
  assert.match(cmd(admin).run('telnet 10.1.0.1 80', net), /% Connection refused/);
  assert.ok(net.events.some((e) => e.protocol === 'TCP' && /SYN$/.test(e.summary)));
});
