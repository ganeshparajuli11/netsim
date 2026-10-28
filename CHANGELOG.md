# Changelog

Newest first. One entry per merged pull request.

## 0.7.0 (2026-10-28)

- Named access lists. `ip access-list standard NAME` and `ip access-list extended NAME` open the list in its own mode (`R1(config-std-nacl)#`, `R1(config-ext-nacl)#`), where you type `permit`, `deny` and `remark` lines. Apply them with `ip access-group NAME in|out`, or use one for NAT with `ip nat inside source list NAME interface <if> overload`.
- Sequence numbers. Every line of every list has one. `15 deny …` inserts a line between 10 and 20, a line without a number goes after the last one, and `no 15` removes one line. `no permit|deny …` removes the matching line. `ip access-list resequence NAME <first> <step>` renumbers a list. `ip access-list standard 10` edits numbered list 10 the same way.
- `show access-lists` shows the real sequence numbers and named lists, and takes a list name. `show running-config` prints named lists as `ip access-list` blocks, with remarks. `clear access-list counters [NAME]` clears one list or all of them.
- The packet inspector says which line of the list permitted or denied a packet, and says so when an applied list is missing or empty (both filter nothing).
- The router refuses a name that is already a list of the other type, a number in the wrong range for the type, names that don't start with a letter, and duplicate sequence numbers.
- Access list edits and `ip access-group` changes are now autosaved straight away. Before, they were only saved with the next other change.
- New lab: "Edit a named access list", where you change one line of an extended list so a guest can ping a server but not open its website.
- Saved files keep names, sequence numbers and remarks. Files saved by older versions open with their lines numbered 10, 20, 30…

## 0.6.0 (2026-10-27)

- Static NAT (RFC 3022 basic NAT). `ip nat inside source static <inside local> <inside global>` maps one inside address to one public address in both directions and for every protocol, so hosts on the internet can start conversations with an inside server. Ports and ICMP identifiers are left alone. `no ip nat inside source static …` removes a mapping.
- A static mapping wins over overload rules for the same host; other hosts keep sharing the interface address. ICMP errors about packets from a static address are translated back, so `tracert` works from the inside server. When a router sends an ICMP error about a packet whose destination NAT already rewrote, the error quotes the public address the sender used, so a sender behind another NAT can still match it.
- When the public address is in the outside interface's subnet, the router answers ARP for it on that interface. Addresses the provider routes to the router work without ARP.
- The router refuses mappings that reuse an inside or public address already mapped, use one of its own interface addresses (even on an interface that is down), or map an address to itself.
- `show ip nat translations` lists static entries (`---` for the outside addresses), `show ip nat statistics` counts them, `clear ip nat translation *` keeps them, and they appear in `show running-config`. The packet inspector explains each static translation and the ARP reply.
- New lab: "Publish a server with static NAT", where a home PC opens a website on a private server through its public address.
- Saved files keep static mappings; files saved by older versions open without any.

## 0.5.0 (2026-10-26)

- NAT overload (PAT, RFC 3022). Mark interfaces with `ip nat inside` and `ip nat outside`, then `ip nat inside source list <acl> interface <if> overload` lets every inside host the access list permits share the outside interface's address. Without `overload` the rule is stored as overload, since an interface address can only be shared.
- Flows are told apart by TCP/UDP source port or ICMP echo identifier. A host keeps its own port when it is free; otherwise it gets the next free one. Replies are only translated back when they come from the outside host and port that the flow went to. Anything else is not translated: traffic for the router's own address is handled by the router. NAT is not a firewall, so packets addressed straight to a routable inside address are still routed.
- ICMP errors about a translated packet (TTL exceeded, unreachable) are translated back, so `tracert` works from behind NAT. ICMP errors now quote the TCP/UDP ports of the packet they are about, so errors about web or DNS traffic are mapped back too. If several rules use the same interface, the first one whose access list permits the source is used.
- When an outbound ACL drops a packet after NAT, the unreachable message goes to the inside host and the new translation is not kept.
- Translations expire after being idle (ICMP 60 s, UDP 5 min, TCP 24 h). New commands: `show ip nat translations [verbose]`, `show ip nat statistics`, `clear ip nat translation *`, `clear ip nat statistics`, and the matching `no` forms. The NAT lines appear in `show running-config`.
- Inside to outside, NAT happens after routing and before the outbound ACL; outside to inside, after the inbound ACL and before routing. The packet inspector explains each translation, including when a port had to change and when a host is not permitted by the access list.
- New lab: "Share one public address", where two PCs on a private LAN reach a web server through one provider address.
- Saved files keep the NAT settings; files saved by older versions open with NAT off.

