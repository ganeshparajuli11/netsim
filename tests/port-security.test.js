import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Network } from '../src/engine/network.js';
import { createDevice, serializeNetwork, loadNetwork } from '../src/engine/factory.js';
import { parseMac } from '../src/engine/portsec.js';
import { formatMac } from '../src/engine/util.js';
import { ios, cmd } from './helpers.js';

/** Office PC on Fa0/1, server on Fa0/2, and a spare PC (the "intruder") not cabled yet. */
function office() {
  const net = new Network();
  const sw = createDevice(net, 'switch', { name: 'S1' });
  const pc = createDevice(net, 'pc', { name: 'Office' });
  const srv = createDevice(net, 'server', { name: 'Srv' });
  const rogue = createDevice(net, 'laptop', { name: 'Rogue' });
  net.connect(pc.getPort('FastEthernet0'), sw.getPort('FastEthernet0/1'));
  net.connect(srv.getPort('FastEthernet0'), sw.getPort('FastEthernet0/2'));
  pc.setStatic({ ip: '192.168.1.10', mask: '255.255.255.0' });
  srv.setStatic({ ip: '192.168.1.100', mask: '255.255.255.0' });
  rogue.setStatic({ ip: '192.168.1.66', mask: '255.255.255.0' });
  net.settle(500);
  const t = ios(sw);
  t.run('en');
  return { net, sw, pc, srv, rogue, t };
}

const ping = (net, host, ip) => cmd(host).run(`ping ${ip}`, net);
const ok = (out) => /Received = [1-9]/.test(out);

/** Swaps whatever is on Fa0/1 for the rogue laptop. */
function swapIn(net, sw, rogue) {
  const p = sw.getPort('FastEthernet0/1');
  net.disconnect(p.link.id);
  net.connect(rogue.getPort('FastEthernet0'), p);
}

test('parseMac accepts the usual notations and refuses multicast', () => {
  assert.equal(parseMac('0001.0203.0a0b'), '0001.0203.0A0B');
  assert.equal(parseMac('00:01:02:03:0a:0b'), '0001.0203.0A0B');
  assert.equal(parseMac('00-01-02-03-0A-0B'), '0001.0203.0A0B');
  assert.equal(parseMac('0100.5e00.0001'), null);
  assert.equal(parseMac('0001.0203'), null);
  assert.equal(parseMac('sticky'), null);
});

test('sticky learning keeps the first address and err-disables the port for another one', () => {
  const { net, sw, pc, srv, rogue, t } = office();
  t.run(`conf t
    int f0/1
    switchport mode access
    switchport port-security
    switchport port-security mac-address sticky
    end`);
  assert.ok(ok(ping(net, pc, '192.168.1.100')));
  const port = sw.getPort('FastEthernet0/1');
  assert.deepEqual(port.sw.portSecurity.addresses, [{ mac: pc.nic.mac, type: 'sticky' }]);
  const run = t.run('show running-config');
  assert.match(run, new RegExp(`switchport port-security mac-address sticky ${formatMac(pc.nic.mac)}`));
  assert.match(run, /interface FastEthernet0\/1\n switchport mode access\n switchport port-security\n switchport port-security mac-address sticky\n/);

  swapIn(net, sw, rogue);
  // the sticky address survived the link going down
  assert.equal(port.sw.portSecurity.addresses.length, 1);
  assert.ok(!ok(ping(net, rogue, '192.168.1.100')));
  assert.equal(port.errDisabled, true);
  assert.equal(port.isUp(), false);
  assert.equal(rogue.nic.port.isUp(), false, 'the far end sees the link go down too');
  assert.ok(sw.consoleLines.some((l) => l.includes('%PM-4-ERR_DISABLE: psecure-violation error detected on Fa0/1')));
  assert.ok(sw.consoleLines.some((l) => l.includes(`caused by MAC address ${formatMac(rogue.nic.mac)} on port FastEthernet0/1`)));

  assert.match(t.run('show interfaces status'), /Fa0\/1 +err-disabled/);
  assert.match(t.run('show interfaces f0/1'), /FastEthernet0\/1 is down, line protocol is down \(err-disabled\)/);
  const brief = t.run('show port-security');
  assert.match(brief, /Fa0\/1 +1 +1 +1 +Shutdown/);
  const detail = t.run('show port-security interface f0/1');
  assert.match(detail, /Port Status +: Secure-shutdown/);
  assert.match(detail, /Sticky MAC Addresses +: 1/);
  assert.match(detail, /Security Violation Count +: 1/);
  assert.match(detail, new RegExp(`Last Source Address:Vlan +: ${formatMac(rogue.nic.mac)}:1`));

  // no shutdown alone does nothing; shutdown then no shutdown recovers the port
  t.run('conf t\nint f0/1\nno shutdown');
  assert.equal(port.errDisabled, true);
  t.run('shutdown\nno shutdown\nend');
  assert.equal(port.errDisabled, false);
  assert.equal(port.isUp(), true);
  // the rogue is still not allowed, so it trips the port again
  ping(net, rogue, '192.168.1.100');
  assert.equal(port.errDisabled, true);
  void srv;
});

