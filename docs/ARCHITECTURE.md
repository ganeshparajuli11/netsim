# Architecture

## The clock

`Network` keeps a priority queue of events ordered by simulated time. When a device puts a frame on a cable (`net.transmit(port, frame)`), that schedules a delivery one hop-delay later (1 ms). Timers (ARP timeouts, ping intervals, DHCP retries, RIP updates) use the same queue.

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
- Spanning tree (`stp.js`) computes roles with 802.1D rules (lowest bridge ID wins root, lowest cost wins the root port, lowest sender wins the designated port) whenever the topology changes. It doesn't flood hello BPDUs, which keeps simulation mode readable.

## CLI

`parser.js` is a generic grammar matcher. Each command is a syntax string plus a handler. `IosCli` tracks the mode and context (the current interface, pool, VLAN…) and renders `show` output from live engine state. Long-running commands (`ping`, `traceroute`) set `busy`, stream characters through `out()`, and call `onBusyDone` when finished.

## UI

The UI uses vanilla DOM and SVG:

- `canvas.js` draws devices, cables, link lights and envelopes.
- `devicewin.js` hosts floating windows with tabs.
- `terminal.js` is a small line-editing terminal.
- `app.js` wires modes, the side panel, the inspector, labs and persistence.
