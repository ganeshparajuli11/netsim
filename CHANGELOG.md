# Changelog

Newest first. One entry per merged pull request.

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