test('restrict drops and counts violations, protect drops quietly, and both keep the port up', () => {
  for (const mode of ['restrict', 'protect']) {
    const { net, sw, pc, srv, t } = office();
    const hub = createDevice(net, 'hub', { name: 'Hub' });
    const extra = createDevice(net, 'pc', { name: 'Extra' });
    const p = sw.getPort('FastEthernet0/1');
    net.disconnect(p.link.id);
    net.connect(hub.ports[0], p);
    net.connect(pc.getPort('FastEthernet0'), hub.ports[1]);
    net.connect(extra.getPort('FastEthernet0'), hub.ports[2]);
    extra.setStatic({ ip: '192.168.1.20', mask: '255.255.255.0' });
    net.settle(500);
    t.run(`conf t
      int f0/1
      switchport port-security
      switchport port-security violation ${mode}
      end`);
    assert.ok(ok(ping(net, pc, '192.168.1.100')), `${mode}: the first host is learned`);
    assert.ok(!ok(ping(net, extra, '192.168.1.100')), `${mode}: the second host is over the maximum`);
    assert.equal(p.errDisabled, false);
    assert.equal(p.isUp(), true);
    assert.ok(ok(ping(net, pc, '192.168.1.100')), `${mode}: the secure host still works`);
    const ps = p.sw.portSecurity;
    const logged = sw.consoleLines.some((l) => l.includes('PSECURE_VIOLATION'));
    if (mode === 'restrict') { assert.ok(ps.violations > 0); assert.ok(logged); } else { assert.equal(ps.violations, 0); assert.ok(!logged); }
    assert.match(t.run('show port-security'), new RegExp(`Fa0/1 +1 +1 +\\d+ +${mode[0].toUpperCase()}${mode.slice(1)}`));

    // raising the maximum lets the second host in
    t.run('conf t\nint f0/1\nswitchport port-security maximum 2\nend');
    assert.ok(ok(ping(net, extra, '192.168.1.100')), `${mode}: maximum 2 admits the second host`);
    assert.equal(ps.addresses.length, 2);
    assert.ok(ps.addresses.every((a) => a.type === 'dynamic'));
    void srv;
  }
});

test('dynamic secure addresses are forgotten when the link goes down', () => {
  const { net, sw, pc, rogue, t } = office();
  t.run('conf t\nint f0/1\nswitchport port-security\nend');
  ping(net, pc, '192.168.1.100');
  const port = sw.getPort('FastEthernet0/1');
  assert.equal(port.sw.portSecurity.addresses[0].type, 'dynamic');
  assert.doesNotMatch(t.run('show running-config'), /mac-address/);
  swapIn(net, sw, rogue);
  assert.equal(port.sw.portSecurity.addresses.length, 0);
  assert.ok(ok(ping(net, rogue, '192.168.1.100')), 'a new host is learned in place of the old one');
  assert.equal(port.errDisabled, false);
});