## 0.4.0 (2026-10-25)

- OSPF, part 2: routes. Each router describes its links in a router LSA, and the DR of each segment describes the segment in a network LSA. Database descriptions now carry LSA headers; missing LSAs are fetched with link-state requests (state LOADING), and changes are flooded in link-state updates that are resent every 5 s until acknowledged.
- After every change to the database, routers run Dijkstra's shortest-path-first algorithm and install `O` routes with distance 110 (so OSPF beats RIP). Equal-cost paths are both installed. Routes move to the backup path when a link fails or a neighbour goes quiet.
- Interface cost is 100 Mbit/s divided by the interface bandwidth (at least 1). New commands: `bandwidth <kbit/s>` on router interfaces (also shown in `show interfaces`), `ip ospf cost <n>` and `auto-cost reference-bandwidth <Mbit/s>`.
- New show commands: `show ip route ospf`, `show ip ospf database`, `show ip ospf interface brief`, and an OSPF section in `show ip protocols` (router ID, networks, passive interfaces, reference bandwidth, routing information sources).
- The packet inspector names all five OSPF packet types and lists the LSAs inside requests, updates and acknowledgements.
- New lab: "OSPF in one area", where OSPF picks the faster of two two-hop paths and reroutes when a link fails.
- Saved files keep the new settings; files saved by older versions open with the defaults.

## 0.3.0 (2026-10-24)

- OSPF, part 1: neighbours. `router ospf <id>`, `network <ip> <wildcard> area <n>` (the most specific statement wins), `router-id`, `passive-interface` and `log-adjacency-changes`. The router ID is the configured one, or else the highest address on an interface that is up.
- Routers send hellos every 10 s to 224.0.0.5 and move each neighbour through INIT, 2WAY, EXSTART and FULL. On a shared segment they elect a DR and BDR (priority, then router ID; a router that joins later does not take over), and DROTHERs stay in 2WAY with each other.
- Hellos must come from the same subnet and agree on area, subnet mask, hello and dead intervals. The packet inspector explains which setting does not match. Duplicate router IDs are reported on the console.
- Interface commands `ip ospf hello-interval`, `ip ospf dead-interval` (follows hello x4 unless set) and `ip ospf priority`. `clear ip ospf [<id>] process` applies a new router ID. `no log-adjacency-changes` silences the console messages.
- `show ip ospf neighbor` with state, role, dead time, address and interface. `%OSPF-5-ADJCHG` messages when a neighbour reaches or leaves FULL.
- OSPF packets have their own colour and filter in simulation mode, and the inspector shows the hello and database description fields.
- Routes from OSPF come in part 2.

## 0.2.0 (2026-10-23)

- Default and floating static routes. `ip route` now accepts a distance (1–255) after an interface as well as after a next hop (`ip route 0.0.0.0 0.0.0.0 g0/1 5`, `… g0/2 10.0.1.2 20`). A route with distance 255 stays in the config but is never installed. `no ip route` ignores the distance.
- `show ip route static|connected|rip` lists one kind of route. `show ip route <ip>` marks the default route as the candidate default path.
- The packet inspector says when a router falls back to the default route (gateway of last resort) and when a floating static route is carrying traffic.
- Several cables between the same two devices are now drawn side by side instead of on top of each other.
- New lab: "Default routes to the internet edge", with a primary and a floating backup default route and a failover check.

## 0.1.0 (2026-10-22)

- First release: routers, switches, hubs, PCs, laptops and servers; VLANs, trunks, spanning tree, static routes, RIPv2, DHCP (server and relay), DNS, HTTP and ACLs; IOS-style CLI; simulation mode with packet inspector; eight guided labs.
