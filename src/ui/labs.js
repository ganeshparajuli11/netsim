// Guided labs: each one builds a starting topology, explains the goal and checks the result.

import { Network } from '../engine/network.js';
import { createDevice, serializeNetwork, loadNetwork } from '../engine/factory.js';
import { inSubnet } from '../engine/util.js';

// ---------- building helpers ----------
function dev(net, type, name, x, y) { return createDevice(net, type, { name, x, y }); }
function wire(net, a, pa, b, pb) {
  const A = net.findDevice(a), B = net.findDevice(b);
  net.connect(A.getPort(pa), B.getPort(pb));
}

// ---------- checking helpers ----------
function find(net, name) { return net.findDevice(name); }

/** Runs a ping in a private copy of the network so the learner's simulation is untouched. */
export function canReach(net, from, toIp, { warmup = 12000 } = {}) {
  const copy = loadNetwork(serializeNetwork(net), new Network());
  copy.settle(warmup);
  const src = copy.findDevice(from);
  if (!src || !src.ping) return false;
  let got = 0;
  // two rounds: the first may be eaten by ARP on routers
  src.ping(toIp, { count: 3, timeout: 1500, interval: 200, onResult: () => {}, onDone: () => {} });
  copy.settle(8000);
  src.ping(toIp, { count: 3, timeout: 1500, interval: 200, onResult: (r) => { if (r.kind === 'reply') got++; }, onDone: () => {} });
  copy.settle(8000);
  return got > 0;
}

function hostIp(net, name) { return find(net, name)?.nic?.ip || null; }

function ifaceIp(net, name, ifname) { return find(net, name)?.getIface?.(ifname)?.ip || null; }

const isDefault = (r) => r.network === '0.0.0.0' && r.mask === '0.0.0.0';

/** The static default route that uses the primary link, or null. */
function primaryDefault(r1) {
  return r1.staticRoutes.find((r) => isDefault(r) && (r.nextHop === '10.0.0.2' || (!r.nextHop && r.iface === 'GigabitEthernet0/1')) && (r.ad ?? 1) < 255) || null;
}

/** True when a default route over the backup link loses to the primary one. */
function backupDefault(r1) {
  const primary = primaryDefault(r1);
  if (!primary) return false;
  return r1.staticRoutes.some((r) => isDefault(r) && (r.nextHop === '10.0.1.2' || (!r.nextHop && r.iface === 'GigabitEthernet0/2')) && (r.ad ?? 1) > (primary.ad ?? 1) && (r.ad ?? 1) < 255);
}

/** A private copy of the network with one port shut down, to test failover. */
function withPortDown(net, device, port) {
  const copy = loadNetwork(serializeNetwork(net), new Network());
  const p = copy.findDevice(device)?.getPort(port);
  if (p) { p.shutdown = true; copy.notifyPort(p); }
  return copy;
}

function settledHostIp(net, name) {
  const copy = loadNetwork(serializeNetwork(net), new Network());
  copy.settle(15000);
  return copy.findDevice(name)?.nic?.ip || null;
}

// OSPF waits one dead interval (40 s) before electing a DR, then exchanges databases
const OSPF_WARMUP = 70000;

/** True when `router` has an OSPF route to `network` through `nextHop`, once OSPF has converged. */
function ospfRouteVia(net, router, network, nextHop) {
  const copy = loadNetwork(serializeNetwork(net), new Network());
  copy.settle(OSPF_WARMUP);
  const r = copy.findDevice(router);
  return !!r?.routes?.().some((x) => x.proto === 'O' && x.network === network && x.nextHop === nextHop);
}

/** Pings Web from both PCs in a private copy and returns R1's NAT translations afterwards. */
function natAfterPings(net) {
  const copy = loadNetwork(serializeNetwork(net), new Network());
  copy.settle(2000);
  for (const pc of ['PC1', 'PC2']) {
    const d = copy.findDevice(pc);
    if (!d?.ping) return [];
    d.ping('203.0.113.10', { count: 3, timeout: 1500, interval: 200 });
    copy.settle(6000);
  }
  return copy.findDevice('R1')?.nat?.translations() || [];
}