test('a static secure address admits only that host, and shows as STATIC in the MAC table', () => {
  const { net, sw, pc, rogue, t } = office();
  const out = t.run(`conf t
    int f0/1
    switchport port-security
    switchport port-security mac-address ${formatMac(pc.nic.mac)}
    switchport port-security mac-address 0000.1111.2222
    end`);
  assert.match(out, /already has its maximum of 1 secure address/);
  const port = sw.getPort('FastEthernet0/1');
  assert.deepEqual(port.sw.portSecurity.addresses, [{ mac: pc.nic.mac, type: 'static' }]);
  assert.match(t.run('show mac address-table'), new RegExp(`${formatMac(pc.nic.mac)} +STATIC +Fa0/1`));
  assert.match(t.run('show port-security address'), new RegExp(`${formatMac(pc.nic.mac)} +SecureConfigured +Fa0/1`));
  assert.match(t.run('show port-security interface f0/1'), /Configured MAC Addresses +: 1/);
  assert.match(t.run('show running-config'), new RegExp(` switchport port-security mac-address ${formatMac(pc.nic.mac)}\n`));
  assert.ok(ok(ping(net, pc, '192.168.1.100')));
  swapIn(net, sw, rogue);
  ping(net, rogue, '192.168.1.100');
  assert.equal(port.errDisabled, true);

  // lowering the maximum below the configured addresses is refused
  assert.match(t.run('conf t\nint f0/2\nswitchport port-security maximum 2\nswitchport port-security mac-address 0000.1111.2222\nswitchport port-security mac-address 0000.1111.3333\nswitchport port-security maximum 1\nend'), /already has 2 configured secure addresses/);
  assert.equal(sw.getPort('FastEthernet0/2').sw.portSecurity.maximum, 2);
  // the same address can't be secured on two ports in one VLAN
  assert.match(t.run(`conf t\nint f0/3\nswitchport port-security mac-address 0000.1111.2222\nend`), /already a secure address on FastEthernet0\/2/);
  // and removing one works
  t.run('conf t\nint f0/2\nno switchport port-security mac-address 0000.1111.3333\nend');
  assert.equal(sw.getPort('FastEthernet0/2').sw.portSecurity.addresses.length, 1);
});

test('port security is refused on trunks, and a secure port cannot become a trunk', () => {
  const { sw, t } = office();
  let out = t.run('conf t\nint f0/5\nswitchport mode trunk\nswitchport port-security\nend');
  assert.match(out, /is a trunk port/);
  assert.equal(sw.getPort('FastEthernet0/5').sw.portSecurity.enabled, false);
  out = t.run('conf t\nint f0/6\nswitchport port-security\nswitchport mode trunk\nend');
  assert.match(out, /has port security on/);
  assert.equal(sw.getPort('FastEthernet0/6').sw.mode, 'access');
  t.run('conf t\nint f0/6\nno switchport port-security\nswitchport mode trunk\nend');
  assert.equal(sw.getPort('FastEthernet0/6').sw.mode, 'trunk');
  assert.match(t.run('conf t\nint f0/7\nswitchport port-security mac-address 0100.5e00.0001\nend'), /Invalid MAC address/);
});

test('turning sticky off makes learned addresses dynamic again', () => {
  const { net, sw, pc, t } = office();
  t.run('conf t\nint f0/1\nswitchport port-security\nswitchport port-security mac-address sticky\nend');
  ping(net, pc, '192.168.1.100');
  const ps = sw.getPort('FastEthernet0/1').sw.portSecurity;
  assert.equal(ps.addresses[0].type, 'sticky');
  t.run('conf t\nint f0/1\nno switchport port-security mac-address sticky\nend');
  assert.equal(ps.addresses[0].type, 'dynamic');
  assert.doesNotMatch(t.run('show running-config'), /mac-address/);
  // turning it on again keeps the address it already learned
  t.run('conf t\nint f0/1\nswitchport port-security mac-address sticky\nend');
  assert.equal(ps.addresses[0].type, 'sticky');
});

