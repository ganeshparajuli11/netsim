# Architecture

## The clock

`Network` keeps a priority queue of events ordered by simulated time. When a device puts a frame on a cable (`net.transmit(port, frame)`), that schedules a delivery one hop-delay later (1 ms). Timers (ARP timeouts, ping intervals, DHCP retries, RIP updates, OSPF hello and dead timers) use the same queue.

- **Realtime mode:** every animation frame, the UI advances the clock by the real elapsed time.
- **Simulation mode:** the clock stands still. *Step* delivers the next batch of frames that arrive at the same instant, running any timers due before them. While a batch is being delivered, `net.current` holds an event record, and devices add sentences to it with `explain()`. Those records become the event list and the packet inspector.

## Frames

Frames are plain objects, `{ src, dst, type: 'ARP'|'IPv4', vlan?, payload }`. They are deep-copied when they go onto a cable, so devices can never accidentally share or mutate another hop's view. A frame with `vlan` set is 802.1Q-tagged on that cable.

## Devices

- `Device` handles ports, power, syslog and serialisation.
- `L3Device` adds interfaces (`{name, port, ip, mask, mac, vlan, parent}`), ARP, a routing table and ICMP. Hosts, routers and switch SVIs all share it:
  - Hosts queue packets while ARP resolves.
  - Routers drop the first one, which is why the first echo of a ping through a router often times out, just as on real routers.
- `Switch` overrides frame reception with learning and forwarding, and lets its own SVI inject frames into the switching fabric.
- OSPF (`ospf.js`) keeps per-interface state (timers, DR, BDR, neighbours) and a link-state database. Hellos go to 224.0.0.5 as IP protocol `OSPF`; neighbours move through INIT, 2WAY, EXSTART, EXCHANGE, LOADING and FULL as in RFC 2328. Each router describes its interfaces in a router LSA (a transit link when it is fully adjacent to the segment's DR, otherwise a stub network), and the DR describes its segment in a network LSA. Database descriptions carry every LSA header in one packet; missing LSAs are fetched with link-state requests. Changes are flooded in link-state updates to 224.0.0.5 and resent every 5 s until acknowledged. After any database change the router runs Dijkstra's shortest-path-first algorithm from itself and installs `O` routes (distance 110) into `ospfRoutes`, next to RIP's `dynamicRoutes`. Interface cost is 100 Mbit/s (`auto-cost reference-bandwidth`) divided by the interface bandwidth, or `ip ospf cost`. LSAs never age out on their own; a router withdraws one by flooding it marked as too old.
- NAT (`nat.js`) does port address translation (RFC 3022). Router interfaces carry `nat: 'inside'|'outside'`. `L3Device.forward` calls the `translateOut` hook after the routing decision and before the outbound ACL; `Router.handleIp` matches packets arriving on an outside interface against the translation table after the inbound ACL and rewrites them before routing. Each entry records the inside local and global address and port (the ICMP echo identifier stands in for a port) and the outside address and port, and expires after an idle timeout. The table is runtime state and is not saved. Static mappings (`nat.statics`, one inside local to one inside global address) are checked before the overload rules on the way out and after the dynamic table on the way in. They rewrite only the address, for every protocol, so outside hosts can start conversations. When a static global address is in an outside interface's subnet, the router answers ARP for it through the `answersArpFor` hook in `L3Device`.
- Access lists (`acl.js`) are kept by key: a number for numbered lists (1-99 standard, 100-199 extended) and a string for named lists, whose type is stored next to them. Every entry has a sequence number and lists stay sorted by it, so `5 deny …` lands before line 10. Entries without a number go after the last line (highest + 10). Remarks are stored as entries that never match. An interface's `aclIn`/`aclOut` holds the key. A list that is missing or has no entries filters nothing. Files saved before sequence numbers get 10, 20, 30… when they load.
- Port security (`portsec.js`) lives in `port.sw.portSecurity` on switch access ports. `Switch.receive` calls `checkPortSecurity` after the VLAN is known and before MAC learning. Each secure address is `static` (configured), `sticky` (learned and kept in the running config and saved file) or `dynamic` (learned and dropped when the link goes down). In `shutdown` mode a violation sets `port.errDisabled`; `Port.isUp()` treats that like a shutdown at either end, so the peer sees the link go down too. `shutdown` on the interface clears it. Dynamic addresses and violation counters are runtime state and are not saved.
- Interface counters live on each `Port` (`port.counters`). `Network.transmit` counts frames out and `Network.runEvent` counts frames in as they arrive. Devices call `dropIn(port, why)` or `dropOut(port, why)` from `Device` when they discard a frame they accepted, which counts it and explains it. Frames for another MAC address are filtered as a network card would and are not drops. `Device.clearCounters()` zeroes them and emits `counters` so the Ports tab redraws; the tab also polls for changes twice a second. Counters are runtime state and are not saved.
- Packet size (`l3.js`): `ipLength(pkt)` counts the IP and ICMP headers plus an echo's `size` bytes of data, and every interface has a 1500-byte MTU (`IP_MTU`). `fitsMtu` runs after the outbound ACL when forwarding and before sending when a device starts a packet. A packet with `df` set that is too big is refused locally (`sendIp` returns `'too-big'`) or, on a router, dropped with ICMP type 3 code 4 carrying the MTU. Without DF the inspector explains the fragmenting, but the packet travels whole.
- Spanning tree (`stp.js`) computes roles with 802.1D rules (lowest bridge ID wins root, lowest cost wins the root port, lowest sender wins the designated port) whenever the topology changes. It doesn't flood hello BPDUs, which keeps simulation mode readable.

## CLI

`parser.js` is a generic grammar matcher. Each command is a syntax string plus a handler. `IosCli` tracks the mode and context (the current interface, pool, VLAN…) and renders `show` output from live engine state. Long-running commands (`ping`, `traceroute`) set `busy`, stream characters through `out()`, and call `onBusyDone` when finished. Question-and-answer commands (extended `ping`) set `dialog`: `prompt()` returns the current question and `exec()` feeds the answer to it until the last question runs the command.

## UI

The UI uses vanilla DOM and SVG:

- `canvas.js` draws devices, cables, link lights and envelopes.
- `devicewin.js` hosts floating windows with tabs.
- `terminal.js` is a small line-editing terminal.
- `app.js` wires modes, the side panel, the inspector, labs and persistence.