export const LABS = [
  {
    id: 'first-lan',
    title: 'Your first LAN',
    level: 'Beginner',
    summary: 'Give two PCs addresses on the same subnet and ping between them.',
    build(net) {
      dev(net, 'switch', 'Switch0', 0, 0);
      dev(net, 'pc', 'PC0', -180, 140);
      dev(net, 'pc', 'PC1', 180, 140);
      wire(net, 'PC0', 'FastEthernet0', 'Switch0', 'FastEthernet0/1');
      wire(net, 'PC1', 'FastEthernet0', 'Switch0', 'FastEthernet0/2');
    },
    guide: `<p>A switch joins devices on one local network. Each PC needs an IP address in the <em>same subnet</em> before they can talk.</p>
      <ol>
        <li>Double-click <b>PC0</b>, open <b>IP configuration</b> and enter <code>192.168.1.10</code> with mask <code>255.255.255.0</code>.</li>
        <li>Give <b>PC1</b> <code>192.168.1.11</code> / <code>255.255.255.0</code>.</li>
        <li>On PC0 open <b>Command prompt</b> and run <code>ping 192.168.1.11</code>.</li>
        <li>Switch to <b>Simulation</b> mode and ping again. Step through the ARP request, the ARP reply and the ICMP echo.</li>
      </ol>`,
    checks: [
      { text: 'PC0 has an address in 192.168.1.0/24', fn: (n) => !!hostIp(n, 'PC0') && inSubnet(hostIp(n, 'PC0'), '192.168.1.0', '255.255.255.0') },
      { text: 'PC1 has an address in 192.168.1.0/24', fn: (n) => !!hostIp(n, 'PC1') && inSubnet(hostIp(n, 'PC1'), '192.168.1.0', '255.255.255.0') },
      { text: 'PC0 can ping PC1', fn: (n) => !!hostIp(n, 'PC1') && canReach(n, 'PC0', hostIp(n, 'PC1')) },
    ],
  },
  {
    id: 'router-basics',
    title: 'Connect two networks with a router',
    level: 'Beginner',
    summary: 'Configure router interfaces from the CLI and set default gateways.',
    build(net) {
      dev(net, 'router', 'R1', 0, -40);
      dev(net, 'switch', 'S1', -220, 60);
      dev(net, 'switch', 'S2', 220, 60);
      dev(net, 'pc', 'PC-A', -220, 200);
      dev(net, 'pc', 'PC-B', 220, 200);
      wire(net, 'R1', 'GigabitEthernet0/0', 'S1', 'GigabitEthernet0/1');
      wire(net, 'R1', 'GigabitEthernet0/1', 'S2', 'GigabitEthernet0/1');
      wire(net, 'PC-A', 'FastEthernet0', 'S1', 'FastEthernet0/1');
      wire(net, 'PC-B', 'FastEthernet0', 'S2', 'FastEthernet0/1');
      find(net, 'PC-A').setStatic({ ip: '10.1.1.10', mask: '255.255.255.0' });
      find(net, 'PC-B').setStatic({ ip: '10.2.2.10', mask: '255.255.255.0' });
    },
    guide: `<p>PC-A (10.1.1.10/24) and PC-B (10.2.2.10/24) are on different subnets, so traffic between them must go through <b>R1</b>.</p>
      <ol>
        <li>Open R1's <b>CLI</b> and enter:<br><code>enable</code><br><code>configure terminal</code><br><code>interface g0/0</code><br><code>ip address 10.1.1.1 255.255.255.0</code><br><code>no shutdown</code></li>
        <li>Do the same for <code>g0/1</code> with <code>10.2.2.1 255.255.255.0</code>.</li>
        <li>Set PC-A's default gateway to <code>10.1.1.1</code> and PC-B's to <code>10.2.2.1</code>.</li>
        <li>Ping PC-B from PC-A, then run <code>tracert 10.2.2.10</code>.</li>
        <li>Back in the CLI, <code>end</code> then <code>show ip route</code> and <code>show ip interface brief</code>.</li>
      </ol>`,
    checks: [
      { text: 'R1 G0/0 is 10.1.1.1', fn: (n) => ifaceIp(n, 'R1', 'GigabitEthernet0/0') === '10.1.1.1' },
      { text: 'R1 G0/1 is 10.2.2.1', fn: (n) => ifaceIp(n, 'R1', 'GigabitEthernet0/1') === '10.2.2.1' },
      { text: 'Both interfaces are up (no shutdown)', fn: (n) => ['GigabitEthernet0/0', 'GigabitEthernet0/1'].every((i) => find(n, 'R1').getPort(i).isUp()) },
      { text: 'PC-A uses R1 as its default gateway', fn: (n) => find(n, 'PC-A').defaultGateway === '10.1.1.1' },
      { text: 'PC-A can ping PC-B', fn: (n) => canReach(n, 'PC-A', '10.2.2.10') },
    ],
  },
  {
    id: 'dhcp',
    title: 'Automatic addressing with DHCP',
    level: 'Beginner',
    summary: 'Turn the router into a DHCP server and let the PCs configure themselves.',
    build(net) {
      dev(net, 'router', 'R1', 0, -60);
      dev(net, 'switch', 'S1', 0, 60);
      ['PC1', 'PC2', 'PC3'].forEach((n, i) => {
        dev(net, 'pc', n, -200 + i * 200, 200);
        wire(net, n, 'FastEthernet0', 'S1', `FastEthernet0/${i + 1}`);
        find(net, n).setDhcp();
      });
      wire(net, 'R1', 'GigabitEthernet0/0', 'S1', 'GigabitEthernet0/1');
    },
    guide: `<p>The PCs are set to <b>DHCP</b>, but nothing answers yet. Make R1 hand out addresses from 192.168.10.0/24, keeping .1 to .9 for infrastructure.</p>
      <ol>
        <li>Give R1 G0/0 the address <code>192.168.10.1 255.255.255.0</code> and bring it up with <code>no shutdown</code>.</li>
        <li><code>ip dhcp excluded-address 192.168.10.1 192.168.10.9</code></li>
        <li><code>ip dhcp pool LAN</code><br><code>network 192.168.10.0 255.255.255.0</code><br><code>default-router 192.168.10.1</code></li>
        <li>On each PC run <code>ipconfig /renew</code> (or toggle DHCP in IP configuration).</li>
        <li>In simulation mode, watch the four steps: DISCOVER, OFFER, REQUEST, ACK. Then try <code>show ip dhcp binding</code>.</li>
      </ol>`,
    checks: [
      { text: 'R1 G0/0 is 192.168.10.1/24 and up', fn: (n) => ifaceIp(n, 'R1', 'GigabitEthernet0/0') === '192.168.10.1' && find(n, 'R1').getPort('GigabitEthernet0/0').isUp() },
      { text: 'A DHCP pool covers 192.168.10.0/24', fn: (n) => find(n, 'R1').dhcpServer.pools.some((p) => p.network === '192.168.10.0' && p.mask === '255.255.255.0') },
      { text: 'Addresses .1 to .9 are excluded', fn: (n) => find(n, 'R1').dhcpServer.isExcluded('192.168.10.5') },
      { text: 'PC1 gets an address from the pool', fn: (n) => { const ip = settledHostIp(n, 'PC1'); return !!ip && inSubnet(ip, '192.168.10.0', '255.255.255.0'); } },
      { text: 'PC1 can ping its gateway', fn: (n) => canReach(n, 'PC1', '192.168.10.1') },
    ],
  },
  {
    id: 'vlans',
    title: 'VLANs and router-on-a-stick',
    level: 'Intermediate',
    summary: 'Split one switch into two VLANs and route between them over a trunk.',
    build(net) {
      dev(net, 'router', 'R1', 0, -100);
      dev(net, 'switch', 'S1', 0, 30);
      dev(net, 'pc', 'Sales-1', -260, 170);
      dev(net, 'pc', 'Sales-2', -90, 170);
      dev(net, 'pc', 'Eng-1', 90, 170);
      dev(net, 'pc', 'Eng-2', 260, 170);
      wire(net, 'R1', 'GigabitEthernet0/0', 'S1', 'GigabitEthernet0/1');
      wire(net, 'Sales-1', 'FastEthernet0', 'S1', 'FastEthernet0/1');
      wire(net, 'Sales-2', 'FastEthernet0', 'S1', 'FastEthernet0/2');
      wire(net, 'Eng-1', 'FastEthernet0', 'S1', 'FastEthernet0/11');
      wire(net, 'Eng-2', 'FastEthernet0', 'S1', 'FastEthernet0/12');
      find(net, 'Sales-1').setStatic({ ip: '192.168.10.11', mask: '255.255.255.0', gateway: '192.168.10.1' });
      find(net, 'Sales-2').setStatic({ ip: '192.168.10.12', mask: '255.255.255.0', gateway: '192.168.10.1' });
      find(net, 'Eng-1').setStatic({ ip: '192.168.20.11', mask: '255.255.255.0', gateway: '192.168.20.1' });
      find(net, 'Eng-2').setStatic({ ip: '192.168.20.12', mask: '255.255.255.0', gateway: '192.168.20.1' });
    },
    guide: `<p>Sales (192.168.10.0/24) and Engineering (192.168.20.0/24) share switch S1. Separate them with VLANs, then route between them on R1 using one trunk link.</p>
      <ol>
        <li>On S1: <code>vlan 10</code>, <code>name SALES</code>, <code>vlan 20</code>, <code>name ENG</code>.</li>
        <li><code>interface range fa0/1 - 2</code>, <code>switchport mode access</code>, <code>switchport access vlan 10</code>. Do the same for <code>fa0/11 - 12</code> in VLAN 20.</li>
        <li><code>interface g0/1</code>, <code>switchport mode trunk</code>.</li>
        <li>On R1: <code>interface g0/0</code>, <code>no shutdown</code>, then <code>interface g0/0.10</code>, <code>encapsulation dot1Q 10</code>, <code>ip address 192.168.10.1 255.255.255.0</code>.</li>
        <li>Create <code>g0/0.20</code> for VLAN 20 with <code>192.168.20.1</code>.</li>
        <li>Ping Eng-1 from Sales-1. In simulation mode, open a frame on the trunk and find its 802.1Q tag.</li>
      </ol>`,
    checks: [
      { text: 'VLAN 10 and VLAN 20 exist on S1', fn: (n) => find(n, 'S1').vlans.has(10) && find(n, 'S1').vlans.has(20) },
      { text: 'Sales ports are in VLAN 10, Eng ports in VLAN 20', fn: (n) => { const s = find(n, 'S1'); return s.getPort('FastEthernet0/1').sw.accessVlan === 10 && s.getPort('FastEthernet0/2').sw.accessVlan === 10 && s.getPort('FastEthernet0/11').sw.accessVlan === 20 && s.getPort('FastEthernet0/12').sw.accessVlan === 20; } },
      { text: 'S1 G0/1 is a trunk', fn: (n) => find(n, 'S1').getPort('GigabitEthernet0/1').sw.mode === 'trunk' },
      { text: 'Sales-1 can ping Sales-2', fn: (n) => canReach(n, 'Sales-1', '192.168.10.12') },
      { text: 'Sales-1 can ping Eng-1 through R1', fn: (n) => canReach(n, 'Sales-1', '192.168.20.11') },
    ],
  },
  {
    id: 'static',
    title: 'Static routes between two routers',
    level: 'Intermediate',
    summary: 'Teach each router about the network it cannot see.',
    build(net) {
      dev(net, 'router', 'R1', -150, 0);
      dev(net, 'router', 'R2', 150, 0);
      dev(net, 'pc', 'PC1', -330, 120);
      dev(net, 'pc', 'PC2', 330, 120);
      wire(net, 'R1', 'GigabitEthernet0/1', 'R2', 'GigabitEthernet0/1');
      wire(net, 'PC1', 'FastEthernet0', 'R1', 'GigabitEthernet0/0');
      wire(net, 'PC2', 'FastEthernet0', 'R2', 'GigabitEthernet0/0');
      const r1 = find(net, 'R1'), r2 = find(net, 'R2');
      const set = (r, i, ip) => { const f = r.getIface(i); f.ip = ip; f.mask = i.endsWith('1') ? '255.255.255.252' : '255.255.255.0'; r.getPort(i).shutdown = false; net.notifyPort(r.getPort(i)); };
      set(r1, 'GigabitEthernet0/0', '172.16.1.1'); set(r1, 'GigabitEthernet0/1', '10.0.0.1');
      set(r2, 'GigabitEthernet0/0', '172.16.2.1'); set(r2, 'GigabitEthernet0/1', '10.0.0.2');
      find(net, 'PC1').setStatic({ ip: '172.16.1.10', mask: '255.255.255.0', gateway: '172.16.1.1' });
      find(net, 'PC2').setStatic({ ip: '172.16.2.10', mask: '255.255.255.0', gateway: '172.16.2.1' });
    },
    guide: `<p>All interfaces are configured, but R1 does not know about 172.16.2.0/24 and R2 does not know about 172.16.1.0/24. Run <code>show ip route</code> on each to see the gap.</p>
      <ol>
        <li>On R1: <code>ip route 172.16.2.0 255.255.255.0 10.0.0.2</code></li>
        <li>On R2: <code>ip route 172.16.1.0 255.255.255.0 10.0.0.1</code></li>
        <li>Ping PC2 from PC1. Try it before step 2 as well: which router drops the reply, and why?</li>
      </ol>`,
    checks: [
      { text: 'R1 has a static route to 172.16.2.0/24', fn: (n) => find(n, 'R1').staticRoutes.some((r) => r.network === '172.16.2.0') },
      { text: 'R2 has a static route to 172.16.1.0/24', fn: (n) => find(n, 'R2').staticRoutes.some((r) => r.network === '172.16.1.0') },
      { text: 'PC1 can ping PC2', fn: (n) => canReach(n, 'PC1', '172.16.2.10') },
    ],
  },
  {
    id: 'default-routes',
    title: 'Default routes to the internet edge',
    level: 'Intermediate',
    summary: 'Send all unknown traffic to the provider, with a floating backup route.',
    build(net) {
      dev(net, 'router', 'R1', -150, 0);
      dev(net, 'router', 'ISP', 150, 0);
      dev(net, 'pc', 'PC1', -400, 0);
      dev(net, 'server', 'Web', 400, 0);
      wire(net, 'PC1', 'FastEthernet0', 'R1', 'GigabitEthernet0/0');
      wire(net, 'R1', 'GigabitEthernet0/1', 'ISP', 'GigabitEthernet0/1');
      wire(net, 'R1', 'GigabitEthernet0/2', 'ISP', 'GigabitEthernet0/2');
      wire(net, 'Web', 'FastEthernet0', 'ISP', 'GigabitEthernet0/0');
      const cfg = [['R1', 'GigabitEthernet0/0', '192.168.1.1', '255.255.255.0'], ['R1', 'GigabitEthernet0/1', '10.0.0.1', '255.255.255.252'],
        ['R1', 'GigabitEthernet0/2', '10.0.1.1', '255.255.255.252'], ['ISP', 'GigabitEthernet0/1', '10.0.0.2', '255.255.255.252'],
        ['ISP', 'GigabitEthernet0/2', '10.0.1.2', '255.255.255.252'], ['ISP', 'GigabitEthernet0/0', '203.0.113.1', '255.255.255.0']];
      for (const [r, i, ip, m] of cfg) { const d = find(net, r); const f = d.getIface(i); f.ip = ip; f.mask = m; d.getPort(i).shutdown = false; net.notifyPort(d.getPort(i)); }
      // the provider already routes back to the branch, with its own floating backup
      find(net, 'ISP').staticRoutes = [
        { network: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.0.1', iface: null, ad: 1 },
        { network: '192.168.1.0', mask: '255.255.255.0', nextHop: '10.0.1.1', iface: null, ad: 5 },
      ];
      find(net, 'PC1').setStatic({ ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
      find(net, 'Web').setStatic({ ip: '203.0.113.10', mask: '255.255.255.0', gateway: '203.0.113.1' });
    },
    guide: `<p>R1 is a branch router with two links to its internet provider. It cannot list every network on the internet, so it needs a <em>default route</em>: <code>0.0.0.0 0.0.0.0</code> matches any destination that no more specific route covers.</p>
      <ol>
        <li>On R1, run <code>show ip route</code>. It says <b>Gateway of last resort is not set</b>, so PC1 cannot reach Web (203.0.113.10).</li>
        <li>Add the default route over the primary link: <code>ip route 0.0.0.0 0.0.0.0 10.0.0.2</code>. Check <code>show ip route</code> again and find the <code>S*</code> entry.</li>
        <li>Add a <em>floating</em> backup over the second link with a higher administrative distance: <code>ip route 0.0.0.0 0.0.0.0 10.0.1.2 10</code>. It stays out of the routing table while the primary route works.</li>
        <li>Ping Web from PC1. Then shut down R1's <code>G0/1</code> and look at <code>show ip route</code>: the backup route with distance 10 takes over.</li>
      </ol>
      <p class="note">Run <code>show running-config</code> on ISP to see how the provider does the same thing for the return path.</p>`,
    checks: [
      { text: 'R1 has a default route over the primary link (10.0.0.2)', fn: (n) => primaryDefault(find(n, 'R1')) !== null },
      { text: 'R1 has a floating default route over the backup link with a higher distance', fn: (n) => backupDefault(find(n, 'R1')) },
      { text: 'PC1 can ping Web', fn: (n) => canReach(n, 'PC1', '203.0.113.10') },
      { text: 'PC1 still reaches Web when the primary link fails', fn: (n) => canReach(withPortDown(n, 'R1', 'GigabitEthernet0/1'), 'PC1', '203.0.113.10') },
    ],
  },
  {
    id: 'rip',
    title: 'Dynamic routing with RIP',
    level: 'Intermediate',
    summary: 'Let three routers discover every network by themselves.',
    build(net) {
      dev(net, 'router', 'R1', -260, 0);
      dev(net, 'router', 'R2', 0, -80);
      dev(net, 'router', 'R3', 260, 0);
      dev(net, 'pc', 'PC1', -380, 140);
      dev(net, 'pc', 'PC3', 380, 140);
      wire(net, 'R1', 'GigabitEthernet0/1', 'R2', 'GigabitEthernet0/0');
      wire(net, 'R2', 'GigabitEthernet0/1', 'R3', 'GigabitEthernet0/1');
      wire(net, 'PC1', 'FastEthernet0', 'R1', 'GigabitEthernet0/0');
      wire(net, 'PC3', 'FastEthernet0', 'R3', 'GigabitEthernet0/0');
      const cfg = [['R1', 'GigabitEthernet0/0', '10.1.0.1', '255.255.255.0'], ['R1', 'GigabitEthernet0/1', '10.12.0.1', '255.255.255.252'],
        ['R2', 'GigabitEthernet0/0', '10.12.0.2', '255.255.255.252'], ['R2', 'GigabitEthernet0/1', '10.23.0.1', '255.255.255.252'],
        ['R3', 'GigabitEthernet0/1', '10.23.0.2', '255.255.255.252'], ['R3', 'GigabitEthernet0/0', '10.3.0.1', '255.255.255.0']];
      for (const [r, i, ip, m] of cfg) { const d = find(net, r); const f = d.getIface(i); f.ip = ip; f.mask = m; d.getPort(i).shutdown = false; net.notifyPort(d.getPort(i)); }
      find(net, 'PC1').setStatic({ ip: '10.1.0.10', mask: '255.255.255.0', gateway: '10.1.0.1' });
      find(net, 'PC3').setStatic({ ip: '10.3.0.10', mask: '255.255.255.0', gateway: '10.3.0.1' });
    },
    guide: `<p>Five subnets, three routers, no routes. Instead of typing static routes everywhere, enable RIP version 2 on every router.</p>
      <ol>
        <li>On each router: <code>router rip</code>, <code>version 2</code>, <code>no auto-summary</code>, <code>network 10.0.0.0</code>.</li>
        <li>Check <code>show ip route</code> on R1. The <b>R</b> entries were learned from neighbours; <code>[120/2]</code> means distance 120, two hops.</li>
        <li>Ping PC3 from PC1, then shut down R2's G0/1 and watch the routes disappear.</li>
      </ol>
      <p class="note">In simulation mode, RIP updates appear every 30 simulated seconds. Untick RIP in the filters to hide them.</p>`,
    checks: [
      { text: 'RIP is running on all three routers', fn: (n) => ['R1', 'R2', 'R3'].every((r) => find(n, r).rip.enabled && find(n, r).rip.networks.length) },
      { text: 'PC1 can ping PC3', fn: (n) => canReach(n, 'PC1', '10.3.0.10', { warmup: 3000 }) },
    ],
  },
  {
    id: 'ospf',
    title: 'OSPF in one area',
    level: 'Intermediate',
    summary: 'Let link-state routing pick the fastest path, and watch it reroute when a link fails.',
    build(net) {
      dev(net, 'router', 'R1', -220, 0);
      dev(net, 'router', 'R2', 0, -130);
      dev(net, 'router', 'R3', 0, 130);
      dev(net, 'router', 'R4', 220, 0);
      dev(net, 'pc', 'PC1', -400, 0);
      dev(net, 'pc', 'PC4', 400, 0);
      wire(net, 'PC1', 'FastEthernet0', 'R1', 'GigabitEthernet0/0');
      wire(net, 'R1', 'GigabitEthernet0/1', 'R2', 'GigabitEthernet0/0');
      wire(net, 'R1', 'GigabitEthernet0/2', 'R3', 'GigabitEthernet0/0');
      wire(net, 'R2', 'GigabitEthernet0/1', 'R4', 'GigabitEthernet0/1');
      wire(net, 'R3', 'GigabitEthernet0/1', 'R4', 'GigabitEthernet0/2');
      wire(net, 'PC4', 'FastEthernet0', 'R4', 'GigabitEthernet0/0');
      const cfg = [
        ['R1', 'GigabitEthernet0/0', '10.1.0.1', '255.255.255.0'], ['R1', 'GigabitEthernet0/1', '10.12.0.1', '255.255.255.252'], ['R1', 'GigabitEthernet0/2', '10.13.0.1', '255.255.255.252'],
        ['R2', 'GigabitEthernet0/0', '10.12.0.2', '255.255.255.252'], ['R2', 'GigabitEthernet0/1', '10.24.0.1', '255.255.255.252'],
        ['R3', 'GigabitEthernet0/0', '10.13.0.2', '255.255.255.252'], ['R3', 'GigabitEthernet0/1', '10.34.0.1', '255.255.255.252'],
        ['R4', 'GigabitEthernet0/0', '10.4.0.1', '255.255.255.0'], ['R4', 'GigabitEthernet0/1', '10.24.0.2', '255.255.255.252'], ['R4', 'GigabitEthernet0/2', '10.34.0.2', '255.255.255.252'],
      ];
      for (const [r, i, ip, m] of cfg) { const d = find(net, r); const f = d.getIface(i); f.ip = ip; f.mask = m; d.getPort(i).shutdown = false; net.notifyPort(d.getPort(i)); }
      // The path through R2 is a slow 10 Mbit/s line
      for (const [r, i] of [['R1', 'GigabitEthernet0/1'], ['R2', 'GigabitEthernet0/0'], ['R2', 'GigabitEthernet0/1'], ['R4', 'GigabitEthernet0/1']]) find(net, r).getIface(i).bandwidth = 10000;
      find(net, 'PC1').setStatic({ ip: '10.1.0.10', mask: '255.255.255.0', gateway: '10.1.0.1' });
      find(net, 'PC4').setStatic({ ip: '10.4.0.10', mask: '255.255.255.0', gateway: '10.4.0.1' });
    },
    guide: `<p>Four routers in a ring. Both paths from PC1 to PC4 have two router hops, but the links through R2 run at 10 Mbit/s (<code>bandwidth 10000</code>) and the links through R3 at 1 Gbit/s. RIP only counts hops, so it can't tell them apart. OSPF can.</p>
      <ol>
        <li>On each router: <code>router ospf 1</code>, then <code>network 10.0.0.0 0.255.255.255 area 0</code>. The wildcard mask says which interfaces join area 0.</li>
        <li>Wait about 40 seconds (or press <b>Skip 30 s</b> twice in simulation mode) while the routers elect a designated router. Then check <code>show ip ospf neighbor</code> on R1: both neighbours should be <b>FULL</b>.</li>
        <li>Run <code>show ip route ospf</code> on R1. The <b>O</b> route to 10.4.0.0/24 shows <code>[110/3]</code>: distance 110 and a total cost of 3, through R3. Each link costs 100 Mbit/s divided by its bandwidth (at least 1), so the R2 path would cost 21.</li>
        <li>Look at <code>show ip ospf database</code>: every router holds the same map of the network, built from router and network LSAs.</li>
        <li>Shut down R1's G0/2 and check the routing table again. OSPF reruns its shortest-path calculation and moves the route to R2 with cost 21.</li>
        <li>Bring G0/2 back with <code>no shutdown</code> before you check your work. The checks test the failover in a copy of your network.</li>
      </ol>
      <p class="note">In simulation mode you can follow hellos, database descriptions, link-state requests, updates and acknowledgements. Untick OSPF in the filters to hide them.</p>`,
    checks: [
      { text: 'OSPF runs on all four routers with a network statement in area 0', fn: (n) => ['R1', 'R2', 'R3', 'R4'].every((r) => find(n, r).ospf.enabled && find(n, r).ospf.networks.some((x) => x.area === 0)) },
      { text: 'R1 learns PC4\'s network (10.4.0.0/24) from OSPF through R3, the faster path', fn: (n) => ospfRouteVia(n, 'R1', '10.4.0.0', '10.13.0.2') },
      { text: 'PC1 can ping PC4', fn: (n) => canReach(n, 'PC1', '10.4.0.10', { warmup: OSPF_WARMUP }) },
      { text: 'PC1 still reaches PC4 when the link from R1 to R3 fails', fn: (n) => canReach(withPortDown(n, 'R1', 'GigabitEthernet0/2'), 'PC1', '10.4.0.10', { warmup: OSPF_WARMUP }) },
    ],
  },
  {
    id: 'acl',
    title: 'Filter traffic with an access list',
    level: 'Advanced',
    summary: 'Stop one host from reaching a server while everyone else still can.',
    build(net) {
      dev(net, 'router', 'R1', 0, 0);
      dev(net, 'switch', 'S1', -220, 0);
      dev(net, 'pc', 'Staff', -380, -110);
      dev(net, 'pc', 'Guest', -380, 110);
      dev(net, 'server', 'Files', 240, 0);
      wire(net, 'R1', 'GigabitEthernet0/0', 'S1', 'GigabitEthernet0/1');
      wire(net, 'Staff', 'FastEthernet0', 'S1', 'FastEthernet0/1');
      wire(net, 'Guest', 'FastEthernet0', 'S1', 'FastEthernet0/2');
      wire(net, 'Files', 'FastEthernet0', 'R1', 'GigabitEthernet0/1');
      const r = find(net, 'R1');
      for (const [i, ip] of [['GigabitEthernet0/0', '192.168.1.1'], ['GigabitEthernet0/1', '192.168.99.1']]) { const f = r.getIface(i); f.ip = ip; f.mask = '255.255.255.0'; r.getPort(i).shutdown = false; net.notifyPort(r.getPort(i)); }
      find(net, 'Staff').setStatic({ ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
      find(net, 'Guest').setStatic({ ip: '192.168.1.50', mask: '255.255.255.0', gateway: '192.168.1.1' });
      find(net, 'Files').setStatic({ ip: '192.168.99.10', mask: '255.255.255.0', gateway: '192.168.99.1' });
    },
    guide: `<p>Everything can reach the <b>Files</b> server. Block <b>Guest</b> (192.168.1.50) but keep Staff working. A standard ACL only matches the source address, so place it close to the destination.</p>
      <ol>
        <li>On R1: <code>access-list 10 deny host 192.168.1.50</code></li>
        <li><code>access-list 10 permit any</code> (without this line, the implicit deny blocks everyone)</li>
        <li><code>interface g0/1</code>, <code>ip access-group 10 out</code></li>
        <li>Ping Files from both PCs, then look at <code>show access-lists</code> for the match counters.</li>
      </ol>`,
    checks: [
      { text: 'An ACL is applied on R1', fn: (n) => find(n, 'R1').ifaces.some((i) => i.aclIn || i.aclOut) },
      { text: 'Staff can still reach Files', fn: (n) => canReach(n, 'Staff', '192.168.99.10') },
      { text: 'Guest cannot reach Files', fn: (n) => !canReach(n, 'Guest', '192.168.99.10') },
    ],
  },
  {
    id: 'nat-overload',
    title: 'Share one public address',
    level: 'Advanced',
    summary: 'Use NAT overload so every PC on a private LAN reaches the internet through one address.',
    build(net) {
      dev(net, 'router', 'R1', -100, 0);
      dev(net, 'switch', 'S1', -330, 0);
      dev(net, 'pc', 'PC1', -500, -110);
      dev(net, 'pc', 'PC2', -500, 110);
      dev(net, 'router', 'ISP', 160, 0);
      dev(net, 'server', 'Web', 410, 0);
      wire(net, 'R1', 'GigabitEthernet0/0', 'S1', 'GigabitEthernet0/1');
      wire(net, 'PC1', 'FastEthernet0', 'S1', 'FastEthernet0/1');
      wire(net, 'PC2', 'FastEthernet0', 'S1', 'FastEthernet0/2');
      wire(net, 'R1', 'GigabitEthernet0/1', 'ISP', 'GigabitEthernet0/1');
      wire(net, 'Web', 'FastEthernet0', 'ISP', 'GigabitEthernet0/0');
      const cfg = [['R1', 'GigabitEthernet0/0', '192.168.1.1', '255.255.255.0'], ['R1', 'GigabitEthernet0/1', '198.51.100.2', '255.255.255.252'],
        ['ISP', 'GigabitEthernet0/1', '198.51.100.1', '255.255.255.252'], ['ISP', 'GigabitEthernet0/0', '203.0.113.1', '255.255.255.0']];
      for (const [r, i, ip, m] of cfg) { const d = find(net, r); const f = d.getIface(i); f.ip = ip; f.mask = m; d.getPort(i).shutdown = false; net.notifyPort(d.getPort(i)); }
      // R1 already sends everything else to the provider; the provider has no route to private addresses
      find(net, 'R1').staticRoutes = [{ network: '0.0.0.0', mask: '0.0.0.0', nextHop: '198.51.100.1', iface: null, ad: 1 }];
      find(net, 'PC1').setStatic({ ip: '192.168.1.10', mask: '255.255.255.0', gateway: '192.168.1.1' });
      find(net, 'PC2').setStatic({ ip: '192.168.1.11', mask: '255.255.255.0', gateway: '192.168.1.1' });
      find(net, 'Web').setStatic({ ip: '203.0.113.10', mask: '255.255.255.0', gateway: '203.0.113.1' });
    },
    guide: `<p>The office LAN uses private addresses (192.168.1.0/24). The provider gave R1 a single public address, 198.51.100.2, and does not route private addresses, so replies to the PCs never come back. <em>NAT overload</em> (also called PAT) lets every PC share R1's public address. R1 tells the conversations apart by their port numbers or ICMP identifiers.</p>
      <ol>
        <li>Ping Web (203.0.113.10) from PC1. It fails: Web answers 192.168.1.10, and the provider has no route to it.</li>
        <li>On R1, list the addresses to translate: <code>access-list 1 permit 192.168.1.0 0.0.0.255</code></li>
        <li>Mark the LAN side: <code>interface g0/0</code>, <code>ip nat inside</code>. Mark the provider side: <code>interface g0/1</code>, <code>ip nat outside</code>.</li>
        <li>Share G0/1's address: <code>ip nat inside source list 1 interface g0/1 overload</code></li>
        <li>Ping Web from both PCs, then run <code>show ip nat translations</code> on R1. Both inside local addresses map to the same inside global address.</li>
      </ol>
      <p class="note">In simulation mode, follow an echo request across R1 and compare the source address before and after it.</p>`,
    checks: [
      { text: 'R1 G0/0 is a NAT inside interface and G0/1 is a NAT outside interface', fn: (n) => find(n, 'R1').getIface('GigabitEthernet0/0').nat === 'inside' && find(n, 'R1').getIface('GigabitEthernet0/1').nat === 'outside' },
      { text: 'R1 overloads G0/1 with an access list that exists', fn: (n) => { const r = find(n, 'R1'); return r.nat.rules.some((x) => x.iface === 'GigabitEthernet0/1' && r.acl.lists.has(x.acl)); } },
      { text: 'PC1 can ping Web', fn: (n) => canReach(n, 'PC1', '203.0.113.10') },
      { text: 'PC2 can ping Web', fn: (n) => canReach(n, 'PC2', '203.0.113.10') },
      { text: 'Both PCs share the public address 198.51.100.2', fn: (n) => { const t = natAfterPings(n); return ['192.168.1.10', '192.168.1.11'].every((ip) => t.some((e) => e.insideLocal === ip && e.insideGlobal === '198.51.100.2')); } },
    ],
  },
  {
    id: 'stp',
    title: 'Loops and spanning tree',
    level: 'Advanced',
    summary: 'See which port spanning tree blocks, then choose the root bridge yourself.',
    build(net) {
      dev(net, 'switch', 'S1', 0, -120);
      dev(net, 'switch', 'S2', -200, 60);
      dev(net, 'switch', 'S3', 200, 60);
      dev(net, 'pc', 'PC1', -200, 200);
      dev(net, 'pc', 'PC2', 200, 200);
      wire(net, 'S1', 'GigabitEthernet0/1', 'S2', 'GigabitEthernet0/1');
      wire(net, 'S1', 'GigabitEthernet0/2', 'S3', 'GigabitEthernet0/1');
      wire(net, 'S2', 'GigabitEthernet0/2', 'S3', 'GigabitEthernet0/2');
      wire(net, 'PC1', 'FastEthernet0', 'S2', 'FastEthernet0/1');
      wire(net, 'PC2', 'FastEthernet0', 'S3', 'FastEthernet0/1');
      find(net, 'PC1').setStatic({ ip: '10.0.0.1', mask: '255.255.255.0' });
      find(net, 'PC2').setStatic({ ip: '10.0.0.2', mask: '255.255.255.0' });
      // fixed bridge MACs so S2 wins the election until the learner changes priorities
      [['S1', '0200.5E10.0003'], ['S2', '0200.5E10.0001'], ['S3', '0200.5E10.0002']].forEach(([n, mac]) => {
        const s = find(net, n); s.baseMac = mac; s.ifaces.forEach((i) => { i.mac = mac; }); s.stp.markDirty();
      });
    },
    guide: `<p>Three switches in a triangle form a loop. Spanning tree breaks it by blocking one port: look for the <b>amber</b> link light.</p>
      <ol>
        <li>Run <code>show spanning-tree</code> on each switch. Which one is the root, and why? (Lowest priority, then lowest MAC address.)</li>
        <li>Make <b>S1</b> the root: <code>spanning-tree vlan 1 priority 4096</code>.</li>
        <li>Check which port is blocked now. PC1 should still reach PC2.</li>
      </ol>`,
    checks: [
      { text: 'S1 is the root bridge', fn: (n) => { const s = find(n, 'S1'); s.stp.ensure(); return s.stp.rootId === s.stp.bridgeId; } },
      { text: 'Exactly one port is blocking', fn: (n) => ['S1', 'S2', 'S3'].flatMap((x) => find(n, x).ports.filter((p) => p.isUp() && !find(n, x).stp.forwarding(p))).length === 1 },
      { text: 'PC1 can ping PC2', fn: (n) => canReach(n, 'PC1', '10.0.0.2') },
    ],
  },
];