test('the packet inspector explains learning and violations', () => {
  const { net, pc, rogue, sw, t } = office();
  t.run('conf t\nint f0/1\nswitchport port-security\nswitchport port-security mac-address sticky\nend');
  net.recording = true;
  ping(net, pc, '192.168.1.100');
  swapIn(net, sw, rogue);
  ping(net, rogue, '192.168.1.100');
  const notes = net.events.flatMap((e) => e.notes);
  assert.ok(notes.some((n) => /port security on Fa0\/1: learned .* as a sticky secure address \(1 of 1\)/.test(n)));
  assert.ok(notes.some((n) => /port security violation on Fa0\/1: .* not a secure address .* Mode shutdown/.test(n)));
});

test('port security settings, sticky addresses and err-disabled state survive save and load', () => {
  const { net, sw, pc, rogue, t } = office();
  t.run(`conf t
    int f0/1
    switchport port-security
    switchport port-security maximum 3
    switchport port-security violation shutdown
    switchport port-security mac-address sticky
    switchport port-security mac-address 0000.aaaa.bbbb
    int f0/2
    switchport port-security
    switchport port-security violation restrict
    end`);
  ping(net, pc, '192.168.1.100');
  const data = JSON.parse(JSON.stringify(serializeNetwork(net)));
  const net2 = loadNetwork(data);
  const sw2 = net2.findDevice('S1');
  const ps = sw2.getPort('FastEthernet0/1').sw.portSecurity;
  assert.equal(ps.enabled, true);
  assert.equal(ps.maximum, 3);
  assert.equal(ps.sticky, true);
  assert.deepEqual(ps.addresses.map((a) => a.type).sort(), ['static', 'sticky']);
  const ps2 = sw2.getPort('FastEthernet0/2').sw.portSecurity;
  assert.equal(ps2.violation, 'restrict');
  assert.equal(ps2.addresses.length, 0, 'dynamic addresses are not saved');

  // err-disabled is kept too
  const one = office();
  one.t.run('conf t\nint f0/1\nswitchport port-security\nswitchport port-security mac-address sticky\nend');
  ping(one.net, one.pc, '192.168.1.100');
  swapIn(one.net, one.sw, one.rogue);
  ping(one.net, one.rogue, '192.168.1.100');
  const net3 = loadNetwork(JSON.parse(JSON.stringify(serializeNetwork(one.net))));
  const p3 = net3.findDevice('S1').getPort('FastEthernet0/1');
  assert.equal(p3.errDisabled, true);
  assert.equal(p3.isUp(), false);
  void sw; void rogue;
});

test('switch files saved before port security still load with it off', () => {
  const { net } = office();
  const data = JSON.parse(JSON.stringify(serializeNetwork(net)));
  for (const d of data.devices) {
    if (d.type !== 'switch') continue;
    for (const p of d.config.ports) { delete p.portSecurity; delete p.errDisabled; }
  }
  const net2 = loadNetwork(data);
  const sw2 = net2.findDevice('S1');
  for (const p of sw2.ports) {
    assert.equal(p.sw.portSecurity.enabled, false);
    assert.equal(p.sw.portSecurity.maximum, 1);
    assert.equal(p.errDisabled, false);
  }
  const pc = net2.findDevice('Office');
  assert.ok(ok(ping(net2, pc, '192.168.1.100')));
});

test('erase and reload resets port security', () => {
  const { sw, t } = office();
  t.run('conf t\nint f0/1\nswitchport port-security\nend');
  sw.resetConfig();
  assert.equal(sw.getPort('FastEthernet0/1').sw.portSecurity.enabled, false);
});

test('an abbreviated keyword wins over a MAC address placeholder', () => {
  const { sw, t } = office();
  const out = t.run('conf t\nint f0/1\nswitchport port-security mac-address stick\nswitchport port-sec viol rest\nend');
  assert.doesNotMatch(out, /% (Ambiguous|Invalid|Incomplete)/);
  assert.equal(sw.getPort('FastEthernet0/1').sw.portSecurity.sticky, true);
  assert.equal(sw.getPort('FastEthernet0/1').sw.portSecurity.violation, 'restrict');
});
