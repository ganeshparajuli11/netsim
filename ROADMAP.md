# Roadmap

The automated daily contributor takes the **first unchecked item**, builds it, ticks it here and notes it in CHANGELOG.md. Humans are welcome to reorder, add or claim items. Put `(claimed: @name)` after an item to keep the bot away from it.

Each item should fit in one focused pull request. Split anything bigger before starting.

## Backlog

- [ ] Static NAT: `ip nat inside source static <inside> <outside>`
- [ ] Named ACLs: `ip access-list standard|extended NAME` with numbered sequence lines and `no <seq>`
- [ ] Switch port security: `switchport port-security`, `maximum`, `mac-address sticky`, `violation shutdown|restrict|protect`, err-disabled state with a red light, `show port-security`
- [ ] Interface counters: packets in/out and drops per interface, shown in `show interfaces` and the Ports tab
- [ ] Extended `ping` dialogue on routers (repeat, size, source, timeout) and `ping` with `-l` size on PCs
- [ ] Telnet from a PC to a router or switch: `line vty 0 4`, `password`, `login`, then a remote CLI in the PC command prompt
- [ ] Undo and redo for workspace edits (add/move/delete device, add/remove cable), Ctrl+Z / Ctrl+Shift+Z
- [ ] Text notes on the workspace: add, edit, move and delete sticky notes saved with the topology
- [ ] Multi-select (shift-click and drag box) to move or delete several devices at once
- [ ] Copy and paste devices with their configuration
- [ ] Export the topology as an SVG or PNG image
- [ ] Simulation "back" step that restores the previous network state
- [ ] Layer 3 switch: `ip routing`, SVIs as routed interfaces, `no switchport` routed ports; lab "Inter-VLAN routing on a multilayer switch"
- [ ] DHCP relay lab using a central server and `ip helper-address`
- [ ] IPv6, part 1: interface addresses, link-local addresses, `ipv6 unicast-routing`, ICMPv6 echo, `show ipv6 interface brief`
- [ ] IPv6, part 2: neighbour discovery (replacing ARP for IPv6), static IPv6 routes, `ping` and `ipconfig` for IPv6 on PCs
- [ ] IPv6, part 3: SLAAC with router advertisements
- [ ] Wireless access point and wireless laptops (SSID, WPA2 passphrase, association shown as a dashed link)
- [ ] Cable types: copper straight-through, crossover and console, with an "auto" choice; console cable opens the CLI from a PC terminal app
- [ ] Lab editor: build a network, write the instructions and pick checks from a menu, then export it as a lab file anyone can load
- [ ] Keyboard-only cabling and device placement for accessibility
- [ ] Translations framework (UI strings in one file) with one extra language
- [ ] EtherChannel (static `channel-group <n> mode on`) with spanning tree treating the bundle as one link
- [ ] Syslog server and NTP client/server services

## Done

- [x] Engine: Ethernet, VLANs, 802.1Q trunks, spanning tree, ARP, IPv4, ICMP, RIPv2, DHCP server and relay, DNS, HTTP, standard and extended ACLs
- [x] IOS-style CLI and PC command prompt
- [x] Simulation mode with packet inspector
- [x] Eight guided labs with automatic checks
- [x] Default and floating static routes: `ip route 0.0.0.0 0.0.0.0 …`, administrative distance on static routes, "Gateway of last resort" in labs; add a lab "Default routes to the internet edge"
- [x] OSPF single area, part 1: `router ospf <id>`, `network <ip> <wildcard> area 0`, neighbour discovery with hellos, `show ip ospf neighbor`
- [x] OSPF single area, part 2: shortest-path routes (cost = 100 Mbps / bandwidth), `show ip route` code `O`, `show ip protocols` for OSPF, lab "OSPF in one area"
- [x] NAT overload (PAT): `ip nat inside/outside`, `ip nat inside source list <acl> interface <if> overload`, `show ip nat translations`, lab "Share one public address"
