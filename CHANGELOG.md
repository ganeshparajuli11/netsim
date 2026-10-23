# Changelog

Newest first. One entry per merged pull request.

## 0.2.0 (2026-10-23)

- Default and floating static routes. `ip route` now accepts a distance (1–255) after an interface as well as after a next hop (`ip route 0.0.0.0 0.0.0.0 g0/1 5`, `… g0/2 10.0.1.2 20`). A route with distance 255 stays in the config but is never installed. `no ip route` ignores the distance.
- `show ip route static|connected|rip` lists one kind of route. `show ip route <ip>` marks the default route as the candidate default path.
- The packet inspector says when a router falls back to the default route (gateway of last resort) and when a floating static route is carrying traffic.
- Several cables between the same two devices are now drawn side by side instead of on top of each other.
- New lab: "Default routes to the internet edge", with a primary and a floating backup default route and a failover check.

## 0.1.0 (2026-10-22)

- First release: routers, switches, hubs, PCs, laptops and servers; VLANs, trunks, spanning tree, static routes, RIPv2, DHCP (server and relay), DNS, HTTP and ACLs; IOS-style CLI; simulation mode with packet inspector; eight guided labs.
