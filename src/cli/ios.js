// IOS-style command line for routers and switches.
// Output formats follow the conventions network students meet in real labs, but all text is
// generated here from the simulator's own state.

import { CommandSet, parseIfName, parseIfRange, tokenize } from './parser.js';
import {
  isValidIp, isValidMask, maskToPrefix, networkOf, inSubnet, ipToInt, formatMac, parseRangeList,
  compressRange, wildcardToMask,
} from '../engine/util.js';
import { addrToString } from '../engine/acl.js';
import { bandwidthKbps } from '../engine/ospf.js';

const CONFIG_MODES = ['config', 'config-if', 'config-subif', 'config-if-range', 'config-vlan', 'dhcp-config', 'config-router', 'config-line'];
const IF_MODES = ['config-if', 'config-subif', 'config-if-range'];
const EXEC = ['user', 'priv'];

export function shortIf(name) {
  return name.replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa').replace(/^Ethernet/, 'Et').replace(/^Vlan/, 'Vlan');
}

function fakeHash(s) {
  let h = 5381;
  for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  const abc = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 22; i++) { out += abc[h % 64]; h = ((h * 1103515245) + 12345) >>> 0; }
  return `$1$${out.slice(0, 4)}$${out.slice(4)}`;
}

function uptime(ms) {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function classful(ip) {
  const f = ipToInt(ip) >>> 24;
  if (f < 128) return { net: networkOf(ip, '255.0.0.0'), prefix: 8 };
  if (f < 192) return { net: networkOf(ip, '255.255.0.0'), prefix: 16 };
  return { net: networkOf(ip, '255.255.255.0'), prefix: 24 };
}

// ------------------------------------------------------------------------------------------
// Command definitions
// ------------------------------------------------------------------------------------------

const C = new CommandSet();

C.describe({
  enable: 'Turn on privileged commands',
  disable: 'Turn off privileged commands',
  configure: 'Enter configuration mode',
  terminal: 'Configure from the terminal',
  show: 'Show running system information',
  ping: 'Send echo messages',
  traceroute: 'Trace route to destination',
  exit: 'Exit from the current mode',
  end: 'Exit to privileged EXEC mode',
  interface: 'Select an interface to configure',
  hostname: 'Set system\'s network name',
  'ip': 'Global IP configuration subcommands',
  'no': 'Negate a command or set its defaults',
  shutdown: 'Shutdown the selected interface',
  'running-config': 'Current operating configuration',
  'startup-config': 'Contents of startup configuration',
  route: 'IP routing table',
  arp: 'ARP table',
  vlan: 'VLAN commands',
  switchport: 'Set switching mode characteristics',
  copy: 'Copy from one file to another',
  write: 'Write running configuration to memory',
  reload: 'Halt and perform a cold restart',
  description: 'Interface specific description',
  encapsulation: 'Set encapsulation type for an interface',
  router: 'Enable a routing process',
  network: 'Enable routing on an IP network',
  'access-list': 'Add an access list entry',
  'mac': 'MAC configuration',
  'cdp': 'CDP information',
  'spanning-tree': 'Spanning Tree Subsystem',
  'do': 'To run exec commands in config mode',
  clear: 'Reset functions',
  banner: 'Define a login banner',
  line: 'Configure a terminal line',
  version: 'System hardware and software status',
  history: 'Display the session command history',
  brief: 'Brief summary',
  dhcp: 'Dynamic Host Configuration Protocol',
  'default-gateway': 'Specify default gateway (if not routing IP)',
  address: 'Set the IP address of an interface',
  'helper-address': 'Specify a destination address for UDP broadcasts',
  'access-group': 'Specify access control for packets',
  mode: 'Set trunking mode of the interface',
  access: 'Set access mode characteristics of the interface',
  trunk: 'Set trunking characteristics of the interface',
  protocols: 'IP routing protocol process parameters and statistics',
  interfaces: 'Interface status and configuration',
  'access-lists': 'List access lists',
  erase: 'Erase a filesystem',
  secret: 'Assign the privileged level secret',
  nat: 'NAT configuration commands',
  translations: 'Translation entries',
  translation: 'Clear dynamic translation entries',
  statistics: 'Translation statistics',
  overload: 'Overload an address translation',
  inside: 'Inside address translation',
  outside: 'Outside address translation',
  password: 'Assign the privileged level password',
});

// ---------- mode navigation ----------
C.add('user', 'enable', function () {
  if (this.d.enableSecret || this.d.enablePassword) {
    this.awaitPassword = { tries: 0 };
    this.print('Password: ');
    return;
  }
  this.mode = 'priv';
});
C.add('priv', 'disable', function () { this.mode = 'user'; });
C.add(EXEC, ['exit', 'logout'], function () {
  this.mode = 'user';
  this.print(`\n${this.d.hostname} con0 is now available\n\nPress RETURN to get started.\n`);
});
C.add('priv', 'configure terminal', function () {
  this.mode = 'config';
  this.print('Enter configuration commands, one per line.  End with CNTL/Z.\n');
});
C.add('priv', 'configure', function () {
  this.mode = 'config';
  this.print('Enter configuration commands, one per line.  End with CNTL/Z.\n');
});
C.add(CONFIG_MODES, 'end', function () { this.mode = 'priv'; this.ctx = {}; this.syslogConfigured(); });
C.add(CONFIG_MODES, 'exit', function () {
  if (this.mode === 'config') { this.mode = 'priv'; this.syslogConfigured(); } else { this.mode = 'config'; }
  this.ctx = {};
});

// ---------- exec ----------
C.add(EXEC, ['ping <word>', 'ping <word> repeat <n>', 'ping <word> source <word>'], function ([host, x]) { this.cmdPing(host, typeof x === 'number' ? x : 5, typeof x === 'string' ? x : null); }, 'Send echo messages');
C.add(EXEC, ['traceroute <word>'], function ([host]) { this.cmdTrace(host); });
C.add('priv', ['copy running-config startup-config', 'write memory', 'write'], function () { this.saveStartup(); });
C.add('priv', ['erase startup-config', 'write erase'], function () {
  this.d.startupConfig = null;
  this.print('Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]\n[OK]\nErase of nvram: complete\n');
});
C.add('priv', 'reload', function () { this.reload(); });
C.add('priv', ['clear arp-cache', 'clear ip arp'], function () { this.d.clearArp(); });
C.add('priv', ['clear mac address-table', 'clear mac address-table dynamic', 'clear mac-address-table dynamic'], function () { this.d.macTable?.clear(); });
C.add('priv', ['clear ip route *', 'clear ip route'], function () { if (this.d.rip) { this.d.rip.routes.clear(); this.d.rip.sync(); this.d.rip.triggerUpdate(); } });
C.add('priv', ['clear ip ospf process', 'clear ip ospf <n> process'], function ([pid]) {
  if (!this.need('router')) return;
  if (pid !== undefined && pid !== this.d.ospf.processId) { this.print(`%OSPF: Process ${pid} is not running\n`); return; }
  this.print(pid !== undefined ? `Reset OSPF process ${pid}? [no]: yes\n` : 'Reset ALL OSPF processes? [no]: yes\n');
  this.d.ospf.restart();
});
C.add('priv', ['clear ip nat translation *'], function () { this.need('router') && this.d.nat.clear(); });
C.add('priv', ['clear ip nat statistics'], function () { if (this.need('router')) { this.d.nat.hits = 0; this.d.nat.misses = 0; } });
C.add('priv', ['clear access-list counters'], function () { if (this.d.acl) for (const l of this.d.acl.lists.values()) for (const r of l) r.hits = 0; });
C.add(EXEC, ['terminal length <n>', 'terminal monitor', 'terminal no monitor'], function () {});
C.add(EXEC, ['show version'], function () { this.showVersion(); });
C.add(EXEC, ['show history'], function () { this.print(this.history.slice(-10).map((h) => `  ${h}`).join('\n') + '\n'); });
C.add(EXEC, ['show clock'], function () {
  const t = new Date(Date.UTC(2026, 0, 1) + this.d.now);
  this.print(`*${t.toISOString().slice(11, 23)} UTC ${t.toUTCString().slice(0, 16)}\n`);
});
C.add('priv', ['show running-config'], function () { const t = this.runningConfig(); this.print(`Building configuration...\n\nCurrent configuration : ${t.length} bytes\n${t}`); });
C.add('priv', ['show startup-config'], function () {
  if (!this.d.startupConfig) { this.print('startup-config is not present\n'); return; }
  this.print(`Using ${this.d.startupConfig.text.length} bytes\n${this.d.startupConfig.text}`);
});
C.add(EXEC, ['show ip interface brief', 'show ip int brief'], function () { this.showIpIntBrief(); });
C.add(EXEC, ['show interfaces', 'show interfaces <if>'], function ([n]) { this.showInterfaces(n); });
C.add(EXEC, ['show ip route', 'show ip route <ip>'], function ([ip]) { this.showIpRoute(ip); });
C.add(EXEC, ['show ip route static|connected|rip|ospf'], function ([kind]) { this.need('router') && this.showIpRoute(null, { static: 'S', connected: 'C', rip: 'R', ospf: 'O' }[kind]); });
C.add(EXEC, ['show arp', 'show ip arp'], function () { this.showArp(); });
C.add(EXEC, ['show cdp neighbors', 'show cdp neighbors detail'], function ([d]) { this.showCdp(); });
C.add(EXEC, ['show mac address-table', 'show mac-address-table'], function () { this.need('switch') && this.showMacTable(); });
C.add(EXEC, ['show vlan brief', 'show vlan'], function () { this.need('switch') && this.showVlan(); });
C.add(EXEC, ['show interfaces trunk'], function () { this.need('switch') && this.showTrunk(); });
C.add(EXEC, ['show interfaces status'], function () { this.need('switch') && this.showIntStatus(); });
C.add(EXEC, ['show spanning-tree', 'show spanning-tree vlan <n>'], function () { this.need('switch') && this.showStp(); });
C.add(EXEC, ['show ip dhcp binding'], function () { this.need('router') && this.showDhcpBinding(); });
C.add(EXEC, ['show ip dhcp pool'], function () { this.need('router') && this.showDhcpPool(); });
C.add(EXEC, ['show access-lists', 'show ip access-lists', 'show access-lists <n>'], function ([n]) { this.need('router') && this.showAcl(n); });
C.add(EXEC, ['show ip ospf neighbor', 'show ip ospf neighbor <if>'], function ([n]) { this.need('router') && this.showOspfNeighbors(n); });
C.add(EXEC, ['show ip ospf database'], function () { this.need('router') && this.showOspfDatabase(); });
C.add(EXEC, ['show ip ospf interface brief'], function () { this.need('router') && this.showOspfIfBrief(); });
C.add(EXEC, ['show ip nat translations'], function () { this.need('router') && this.showNatTranslations(false); });
C.add(EXEC, ['show ip nat translations verbose'], function () { this.need('router') && this.showNatTranslations(true); });
C.add(EXEC, ['show ip nat statistics'], function () { this.need('router') && this.showNatStatistics(); });
C.add(EXEC, ['show ip protocols'], function () { this.need('router') && this.showProtocols(); });

// ---------- global config ----------
C.add('config', 'hostname <word>', function ([n]) { this.setHostname(n); });
C.add('config', ['enable secret <word>', 'enable secret <n> <word>'], function (a) { this.d.enableSecret = String(a[a.length - 1]); });
C.add('config', ['enable password <word>'], function ([p]) { this.d.enablePassword = p; });
C.add('config', ['no enable secret', 'no enable password'], function () { this.d.enableSecret = null; this.d.enablePassword = null; });
C.add('config', ['banner motd <line>'], function ([t]) {
  const delim = t[0];
  const end = t.indexOf(delim, 1);
  this.d.banner = end > 0 ? t.slice(1, end) : t.slice(1);
});
C.add('config', ['no banner motd'], function () { this.d.banner = ''; });
C.add('config', ['interface <if>'], function ([n]) { this.enterInterface(n); });
C.add('config', ['interface range <line>'], function ([r]) { this.enterRange(r); });
C.add('config', ['no interface <if>'], function ([n]) { this.deleteInterface(n); });
const ROUTE_FORMS = ['<ip>', '<ip> <n>', '<if>', '<if> <n>', '<if> <ip>', '<if> <ip> <n>'];
C.add('config', ROUTE_FORMS.map((f) => `ip route <ip> <mask> ${f}`), function (a) { this.need('router') && this.addRoute(a, false); });
C.add('config', ['no ip route <ip> <mask>', ...ROUTE_FORMS.map((f) => `no ip route <ip> <mask> ${f}`)], function (a) { this.need('router') && this.addRoute(a, true); });
C.add('config', ['ip default-gateway <ip>'], function ([gw]) { this.need('switch') && (this.d.defaultGateway = gw); });
C.add('config', ['no ip default-gateway'], function () { this.d.defaultGateway = null; });
C.add('config', ['ip dhcp pool <word>'], function ([n]) { this.need('router') && this.enterPool(n); });
C.add('config', ['no ip dhcp pool <word>'], function ([n]) { if (this.d.dhcpServer) this.d.dhcpServer.pools = this.d.dhcpServer.pools.filter((p) => p.name !== n); });
C.add('config', ['ip dhcp excluded-address <ip>', 'ip dhcp excluded-address <ip> <ip>'], function ([a, b]) { this.need('router') && this.d.dhcpServer.excluded.push([a, b || a]); });
C.add('config', ['no ip dhcp excluded-address <ip>', 'no ip dhcp excluded-address <ip> <ip>'], function ([a]) { if (this.d.dhcpServer) this.d.dhcpServer.excluded = this.d.dhcpServer.excluded.filter((e) => e[0] !== a); });
C.add('config', ['service dhcp', 'no service dhcp'], function () {});
C.add('config', ['vlan <n>'], function ([n]) { this.need('switch') && this.enterVlan(n); });
C.add('config', ['no vlan <n>'], function ([n]) { this.need('switch') && this.deleteVlan(n); });
C.add('config', ['router rip'], function () { if (this.need('router')) { this.d.rip.enable(); this.mode = 'config-router'; this.ctx = { proto: 'rip' }; } });
C.add('config', ['router ospf <n>'], function ([pid]) {
  if (!this.need('router')) return;
  if (pid < 1 || pid > 65535) { this.print('% Process ID must be between 1 and 65535\n'); return; }
  const o = this.d.ospf;
  if (o.enabled && o.processId !== pid) { this.print(`% This simulator runs one OSPF process per router; process ${o.processId} is already running\n`); return; }
  o.enable(pid);
  this.changed();
  if (!o.routerId) this.print('%OSPF-4-NORTRID: OSPF process cannot pick a router-id. Configure an interface address or use "router-id"\n');
  this.mode = 'config-router';
  this.ctx = { proto: 'ospf' };
});
C.add('config', ['no router ospf <n>'], function ([pid]) {
  if (!this.need('router')) return;
  if (this.d.ospf.enabled && this.d.ospf.processId === pid) { this.d.ospf.disable(); this.changed(); }
});
C.add('config', ['no router rip'], function () { this.need('router') && this.d.rip.disable(); });
C.add('config', ['access-list <n> <line>'], function ([n, rest]) { this.need('router') && this.addAcl(n, rest); });
C.add('config', ['ip nat inside source list <n> interface <if> overload', 'ip nat inside source list <n> interface <if>'], function ([n, ifn]) {
  if (!this.need('router')) return;
  const i = this.d.getIface(ifn);
  if (!i) { this.print('% Invalid interface\n'); return; }
  this.d.nat.addRule({ acl: n, iface: i.name });
  this.changed();
});
C.add('config', ['no ip nat inside source list <n> interface <if> overload', 'no ip nat inside source list <n> interface <if>', 'no ip nat inside source list <n>'], function ([n, ifn]) {
  if (!this.need('router')) return;
  const nat = this.d.nat;
  if (ifn) nat.removeRule({ acl: n, iface: this.d.getIface(ifn)?.name || ifn });
  else nat.rules = nat.rules.filter((r) => r.acl !== n);
  this.changed();
});
C.add('config', ['no access-list <n>'], function ([n]) { this.need('router') && this.d.acl.remove(n); });
C.add('config', ['line con <n>', 'line console <n>', 'line vty <n> <n>', 'line aux <n>'], function () { this.mode = 'config-line'; });
C.add('config', ['spanning-tree vlan <n> priority <n>'], function ([, p]) {
  if (!this.need('switch')) return;
  if (p % 4096) { this.print('% Bridge Priority must be in increments of 4096.\n% Allowed values are:\n0     4096  8192  12288 16384 20480 24576 28672\n32768 36864 40960 45056 49152 53248 57344 61440\n'); return; }
  this.d.stp.priority = p; this.d.stp.markDirty(); this.d.net.emit('links');
});
C.add('config', ['spanning-tree vlan <n> root primary', 'spanning-tree vlan <n> root secondary'], function () {
  if (!this.need('switch')) return;
  const secondary = /secondary/.test(this.lastLine);
  this.d.stp.priority = secondary ? 28672 : 24576; this.d.stp.markDirty(); this.d.net.emit('links');
});
C.add('config', ['no spanning-tree vlan <n>'], function () { if (this.need('switch')) { this.d.stp.enabled = false; this.d.stp.markDirty(); this.d.net.emit('links'); } });
C.add('config', ['spanning-tree mode <word>', 'spanning-tree vlan <n>'], function () { if (this.need('switch')) { this.d.stp.enabled = true; this.d.stp.markDirty(); this.d.net.emit('links'); } });
C.add('config', ['service password-encryption', 'no service password-encryption', 'no ip domain-lookup', 'ip domain-lookup', 'ip domain-name <word>', 'ip routing', 'cdp run', 'no cdp run', 'ip classless'], function () {});
C.add('config', ['no ip routing'], function () { this.print('% Disabling IP routing is not supported in this simulator\n'); });

// ---------- line ----------
C.add('config-line', ['password <word>', 'login', 'login local', 'no login', 'exec-timeout <n> <n>', 'logging synchronous', 'transport input <word>'], function () {});

// ---------- interface ----------
C.add(IF_MODES, ['ip address <ip> <mask>'], function ([ip, mask]) { this.eachIface((i) => this.setIp(i, ip, mask)); });
C.add(IF_MODES, ['ip address dhcp'], function () { this.print('% DHCP client on router interfaces is not supported; use a static address\n'); });
C.add(IF_MODES, ['no ip address', 'no ip address <ip> <mask>'], function () { this.eachIface((i) => { i.ip = null; i.mask = null; this.changed(); }); });
C.add(IF_MODES, ['shutdown'], function () { this.eachIface((i) => this.setShutdown(i, true)); });
C.add(IF_MODES, ['no shutdown'], function () { this.eachIface((i) => this.setShutdown(i, false)); });
C.add(IF_MODES, ['description <line>'], function ([t]) { this.eachIface((i) => { i.description = t; if (i.port?.sw) i.port.sw.description = t; }); });
C.add(IF_MODES, ['no description'], function () { this.eachIface((i) => { i.description = ''; if (i.port?.sw) i.port.sw.description = ''; }); });
C.add(IF_MODES, ['duplex <word>', 'speed <word>', 'no duplex', 'no speed', 'mdix auto', 'switchport nonegotiate', 'no switchport nonegotiate', 'spanning-tree portfast', 'no spanning-tree portfast', 'spanning-tree portfast <word>', 'spanning-tree bpduguard enable', 'switchport port-security', 'cdp enable', 'no cdp enable', 'clock rate <n>'], function () {});
C.add(IF_MODES, ['bandwidth <n>'], function ([kbps]) {
  if (kbps < 1 || kbps > 10000000) { this.print('% Bandwidth must be between 1 and 10000000 kbit/s\n'); return; }
  this.eachIface((i) => { if (!i.isPort) i.bandwidth = kbps; });
  this.changed();
});
C.add(IF_MODES, ['no bandwidth', 'no bandwidth <n>'], function () { this.eachIface((i) => { if (!i.isPort) delete i.bandwidth; }); this.changed(); });
const OSPF_IF = { 'hello-interval': ['hello', 1, 65535], 'dead-interval': ['dead', 1, 65535], priority: ['priority', 0, 255], cost: ['cost', 1, 65535] };
C.add(['config-if', 'config-subif'], ['ip ospf hello-interval|dead-interval|priority|cost <n>'], function ([kind, v]) {
  if (!this.need('router')) return;
  const [key, lo, hi] = OSPF_IF[kind];
  if (v < lo || v > hi) { this.print(`% Value must be between ${lo} and ${hi}\n`); return; }
  const i = this.ctx.iface;
  i.ospf = { ...(i.ospf || {}), [key]: v };
  this.changed();
});
C.add(['config-if', 'config-subif'], ['no ip ospf hello-interval|dead-interval|priority|cost', 'no ip ospf hello-interval|dead-interval|priority|cost <n>'], function ([kind]) {
  if (!this.need('router')) return;
  const i = this.ctx.iface;
  const o = { ...(i.ospf || {}) };
  delete o[OSPF_IF[kind][0]];
  i.ospf = Object.keys(o).length ? o : undefined;
  this.changed();
});
C.add('config-subif', ['encapsulation dot1q <n>', 'encapsulation dot1q <n> native'], function ([v]) {
  const i = this.ctx.iface;
  if (this.d.ifaces.some((o) => o !== i && o.parent === i.parent && o.vlan === v)) { this.print(`% Configuration of multiple subinterfaces of the same main\n% interface with the same VID (${v}) is not permitted.\n`); return; }
  i.vlan = v; i.nativeVlan = /native/i.test(this.lastLine); this.changed();
});
C.add(['config-if', 'config-subif'], ['ip helper-address <ip>'], function ([h]) { if (this.need('router')) { const i = this.ctx.iface; i.helpers = [...new Set([...(i.helpers || []), h])]; } });
C.add(['config-if', 'config-subif'], ['no ip helper-address', 'no ip helper-address <ip>'], function ([h]) { const i = this.ctx.iface; i.helpers = h ? (i.helpers || []).filter((x) => x !== h) : []; });
C.add(['config-if', 'config-subif'], ['ip access-group <n> in|out'], function ([n, dir]) { if (this.need('router')) this.ctx.iface[dir === 'in' ? 'aclIn' : 'aclOut'] = n; });
C.add(['config-if', 'config-subif'], ['no ip access-group <n> in|out', 'no ip access-group in|out'], function (a) { const dir = a[a.length - 1]; this.ctx.iface[dir === 'in' ? 'aclIn' : 'aclOut'] = null; });
C.add(['config-if', 'config-subif'], ['ip nat inside|outside'], function ([role]) { if (this.need('router')) { this.ctx.iface.nat = role; this.changed(); } });
C.add(['config-if', 'config-subif'], ['no ip nat inside|outside'], function ([role]) { if (this.ctx.iface.nat === role) { delete this.ctx.iface.nat; this.changed(); } });
C.add(IF_MODES, ['switchport mode access|trunk'], function ([m]) { this.eachPort((p) => { p.sw.mode = m; }); this.changed(); });
C.add(IF_MODES, ['switchport mode dynamic <word>', 'switchport trunk encapsulation dot1q'], function () {});
C.add(IF_MODES, ['switchport access vlan <n>'], function ([v]) {
  if (v < 1 || v > 4094) { this.print('% Bad VLAN list\n'); return; }
  if (!this.d.vlans?.has(v)) { this.print(`% Access VLAN does not exist. Creating vlan ${v}\n`); this.d.vlans.set(v, `VLAN${String(v).padStart(4, '0')}`); }
  this.eachPort((p) => { p.sw.accessVlan = v; }); this.changed();
});
C.add(IF_MODES, ['no switchport access vlan', 'no switchport access vlan <n>'], function () { this.eachPort((p) => { p.sw.accessVlan = 1; }); this.changed(); });
C.add(IF_MODES, ['switchport trunk native vlan <n>'], function ([v]) { this.eachPort((p) => { p.sw.nativeVlan = v; }); this.changed(); });
C.add(IF_MODES, ['no switchport trunk native vlan'], function () { this.eachPort((p) => { p.sw.nativeVlan = 1; }); this.changed(); });
C.add(IF_MODES, ['switchport trunk allowed vlan <line>'], function ([spec]) { this.setAllowed(spec); });
C.add(IF_MODES, ['no switchport trunk allowed vlan'], function () { this.eachPort((p) => { p.sw.allowed = null; }); this.changed(); });
C.add(IF_MODES, ['interface <if>'], function ([n]) { this.enterInterface(n); });

// ---------- vlan ----------
C.add('config-vlan', ['name <word>'], function ([n]) { for (const v of this.ctx.vlans) this.d.vlans.set(v, n); });
C.add('config-vlan', ['no name'], function () { for (const v of this.ctx.vlans) this.d.vlans.set(v, `VLAN${String(v).padStart(4, '0')}`); });

// ---------- dhcp pool ----------
C.add('dhcp-config', ['network <ip> <mask>'], function ([ip, mask]) { this.ctx.pool.network = networkOf(ip, mask); this.ctx.pool.mask = mask; });
C.add('dhcp-config', ['default-router <ip>'], function ([ip]) { this.ctx.pool.defaultRouter = ip; });
C.add('dhcp-config', ['dns-server <ip>'], function ([ip]) { this.ctx.pool.dns = ip; });
C.add('dhcp-config', ['domain-name <word>', 'lease <n>', 'lease infinite'], function () {});
C.add('dhcp-config', ['no default-router', 'no dns-server', 'no network'], function () {
  const w = tokenize(this.lastLine)[1].toLowerCase();
  if (w.startsWith('dn')) this.ctx.pool.dns = null;
  else if (w.startsWith('de')) this.ctx.pool.defaultRouter = null;
  else { this.ctx.pool.network = null; this.ctx.pool.mask = null; }
});

// ---------- router rip / router ospf ----------
// Both use the config-router mode; ctx.proto says which process the commands apply to.
function ripOnly(fn) {
  return function (...a) {
    if (this.ctx.proto === 'ospf') { this.print(/^\s*n/i.test(this.lastLine) ? '% Incomplete command.\n' : '% Invalid input detected for OSPF.\n'); return; }
    fn.apply(this, a);
  };
}
function ospfOnly(fn) {
  return function (...a) {
    if (this.ctx.proto !== 'ospf') { this.print('% Invalid input detected for RIP.\n'); return; }
    fn.apply(this, a);
    this.changed(); // autosave and refresh open windows
  };
}
C.add('config-router', ['version <n>'], ripOnly(function ([v]) { this.d.rip.version = v; if (v !== 2) this.print('% This simulator implements RIP version 2 only (classless updates)\n'); }));
C.add('config-router', ['network <ip>'], ripOnly(function ([ip]) { this.d.rip.addNetwork(ip); }));
C.add('config-router', ['no network <ip>'], ripOnly(function ([ip]) { this.d.rip.removeNetwork(ip); }));
C.add('config-router', ['passive-interface <if>'], function ([n]) { if (this.ctx.proto === 'ospf') { this.d.ospf.setPassive(n, true); this.changed(); } else this.d.rip.passive.add(n); });
C.add('config-router', ['no passive-interface <if>'], function ([n]) { if (this.ctx.proto === 'ospf') { this.d.ospf.setPassive(n, false); this.changed(); } else this.d.rip.passive.delete(n); });
C.add('config-router', ['no auto-summary'], function () { if (this.ctx.proto !== 'ospf') this.d.rip.autoSummary = false; });
C.add('config-router', ['auto-summary'], ripOnly(function () { this.d.rip.autoSummary = true; }));
C.add('config-router', ['default-information originate', 'redistribute <line>'], function () { this.print('% Not supported in this simulator yet\n'); });
const areaNum = (a) => (typeof a === 'number' ? a : ipToInt(a));
C.add('config-router', ['network <ip> <ip> area <n>', 'network <ip> <ip> area <ip>'], ospfOnly(function ([ip, wc, area]) {
  const err = this.d.ospf.addNetwork(ip, wc, areaNum(area));
  if (err) this.print(`${err}\n`);
}));
C.add('config-router', ['no network <ip> <ip> area <n>', 'no network <ip> <ip> area <ip>', 'no network <ip> <ip>'], ospfOnly(function ([ip, wc]) { this.d.ospf.removeNetwork(ip, wc); }));
C.add('config-router', ['router-id <ip>'], ospfOnly(function ([rid]) {
  if (rid === '0.0.0.0') { this.print('% OSPF: router-id 0.0.0.0 is not allowed\n'); return; }
  if (!this.d.ospf.setRouterId(rid)) this.print('% OSPF: Reload or use "clear ip ospf process" command, for this to take effect\n');
}));
C.add('config-router', ['no router-id'], ospfOnly(function () {
  if (!this.d.ospf.clearRouterId()) this.print('% OSPF: Reload or use "clear ip ospf process" command, for this to take effect\n');
}));
C.add('config-router', ['auto-cost reference-bandwidth <n>'], ospfOnly(function ([mbps]) {
  if (mbps < 1 || mbps > 4294967) { this.print('% Reference bandwidth must be between 1 and 4294967 Mbit/s\n'); return; }
  this.d.ospf.setReferenceBw(mbps);
  this.print('% OSPF: Reference bandwidth is changed.\n        Please ensure reference bandwidth is consistent across all routers.\n');
}));
C.add('config-router', ['no auto-cost reference-bandwidth', 'no auto-cost reference-bandwidth <n>', 'no auto-cost'], ospfOnly(function () { this.d.ospf.setReferenceBw(100); }));
C.add('config-router', ['log-adjacency-changes', 'log-adjacency-changes detail'], ospfOnly(function () { this.d.ospf.logAdjacency = true; }));
C.add('config-router', ['no log-adjacency-changes', 'no log-adjacency-changes detail'], ospfOnly(function () { this.d.ospf.logAdjacency = false; }));

// 'do' lets any exec command run from config modes
C.add(CONFIG_MODES, ['do <line>'], function ([rest]) {
  const saved = this.mode;
  this.mode = 'priv';
  this.run(rest, true);
  if (this.mode === 'priv') this.mode = saved;
});

export const IOS_COMMANDS = C;

// ------------------------------------------------------------------------------------------

export class IosCli {
  constructor(device) {
    this.d = device;
    this.mode = 'user';
    this.ctx = {};
    this.history = [];
    this.busy = null;
    this.awaitPassword = null;
    this.out = () => {};
    this.configuredBy = false;
  }

  print(text) { this.out(text); }

  prompt() {
    if (this.awaitPassword) return '';
    const h = this.d.hostname;
    switch (this.mode) {
      case 'user': return `${h}>`;
      case 'priv': return `${h}#`;
      case 'config': return `${h}(config)#`;
      default: return `${h}(${this.mode})#`;
    }
  }

  banner() {
    const b = this.d.banner ? `${this.d.banner}\n\n` : '';
    return `${b}Press RETURN to get started!\n\n`;
  }

  need(kind) {
    if (this.d.type !== kind) { this.print('% Invalid input detected for this device type.\n'); return false; }
    return true;
  }

  cancel() {
    if (this.busy) { this.busy.cancel(); this.busy = null; this.print('\n'); }
  }

  /** Main entry point for a typed line. */
  exec(line) {
    if (this.busy) return;
    if (this.awaitPassword) {
      const ok = (this.d.enableSecret && line === this.d.enableSecret) || (this.d.enablePassword && line === this.d.enablePassword);
      this.print('\n');
      if (ok) { this.awaitPassword = null; this.mode = 'priv'; return; }
      this.awaitPassword.tries++;
      if (this.awaitPassword.tries >= 3) { this.awaitPassword = null; this.print('% Bad secrets\n\n'); return; }
      this.print('Password: ');
      return;
    }
    if (/\?$/.test(line)) {
      this.print(`${this.help(line.slice(0, -1))}\n`);
      return;
    }
    if (line.trim()) this.history.push(line);
    this.run(line, false);
  }

  run(line, fromDo) {
    this.lastLine = line;
    const r = IOS_COMMANDS.resolve(this.mode, line);
    if (r.empty) return;
    if (r.error) {
      // IOS falls back to global config for sub-modes
      if (this.mode !== 'config' && CONFIG_MODES.includes(this.mode) && !fromDo) {
        const g = IOS_COMMANDS.resolve('config', line);
        if (!g.error && !g.empty) {
          this.mode = 'config';
          this.ctx = {};
          g.def.run.call(this, g.args, g.tokens);
          return;
        }
      }
      if (r.error === 'ambiguous') this.print(`% Ambiguous command: "${line.trim()}"\n`);
      else if (r.error === 'incomplete') this.print('% Incomplete command.\n');
      else {
        const offset = this.tokenOffset(line, r.failAt);
        const pad = fromDo ? offset : this.prompt().length + offset;
        this.print(`${' '.repeat(pad)}^\n% Invalid input detected at '^' marker.\n\n`);
      }
      return;
    }
    try {
      r.def.run.call(this, r.args, r.tokens);
    } catch (e) {
      this.print(`% Internal error: ${e.message}\n`);
      console.error(e);
    }
  }

  tokenOffset(line, idx) {
    const re = /\S+/g;
    let m;
    let i = 0;
    while ((m = re.exec(line))) {
      if (i === idx) return m.index;
      i++;
    }
    return line.length;
  }

  help(line) {
    return IOS_COMMANDS.help(this.mode, line);
  }

  complete(line) {
    const r = IOS_COMMANDS.complete(this.mode, line);
    if (r) return r;
    if (CONFIG_MODES.includes(this.mode) && this.mode !== 'config') return IOS_COMMANDS.complete('config', line);
    return null;
  }

  changed() {
    this.d.ospf?.topologyChanged(); // cheap: only (re)starts interfaces whose OSPF state changed
    this.d.net?.emit('config', this.d);
  }

  syslogConfigured() {
    this.print(`%SYS-5-CONFIG_I: Configured from console by console\n`);
  }

  // ---------------- helpers used by commands ----------------

  setHostname(n) {
    this.d.hostname = n;
    this.d.name = n;
    this.d.net?.emit('topology');
  }

  enterInterface(name) {
    const d = this.d;
    if (/^Vlan\d+$/.test(name)) {
      if (d.type !== 'switch') { this.print('% Invalid input detected for this device type.\n'); return; }
      const v = Number(name.slice(4));
      if (v < 1 || v > 4094) { this.print('% Invalid VLAN\n'); return; }
      const existed = d.getIface(name);
      const i = d.ensureSvi(v);
      if (!existed) d.syslog(`%LINK-5-CHANGED: Interface ${name}, changed state to up`);
      this.ctx = { iface: i };
      this.mode = 'config-if';
      return;
    }
    if (name.includes('.')) {
      if (d.type !== 'router') { this.print('% Invalid input detected for this device type.\n'); return; }
      const i = d.subinterface(name);
      if (!i) { this.print('% Invalid interface\n'); return; }
      this.ctx = { iface: i };
      this.mode = 'config-subif';
      this.changed();
      return;
    }
    if (d.type === 'switch') {
      const p = d.getPort(name);
      if (!p) { this.print(`% Invalid interface ${name}\n`); return; }
      this.ctx = { ports: [p] };
      this.mode = 'config-if';
      return;
    }
    const i = d.getIface(name);
    if (!i) { this.print(`% Invalid interface ${name}\n`); return; }
    this.ctx = { iface: i };
    this.mode = 'config-if';
  }

  enterRange(spec) {
    const names = parseIfRange(spec);
    if (!names) { this.print('% Invalid interface range\n'); return; }
    const d = this.d;
    if (d.type === 'switch') {
      const ports = names.map((n) => d.getPort(n));
      if (ports.some((p) => !p)) { this.print('% Command rejected: invalid interface in range\n'); return; }
      this.ctx = { ports };
    } else {
      const ifaces = names.map((n) => d.getIface(n));
      if (ifaces.some((p) => !p)) { this.print('% Command rejected: invalid interface in range\n'); return; }
      this.ctx = { ifaces };
    }
    this.mode = 'config-if-range';
  }

  deleteInterface(name) {
    const i = this.d.getIface(name);
    if (!i || !i.parent) { this.print('% Physical interfaces cannot be removed\n'); return; }
    this.d.ifaces = this.d.ifaces.filter((x) => x !== i);
    this.changed();
  }

  eachIface(fn) {
    if (this.ctx.iface) fn(this.ctx.iface);
    else if (this.ctx.ifaces) this.ctx.ifaces.forEach(fn);
    else if (this.ctx.ports) {
      // switch physical ports: shutdown/description work, IP does not
      for (const p of this.ctx.ports) fn({ port: p, isPort: true, name: p.name });
    }
  }

  eachPort(fn) {
    if (this.d.type !== 'switch') { this.print('% Invalid input detected for this device type.\n'); return; }
    if (!this.ctx.ports) { this.print('% Command not valid on this interface\n'); return; }
    this.ctx.ports.forEach(fn);
    this.d.stp.markDirty();
  }

  setIp(i, ip, mask) {
    if (i.isPort) { this.print('% IP addresses may not be configured on L2 links.\n'); return; }
    if (!isValidMask(mask) || mask === '0.0.0.0') { this.print('% Bad mask 0x' + ipToInt(mask).toString(16).toUpperCase() + ` for address ${ip}\n`); return; }
    const net = networkOf(ip, mask);
    if (ip === net && mask !== '255.255.255.255') { this.print(`Bad mask /${maskToPrefix(mask)} for address ${ip}\n`); return; }
    const overlap = this.d.ifaces.find((o) => o !== i && o.ip && o.mask && (inSubnet(ip, o.ip, o.mask) || inSubnet(o.ip, ip, mask)));
    if (overlap && this.d.type === 'router') { this.print(`% ${net} overlaps with ${overlap.name}\n`); return; }
    i.ip = ip;
    i.mask = mask;
    this.d.clearArp(i);
    this.d.rip?.topologyChanged();
    this.d.ospf?.topologyChanged();
    this.changed();
  }

  setShutdown(i, shut) {
    const d = this.d;
    if (i.isSvi || i.parent) {
      if (i.shutdown === shut) return;
      i.shutdown = shut;
      const up = d.ifaceUp(i);
      d.syslog(`%LINK-5-CHANGED: Interface ${i.name}, changed state to ${shut ? 'administratively down' : up ? 'up' : 'down'}`);
      if (!shut && up) d.syslog(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${i.name}, changed state to up`);
      d.rip?.topologyChanged();
      d.ospf?.topologyChanged();
      this.changed();
      return;
    }
    const p = i.port;
    if (p.shutdown === shut) return;
    p.shutdown = shut;
    if (shut && !p.isUp() && !p._up) d.syslog(`%LINK-5-CHANGED: Interface ${p.name}, changed state to administratively down`);
    d.net.notifyPort(p);
    this.changed();
  }

  setAllowed(spec) {
    const s = spec.trim().toLowerCase();
    this.eachPort((p) => {
      const cur = p.sw.allowed ? [...p.sw.allowed] : null;
      let m;
      if (s === 'all') p.sw.allowed = null;
      else if (s === 'none') p.sw.allowed = [];
      else if ((m = s.match(/^add\s+(.+)$/))) { const l = parseRangeList(m[1]); if (l) p.sw.allowed = cur ? [...new Set([...cur, ...l])].sort((a, b) => a - b) : null; }
      else if ((m = s.match(/^remove\s+(.+)$/))) { const l = parseRangeList(m[1]); if (l) p.sw.allowed = (cur || range(1, 4094)).filter((v) => !l.includes(v)); }
      else if ((m = s.match(/^except\s+(.+)$/))) { const l = parseRangeList(m[1]); if (l) p.sw.allowed = range(1, 4094).filter((v) => !l.includes(v)); }
      else { const l = parseRangeList(s); if (!l) { this.print('% Bad VLAN list\n'); return; } p.sw.allowed = l; }
    });
    this.changed();
  }

  enterVlan(n) {
    if (n < 1 || n > 4094) { this.print('% Bad VLAN list\n'); return; }
    if (!this.d.vlans.has(n)) this.d.vlans.set(n, `VLAN${String(n).padStart(4, '0')}`);
    this.ctx = { vlans: [n] };
    this.mode = 'config-vlan';
    this.changed();
  }

  deleteVlan(n) {
    if (n === 1) { this.print('%Default VLAN 1 may not be deleted.\n'); return; }
    this.d.vlans.delete(n);
    this.d.stp.markDirty();
    this.changed();
  }

  enterPool(name) {
    let p = this.d.dhcpServer.pools.find((x) => x.name === name);
    if (!p) { p = { name, network: null, mask: null, defaultRouter: null, dns: null }; this.d.dhcpServer.pools.push(p); }
    this.ctx = { pool: p };
    this.mode = 'dhcp-config';
  }

  addRoute(a, remove) {
    const [network, mask, ...rest] = a;
    if (!isValidMask(mask)) { this.print('%Inconsistent address and mask\n'); return; }
    if (networkOf(network, mask) !== network) { this.print('%Inconsistent address and mask\n'); return; }
    // rest is [next hop], [next hop, distance], [interface], [interface, distance], [interface, next hop] or [interface, next hop, distance]
    let iface = null, nextHop = null, ad = 1;
    for (const x of rest) {
      if (typeof x === 'number') ad = x;
      else if (isValidIp(x)) nextHop = x;
      else iface = x;
    }
    if (!remove && (ad < 1 || ad > 255)) { this.print('% Distance must be between 1 and 255\n'); return; }
    if (iface && !this.d.getIface(iface)) { this.print('% Invalid interface\n'); return; }
    if (remove) {
      // "no ip route" matches on prefix plus whatever path was given; the distance does not need to match
      this.d.staticRoutes = this.d.staticRoutes.filter((r) => !(r.network === network && r.mask === mask
        && (!nextHop || r.nextHop === nextHop) && (!iface || r.iface === iface)));
    } else {
      this.d.staticRoutes = this.d.staticRoutes.filter((r) => !(r.network === network && r.mask === mask && (r.nextHop || null) === nextHop && (r.iface || null) === iface));
      this.d.staticRoutes.push({ network, mask, nextHop, iface, ad });
    }
    this.changed();
  }

  addAcl(num, rest) {
    const t = tokenize(rest);
    const action = (t.shift() || '').toLowerCase();
    if (!['permit', 'deny', 'remark'].includes(action)) { this.print('% Invalid input: expected permit or deny\n'); return; }
    if (action === 'remark') return;
    const addr = () => {
      const w = (t.shift() || '').toLowerCase();
      if (w === 'any') return { any: true };
      if (w === 'host') { const ip = t.shift(); return isValidIp(ip) ? { ip, wildcard: '0.0.0.0' } : null; }
      if (!isValidIp(w)) return null;
      if (t.length && isValidIp(t[0])) return { ip: w, wildcard: t.shift() };
      return { ip: w, wildcard: '0.0.0.0' };
    };
    if (num >= 1 && num <= 99) {
      const src = addr();
      if (!src || t.length) { this.print('% Invalid access list entry\n'); return; }
      this.d.acl.add(num, { action, src });
    } else if (num >= 100 && num <= 199) {
      const proto = (t.shift() || '').toLowerCase();
      if (!['ip', 'icmp', 'tcp', 'udp'].includes(proto)) { this.print('% Invalid protocol (use ip, icmp, tcp or udp)\n'); return; }
      const src = addr();
      const dst = addr();
      let port = null;
      if (t.length) {
        if (t[0].toLowerCase() !== 'eq') { this.print('% Only "eq <port>" is supported\n'); return; }
        t.shift();
        const p = t.shift();
        const named = { www: 80, http: 80, domain: 53, telnet: 23, ftp: 21, smtp: 25, bootps: 67, bootpc: 68 };
        port = /^\d+$/.test(p) ? Number(p) : named[p?.toLowerCase()];
        if (!port) { this.print('% Bad port\n'); return; }
      }
      if (!src || !dst) { this.print('% Invalid access list entry\n'); return; }
      this.d.acl.add(num, { action, proto, src, dst, port });
    } else {
      this.print('% Access list number must be 1-99 (standard) or 100-199 (extended)\n');
    }
  }

  saveStartup() {
    const cfg = this.d.saveConfig();
    delete cfg.startupConfig;
    this.d.startupConfig = { text: this.runningConfig(), cfg: JSON.parse(JSON.stringify(cfg)) };
    this.print('Building configuration...\n[OK]\n');
  }

  reload() {
    const d = this.d;
    this.print('Proceed with reload? [confirm]\n');
    const cfg = d.startupConfig ? d.startupConfig.cfg : null;
    const startup = d.startupConfig;
    d.resetConfig?.();
    if (cfg) d.loadConfig(cfg);
    d.startupConfig = startup;
    for (const p of d.ports) d.net.notifyPort(p);
    this.mode = 'user';
    this.ctx = {};
    this.print(`\nSystem restarted.\n\n${this.banner()}`);
    this.changed();
  }

  // ---------------- ping / traceroute ----------------

  cmdPing(host, count, source) {
    if (!isValidIp(host)) { this.print('% Unrecognized host or address, or protocol not running.\n\n'); return; }
    let src = null;
    if (source) {
      const name = parseIfName(source);
      const i = name && this.d.getIface(name);
      src = i ? i.ip : isValidIp(source) ? source : null;
      if (!src) { this.print('% Invalid source address\n'); return; }
    }
    this.print(`Type escape sequence to abort.\nSending ${count}, 100-byte ICMP Echos to ${host}, timeout is 2 seconds:\n`);
    if (src) this.print(`Packet sent with a source address of ${src}\n`);
    this.busy = this.d.ping(host, {
      count, timeout: 2000, interval: 0, size: 100, src,
      onResult: (r) => this.print(r.kind === 'reply' ? '!' : r.kind === 'unreachable' ? 'U' : r.kind === 'ttl' ? '&' : '.'),
      onDone: (s) => {
        this.busy = null;
        const pct = Math.round((s.received / s.sent) * 100);
        let line = `\nSuccess rate is ${pct} percent (${s.received}/${s.sent})`;
        if (s.received) {
          const min = Math.min(...s.rtts), max = Math.max(...s.rtts);
          const avg = Math.round(s.rtts.reduce((a, b) => a + b, 0) / s.rtts.length);
          line += `, round-trip min/avg/max = ${min}/${avg}/${max} ms`;
        }
        this.print(`${line}\n\n`);
        this.onBusyDone?.();
      },
    });
  }

  cmdTrace(host) {
    if (!isValidIp(host)) { this.print('% Unrecognized host or address, or protocol not running.\n\n'); return; }
    this.print(`Type escape sequence to abort.\nTracing the route to ${host}\n\n`);
    this.busy = this.d.traceroute(host, {
      timeout: 2000,
      onHop: ({ ttl, probes }) => {
        const from = probes.find((p) => p.from)?.from;
        const cells = probes.map((p) => (p.kind === 'timeout' ? '*' : `${p.rtt} msec`));
        this.print(`  ${String(ttl).padStart(2)}   ${(from || '').padEnd(15)} ${cells.join('  ')}\n`);
      },
      onDone: () => { this.busy = null; this.print('\n'); this.onBusyDone?.(); },
    });
  }

  // ---------------- show commands ----------------

  showVersion() {
    const d = this.d;
    const kind = d.type === 'router' ? 'Router' : 'Switch';
    this.print(`OpenNetSim Virtual ${kind} Software, Version 1.0
Copyright (c) OpenNetSim contributors. MIT License.

${d.hostname} uptime is ${uptime(d.now)}
System image is the OpenNetSim engine (JavaScript)

${d.ports.length} ${d.type === 'router' ? 'Gigabit Ethernet' : 'Ethernet'} interfaces
Base MAC address: ${formatMac(d.ports[0].mac)}

Configuration register is 0x2102
`);
  }

  showIpIntBrief() {
    const rows = [['Interface', 'IP-Address', 'OK?', 'Method', 'Status', 'Protocol']];
    const d = this.d;
    if (d.type === 'switch') {
      for (const p of d.ports) {
        const st = p.shutdown ? 'administratively down' : p.isUp() ? 'up' : 'down';
        rows.push([p.name, 'unassigned', 'YES', 'manual', st, p.isUp() ? 'up' : 'down']);
      }
      for (const i of d.ifaces.filter((x) => x.isSvi)) {
        const s = d.ifaceStatus(i);
        rows.push([i.name, i.ip || 'unassigned', 'YES', 'manual', s.status, s.protocol]);
      }
    } else {
      for (const i of d.ifaces) {
        const s = d.ifaceStatus(i);
        rows.push([i.name, i.ip || 'unassigned', 'YES', i.ip ? 'manual' : 'unset', s.status, s.protocol]);
      }
    }
    this.print(rows.map((r) => `${r[0].padEnd(23)}${r[1].padEnd(16)}${r[2].padEnd(4)}${r[3].padEnd(7)}${r[4].padEnd(22)}${r[5]}`).join('\n') + '\n');
  }

  showInterfaces(name) {
    const d = this.d;
    const lines = [];
    const list = d.type === 'switch'
      ? [...d.ports.map((p) => ({ port: p, name: p.name })), ...d.ifaces.filter((i) => i.isSvi)]
      : d.ifaces;
    const sel = name ? list.filter((i) => i.name.toLowerCase() === name.toLowerCase()) : list;
    if (!sel.length) { this.print('% Invalid interface\n'); return; }
    for (const i of sel) {
      let status;
      let proto;
      if (i.port && !i.ip && d.type === 'switch' && !i.isSvi) {
        status = i.port.shutdown ? 'administratively down' : i.port.isUp() ? 'up' : 'down';
        proto = i.port.isUp() ? 'up' : 'down';
      } else {
        const s = d.ifaceStatus(i);
        status = s.status; proto = s.protocol;
      }
      lines.push(`${i.name} is ${status}, line protocol is ${proto}`);
      const mac = i.mac || i.port?.mac;
      lines.push(`  Hardware is ${i.isSvi ? 'CPU Interface' : /^Gig/.test(i.name) ? 'Gigabit Ethernet' : 'Fast Ethernet'}, address is ${formatMac(mac)} (bia ${formatMac(mac)})`);
      const desc = i.description || i.port?.sw?.description;
      if (desc) lines.push(`  Description: ${desc}`);
      if (i.ip) lines.push(`  Internet address is ${i.ip}/${maskToPrefix(i.mask)}`);
      if (i.parent) lines.push(`  Encapsulation 802.1Q Virtual LAN, Vlan ID  ${i.vlan ?? 'not set'}${i.nativeVlan ? ' (native)' : ''}`);
      else lines.push(`  MTU 1500 bytes, BW ${d.type === 'router' ? bandwidthKbps(i) : /^Gig/.test(i.name) ? '1000000' : '100000'} Kbit, DLY 10 usec`);
      lines.push('');
    }
    this.print(lines.join('\n') + '\n');
  }

  showIpRoute(only, protoFilter = null) {
    const d = this.d;
    if (d.type === 'switch') {
      this.print(d.defaultGateway ? `Default gateway is ${d.defaultGateway}\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty\n` : 'Default gateway is not set\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty\n');
      return;
    }
    const routes = d.routes();
    const legend = `Codes: L - local, C - connected, S - static, R - RIP, O - OSPF,
       * - candidate default, U - per-user static route

`;
    const def = d.gatewayOfLastResort(routes);
    let out = legend + (def ? `Gateway of last resort is ${def.nextHop || '0.0.0.0'} to network 0.0.0.0\n\n` : 'Gateway of last resort is not set\n\n');
    const fmt = (r, indent) => {
      const code = (r.proto + (r.network === '0.0.0.0' && r.mask === '0.0.0.0' ? '*' : '')).padEnd(indent ? 9 : 6);
      const pfx = `${r.network}/${maskToPrefix(r.mask)}`;
      if (r.proto === 'C' || r.proto === 'L') return `${code}${pfx} is directly connected, ${r.iface.name}`;
      if (r.proto === 'S') {
        if (r.exitIface && !r.nextHop) return `${code}${pfx} is directly connected, ${r.iface.name}`;
        return `${code}${pfx} [${r.ad}/${r.metric}] via ${r.nextHop}`;
      }
      if (r.proto === 'R' || r.proto === 'O') return `${code}${pfx} [${r.ad}/${r.metric}] via ${r.nextHop}, ${uptime(d.now - (r.time || 0))}, ${r.iface.name}`;
      return `${code}${pfx} via ${r.nextHop}`;
    };
    if (only) {
      const l = d.lookup(only);
      if (!l) { this.print('% Network not in table\n'); return; }
      const r = l.route;
      const isDefault = r.network === '0.0.0.0' && r.mask === '0.0.0.0';
      // every installed path for this prefix (equal-cost paths share the load)
      const paths = routes.filter((x) => x.network === r.network && x.mask === r.mask && x.proto === r.proto);
      const blocks = paths.map((x, k) => `  ${k === 0 ? '*' : ' '} ${x.nextHop || 'directly connected'}, via ${x.iface.name}`).join('\n');
      this.print(`Routing entry for ${r.network}/${maskToPrefix(r.mask)}${isDefault ? ', supernet' : ''}\n  Known via "${{ C: 'connected', L: 'connected', S: 'static', R: 'rip', O: `ospf ${d.ospf?.processId}` }[r.proto]}", distance ${r.ad}, metric ${r.metric}${isDefault ? ', candidate default path' : ''}\n  Routing Descriptor Blocks:\n${blocks}\n`);
      return;
    }
    if (protoFilter) {
      // "show ip route static" and friends: same header, only the matching routes
      const list = routes.filter((r) => r.proto === protoFilter || (protoFilter === 'C' && r.proto === 'L'));
      list.sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || maskToPrefix(a.mask) - maskToPrefix(b.mask));
      this.print(out + list.map((r) => fmt(r, false)).join('\n') + (list.length ? '\n' : ''));
      return;
    }
    // group by classful network, like IOS does
    const groups = new Map();
    for (const r of routes) {
      const c = classful(r.network);
      const key = `${c.net}/${c.prefix}`;
      if (!groups.has(key)) groups.set(key, { c, list: [] });
      groups.get(key).list.push(r);
    }
    const sorted = [...groups.values()].sort((a, b) => ipToInt(a.c.net) - ipToInt(b.c.net));
    for (const g of sorted) {
      g.list.sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || maskToPrefix(a.mask) - maskToPrefix(b.mask));
      const whole = g.list.length === 1 && maskToPrefix(g.list[0].mask) <= g.c.prefix;
      if (whole) { out += fmt(g.list[0], false) + '\n'; continue; }
      const masks = new Set(g.list.map((r) => r.mask));
      const n = new Set(g.list.map((r) => `${r.network}/${r.mask}`)).size;
      if (masks.size > 1) out += `     ${g.c.net}/${g.c.prefix} is variably subnetted, ${n} subnets, ${masks.size} masks\n`;
      else out += `     ${g.c.net}/${maskToPrefix([...masks][0])} is subnetted, ${n} subnets\n`;
      for (const r of g.list) out += fmt(r, true) + '\n';
    }
    this.print(out);
  }

  showArp() {
    const d = this.d;
    const rows = [];
    for (const i of d.ifaces) if (i.ip && d.ifaceUp(i)) rows.push([i.ip, '-', i.mac, i.name]);
    for (const [ip, e] of d.arp) rows.push([ip, String(Math.floor((d.now - e.time) / 60000)), e.mac, e.iface.name]);
    rows.sort((a, b) => ipToInt(a[0]) - ipToInt(b[0]));
    this.print('Protocol  Address          Age (min)  Hardware Addr   Type   Interface\n' + rows.map((r) => `Internet  ${r[0].padEnd(17)}${r[1].padStart(9)}   ${formatMac(r[2]).padEnd(16)}ARPA   ${r[3]}`).join('\n') + '\n');
  }

  showCdp() {
    const d = this.d;
    const rows = [];
    for (const p of d.ports) {
      if (!p.isUp()) continue;
      const n = p.peer.device;
      if (!['router', 'switch'].includes(n.type)) continue;
      const cap = n.type === 'router' ? 'R' : 'S';
      rows.push(`${n.hostname.padEnd(17)}${shortIf(p.name).padEnd(16)}${'160'.padEnd(11)}${cap.padEnd(13)}${(n.type === 'router' ? 'Router' : 'Switch').padEnd(10)}${shortIf(p.peer.name)}`);
    }
    this.print(`Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge
                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone
Device ID        Local Intrfce   Holdtme    Capability   Platform  Port ID
${rows.join('\n')}${rows.length ? '\n' : ''}`);
  }

  showMacTable() {
    const rows = this.d.macEntries().map((e) => `${String(e.vlan).padStart(4)}    ${formatMac(e.mac).padEnd(18)}DYNAMIC     ${shortIf(e.port.name)}`);
    this.print(`          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----

${rows.join('\n')}${rows.length ? '\n' : ''}`);
  }

  showVlan() {
    const d = this.d;
    let out = 'VLAN Name                             Status    Ports\n---- -------------------------------- --------- -------------------------------\n';
    const vlans = [...d.vlans.keys()].sort((a, b) => a - b);
    for (const v of vlans) {
      const ports = d.ports.filter((p) => p.sw.mode !== 'trunk' && p.sw.accessVlan === v).map((p) => shortIf(p.name));
      const chunks = [];
      for (let i = 0; i < ports.length; i += 4) chunks.push(ports.slice(i, i + 4).join(', '));
      out += `${String(v).padEnd(5)}${d.vlans.get(v).padEnd(33)}active    ${chunks[0] || ''}\n`;
      for (const c of chunks.slice(1)) out += `${''.padEnd(48)}${c}\n`;
    }
    this.print(out);
  }

  showTrunk() {
    const d = this.d;
    const trunks = d.ports.filter((p) => p.sw.mode === 'trunk' && p.isUp());
    if (!trunks.length) { this.print('\n'); return; }
    let out = 'Port        Mode         Encapsulation  Status        Native vlan\n';
    for (const p of trunks) out += `${shortIf(p.name).padEnd(12)}on           802.1q         trunking      ${p.sw.nativeVlan}\n`;
    out += '\nPort        Vlans allowed on trunk\n';
    for (const p of trunks) out += `${shortIf(p.name).padEnd(12)}${p.sw.allowed ? compressRange(p.sw.allowed) || 'none' : '1-1005'}\n`;
    out += '\nPort        Vlans allowed and active in management domain\n';
    for (const p of trunks) out += `${shortIf(p.name).padEnd(12)}${compressRange(d.portVlans(p)) || 'none'}\n`;
    out += '\nPort        Vlans in spanning tree forwarding state and not pruned\n';
    for (const p of trunks) out += `${shortIf(p.name).padEnd(12)}${d.stp.forwarding(p) ? compressRange(d.portVlans(p)) || 'none' : 'none'}\n`;
    this.print(out);
  }

  showIntStatus() {
    const d = this.d;
    let out = 'Port      Name               Status       Vlan       Duplex  Speed Type\n';
    for (const p of d.ports) {
      const st = p.shutdown ? 'disabled' : p.isUp() ? 'connected' : 'notconnect';
      const vlan = p.sw.mode === 'trunk' ? 'trunk' : String(p.sw.accessVlan);
      out += `${shortIf(p.name).padEnd(10)}${(p.sw.description || '').slice(0, 18).padEnd(19)}${st.padEnd(13)}${vlan.padEnd(11)}auto    auto  ${/^Gig/.test(p.name) ? '10/100/1000BaseTX' : '10/100BaseTX'}\n`;
    }
    this.print(out);
  }

  showStp() {
    const d = this.d;
    const s = d.stp;
    if (!s.enabled) { this.print('No spanning tree instance exists.\n'); return; }
    s.ensure();
    const [rp, rmac] = s.rootId.split('.');
    const prio = Number(rp) + 1;
    const isRoot = s.rootId === s.bridgeId;
    let out = `VLAN0001
  Spanning tree enabled protocol ieee
  Root ID    Priority    ${prio}
             Address     ${formatMac(s.rootId.split('.').slice(1).join('.'))}
`;
    if (isRoot) out += '             This bridge is the root\n';
    else out += `             Cost        ${s.rootCost}\n             Port        ${d.ports.indexOf(s.rootPort) + 1} (${s.rootPort?.name})\n`;
    out += `             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec

  Bridge ID  Priority    ${s.priority + 1}  (priority ${s.priority} sys-id-ext 1)
             Address     ${formatMac(d.baseMac)}
             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec
             Aging Time  20

Interface        Role Sts Cost      Prio.Nbr Type
---------------- ---- --- --------- -------- --------------------------------
`;
    void rmac;
    for (const p of d.ports) {
      if (!p.isUp()) continue;
      const r = s.roles.get(p) || { role: 'designated', cost: 19 };
      const role = { root: 'Root', designated: 'Desg', alternate: 'Altn' }[r.role] || 'Desg';
      const sts = r.role === 'alternate' ? 'BLK' : 'FWD';
      out += `${shortIf(p.name).padEnd(17)}${role} ${sts} ${String(r.cost).padEnd(10)}128.${String(d.ports.indexOf(p) + 1).padEnd(5)}P2p\n`;
    }
    this.print(out);
  }

  showDhcpBinding() {
    const d = this.d;
    let out = 'IP address       Client-ID/              Lease expiration        Type\n                 Hardware address\n';
    for (const [mac, b] of d.dhcpServer.bindings) out += `${b.ip.padEnd(17)}${formatMac(mac).padEnd(24)}--                      Automatic\n`;
    this.print(out);
  }

  showDhcpPool() {
    const d = this.d;
    let out = '';
    for (const p of d.dhcpServer.pools) {
      const leased = [...d.dhcpServer.bindings.values()].filter((b) => b.pool === p.name).length;
      out += `\nPool ${p.name} :\n Utilization mark (high/low)    : 100 / 0\n Subnet size (first/next)       : 0 / 0\n Total addresses                : ${p.mask ? 2 ** (32 - maskToPrefix(p.mask)) - 2 : 0}\n Leased addresses               : ${leased}\n Network                        : ${p.network || 'not set'} ${p.mask || ''}\n Default router                 : ${p.defaultRouter || 'not set'}\n DNS server                     : ${p.dns || 'not set'}\n`;
    }
    this.print(out || '\n');
  }

  showAcl(only) {
    const d = this.d;
    let out = '';
    for (const [n, rules] of [...d.acl.lists.entries()].sort((a, b) => a[0] - b[0])) {
      if (only && n !== only) continue;
      out += `${n < 100 ? 'Standard' : 'Extended'} IP access list ${n}\n`;
      d.acl.lines(n).forEach((l, i) => { out += `    ${(i + 1) * 10} ${l}${rules[i].hits ? ` (${rules[i].hits} match(es))` : ''}\n`; });
    }
    this.print(out || '\n');
  }

  showNatTranslations(verbose) {
    const now = this.d.net ? this.d.net.time : 0;
    const rows = this.d.nat.translations();
    let out = 'Pro  Inside global         Inside local          Outside local         Outside global\n';
    for (const e of rows) {
      const g = `${e.insideGlobal}:${e.globalPort}`;
      const l = `${e.insideLocal}:${e.localPort}`;
      const o = `${e.outside}:${e.outsidePort}`;
      out += `${e.proto.padEnd(5)}${g.padEnd(22)}${l.padEnd(22)}${o.padEnd(22)}${o}\n`;
      if (verbose) out += `  create ${uptime(now - e.created)}, use ${uptime(now - e.last)}, flags: extended\n`;
    }
    this.print(out + '\n');
  }

  showNatStatistics() {
    const d = this.d;
    const rows = d.nat.translations();
    const names = (role) => d.ifaces.filter((i) => i.nat === role).map((i) => i.name).join(', ');
    let out = `Total active translations: ${rows.length} (0 static, ${rows.length} dynamic; ${rows.length} extended)\n`;
    out += `Outside interfaces:\n  ${names('outside')}\nInside interfaces:\n  ${names('inside')}\n`;
    out += `Hits: ${d.nat.hits}  Misses: ${d.nat.misses}\nDynamic mappings:\n-- Inside Source\n`;
    d.nat.rules.forEach((r, k) => {
      const refs = rows.filter((e) => e.insideGlobal === d.getIface(r.iface)?.ip).length;
      out += `[Id: ${k + 1}] access-list ${r.acl} interface ${r.iface} refcount ${refs}\n`;
    });
    this.print(out);
  }

  showOspfNeighbors(only) {
    const o = this.d.ospf;
    if (!o.enabled) { this.print('\n'); return; }
    const rows = o.neighborRows().filter((r) => !only || r.iface.toLowerCase() === only.toLowerCase());
    let out = '\nNeighbor ID     Pri   State           Dead Time   Address         Interface\n';
    for (const r of rows) {
      out += `${r.rid.padEnd(16)}${String(r.priority).padStart(3)}   ${r.state.padEnd(16)}${uptime(r.dead).padEnd(12)}${r.ip.padEnd(16)}${r.iface}\n`;
    }
    this.print(out);
  }

  showProtocols() {
    const parts = [this.ripProtocolText(), this.ospfProtocolText()].filter(Boolean);
    this.print(parts.length ? parts.join('\n') : '\n');
  }

  ripProtocolText() {
    const rip = this.d.rip;
    if (!rip.enabled) return '';
    const sources = new Map();
    for (const r of rip.routes.values()) sources.set(r.nextHop, r.time);
    let out = `Routing Protocol is "rip"
Sending updates every 30 seconds, next due in ${rip.timer ? Math.max(0, Math.round((rip.timer.time - this.d.now) / 1000)) : 0} seconds
Invalid after 180 seconds, hold down 180, flushed after 240
Outgoing update filter list for all interfaces is not set
Incoming update filter list for all interfaces is not set
Redistributing: rip
Default version control: send version 2, receive 2
  Interface             Send  Recv  Triggered RIP  Key-chain
`;
    for (const i of this.d.ifaces) if (rip.ripIface(i) && !rip.passive.has(i.name)) out += `  ${i.name.padEnd(22)}2     2\n`;
    out += `Automatic network summarization is ${rip.autoSummary ? 'in effect' : 'not in effect'}\nMaximum path: 4\nRouting for Networks:\n${rip.networks.map((n) => `\t${n}`).join('\n')}\n`;
    if (rip.passive.size) out += `Passive Interface(s):\n${[...rip.passive].map((n) => `\t${n}`).join('\n')}\n`;
    out += 'Routing Information Sources:\n\tGateway         Distance      Last Update\n';
    for (const [g, t] of sources) out += `\t${g.padEnd(16)}120           ${uptime(this.d.now - t)}\n`;
    out += 'Distance: (default is 120)\n';
    return out;
  }

  ospfProtocolText() {
    const o = this.d.ospf;
    if (!o.enabled) return '';
    const areas = new Set([...o.ifs.values()].map((st) => st.area));
    let out = `Routing Protocol is "ospf ${o.processId}"
  Outgoing update filter list for all interfaces is not set
  Incoming update filter list for all interfaces is not set
  Router ID ${o.routerId || '0.0.0.0'}
  Number of areas in this router is ${areas.size}. ${areas.size} normal 0 stub 0 nssa
  Maximum path: 4
  Reference bandwidth unit is ${o.referenceBw} mbps
  Routing for Networks:
${o.networks.map((n) => `    ${n.ip} ${n.wildcard} area ${n.area}`).join('\n')}${o.networks.length ? '\n' : ''}`;
    if (o.passive.size) out += `  Passive Interface(s):\n${[...o.passive].map((n) => `    ${n}`).join('\n')}\n`;
    out += '  Routing Information Sources:\n    Gateway         Distance      Last Update\n';
    for (const src of o.sources()) out += `    ${src.rid.padEnd(16)}110           ${uptime(this.d.now - src.born)}\n`;
    out += '  Distance: (default is 110)\n';
    return out;
  }

  showOspfDatabase() {
    const o = this.d.ospf;
    if (!o.enabled) { this.print('\n'); return; }
    const live = [...o.lsdb.values()].filter((l) => !l.maxAge).sort((a, b) => ipToInt(a.id) - ipToInt(b.id) || ipToInt(a.adv) - ipToInt(b.adv));
    const age = (l) => String(Math.min(3600, Math.floor((this.d.now - (l.born ?? 0)) / 1000)));
    const seq = (l) => `0x${(l.seq >>> 0).toString(16).padStart(8, '0')}`;
    let out = `\n            OSPF Router with ID (${o.routerId}) (Process ID ${o.processId})\n`;
    out += `\n                Router Link States (Area ${o.mainArea()})\n\nLink ID         ADV Router      Age         Seq#       Link count\n`;
    for (const l of live.filter((x) => x.type === 'router')) out += `${l.id.padEnd(16)}${l.adv.padEnd(16)}${age(l).padEnd(12)}${seq(l)} ${(l.links || []).length}\n`;
    const nets = live.filter((x) => x.type === 'network');
    if (nets.length) {
      out += `\n                Net Link States (Area ${o.mainArea()})\n\nLink ID         ADV Router      Age         Seq#       Routers\n`;
      for (const l of nets) out += `${l.id.padEnd(16)}${l.adv.padEnd(16)}${age(l).padEnd(12)}${seq(l)} ${l.attached.length}\n`;
    }
    this.print(out);
  }

  showOspfIfBrief() {
    const o = this.d.ospf;
    if (!o.enabled) { this.print('\n'); return; }
    let out = 'Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C\n';
    for (const r of o.interfaceRows()) {
      out += `${shortIf(r.iface).padEnd(13)}${String(o.processId).padEnd(6)}${String(r.area).padEnd(16)}${`${r.ip}/${maskToPrefix(r.mask)}`.padEnd(19)}${String(r.cost).padEnd(6)}${r.state.padEnd(6)}${r.full}/${r.count}\n`;
    }
    this.print(out);
  }

  // ---------------- running-config ----------------

  runningConfig() {
    const d = this.d;
    const L = ['!', 'version 1.0', 'no service timestamps log datetime msec', 'no service timestamps debug datetime msec', 'no service password-encryption', '!', `hostname ${d.hostname}`, '!'];
    if (d.enableSecret) L.push(`enable secret 5 ${fakeHash(d.enableSecret)}`);
    if (d.enablePassword) L.push(`enable password ${d.enablePassword}`);
    if (d.enableSecret || d.enablePassword) L.push('!');
    if (d.type === 'router') {
      for (const [a, b] of d.dhcpServer.excluded) L.push(`ip dhcp excluded-address ${a}${b && b !== a ? ` ${b}` : ''}`);
      if (d.dhcpServer.excluded.length) L.push('!');
      for (const p of d.dhcpServer.pools) {
        L.push(`ip dhcp pool ${p.name}`);
        if (p.network) L.push(` network ${p.network} ${p.mask}`);
        if (p.defaultRouter) L.push(` default-router ${p.defaultRouter}`);
        if (p.dns) L.push(` dns-server ${p.dns}`);
        L.push('!');
      }
      L.push('ip cef', 'no ipv6 cef', '!', 'spanning-tree mode pvst', '!');
      for (const i of d.ifaces) {
        L.push(`interface ${i.name}`);
        if (i.description) L.push(` description ${i.description}`);
        if (i.parent && i.vlan !== null) L.push(` encapsulation dot1Q ${i.vlan}${i.nativeVlan ? ' native' : ''}`);
        if (i.bandwidth) L.push(` bandwidth ${i.bandwidth}`);
        if (i.ip) L.push(` ip address ${i.ip} ${i.mask}`); else L.push(' no ip address');
        for (const h of i.helpers || []) L.push(` ip helper-address ${h}`);
        if (i.aclIn) L.push(` ip access-group ${i.aclIn} in`);
        if (i.aclOut) L.push(` ip access-group ${i.aclOut} out`);
        if (i.nat) L.push(` ip nat ${i.nat}`);
        if (i.ospf?.hello !== undefined) L.push(` ip ospf hello-interval ${i.ospf.hello}`);
        if (i.ospf?.dead !== undefined) L.push(` ip ospf dead-interval ${i.ospf.dead}`);
        if (i.ospf?.priority !== undefined) L.push(` ip ospf priority ${i.ospf.priority}`);
        if (i.ospf?.cost !== undefined) L.push(` ip ospf cost ${i.ospf.cost}`);
        if (!i.parent) L.push(' duplex auto', ' speed auto');
        if (i.parent ? i.shutdown : i.port.shutdown) L.push(' shutdown');
        L.push('!');
      }
      if (d.rip.enabled) {
        L.push('router rip');
        if (d.rip.version === 2) L.push(' version 2');
        for (const p of d.rip.passive) L.push(` passive-interface ${p}`);
        for (const n of d.rip.networks) L.push(` network ${n}`);
        if (!d.rip.autoSummary) L.push(' no auto-summary');
        L.push('!');
      }
      if (d.ospf.enabled) {
        L.push(`router ospf ${d.ospf.processId}`);
        if (d.ospf.routerIdConfigured) L.push(` router-id ${d.ospf.routerIdConfigured}`);
        L.push(d.ospf.logAdjacency ? ' log-adjacency-changes' : ' no log-adjacency-changes');
        if (d.ospf.referenceBw !== 100) L.push(` auto-cost reference-bandwidth ${d.ospf.referenceBw}`);
        for (const p of d.ospf.passive) L.push(` passive-interface ${p}`);
        for (const n of d.ospf.networks) L.push(` network ${n.ip} ${n.wildcard} area ${n.area}`);
        L.push('!');
      }
      for (const r of d.nat.rules) L.push(`ip nat inside source list ${r.acl} interface ${r.iface} overload`);
      L.push('ip classless');
      for (const r of d.staticRoutes) L.push(`ip route ${r.network} ${r.mask} ${r.iface ? r.iface + (r.nextHop ? ` ${r.nextHop}` : '') : r.nextHop}${r.ad && r.ad !== 1 ? ` ${r.ad}` : ''}`);
      L.push('!', 'ip flow-export version 9', '!');
      for (const [n] of [...d.acl.lists.entries()].sort((a, b) => a[0] - b[0])) for (const l of d.acl.lines(n)) L.push(`access-list ${n} ${l}`);
      if (d.acl.lists.size) L.push('!');
    } else {
      L.push('spanning-tree mode pvst');
      if (!d.stp.enabled) L.push('no spanning-tree vlan 1');
      if (d.stp.priority !== 32768) L.push(`spanning-tree vlan 1 priority ${d.stp.priority}`);
      L.push('spanning-tree extend system-id', '!');
      for (const p of d.ports) {
        L.push(`interface ${p.name}`);
        if (p.sw.description) L.push(` description ${p.sw.description}`);
        if (p.sw.mode === 'trunk') {
          if (p.sw.nativeVlan !== 1) L.push(` switchport trunk native vlan ${p.sw.nativeVlan}`);
          if (p.sw.allowed) L.push(` switchport trunk allowed vlan ${compressRange(p.sw.allowed) || 'none'}`);
          L.push(' switchport mode trunk');
        } else {
          if (p.sw.accessVlan !== 1) L.push(` switchport access vlan ${p.sw.accessVlan}`);
          if (p.sw.modeSet || p.sw.accessVlan !== 1 || p.sw.mode === 'access') { /* default */ }
        }
        if (p.shutdown) L.push(' shutdown');
        L.push('!');
      }
      for (const i of d.ifaces.filter((x) => x.isSvi)) {
        L.push(`interface ${i.name}`);
        if (i.description) L.push(` description ${i.description}`);
        if (i.ip) L.push(` ip address ${i.ip} ${i.mask}`); else L.push(' no ip address');
        if (i.shutdown) L.push(' shutdown');
        L.push('!');
      }
      if (d.defaultGateway) L.push(`ip default-gateway ${d.defaultGateway}`, '!');
    }
    if (d.banner) L.push(`banner motd ^C${d.banner}^C`, '!');
    L.push('!', 'line con 0', '!', 'line aux 0', '!', 'line vty 0 4', ' login', '!', '!', 'end');
    return L.join('\n') + '\n';
  }
}

function range(a, b) { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; }
void wildcardToMask; void addrToString;
