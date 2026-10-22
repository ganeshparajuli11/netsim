# OpenNetSim

An open-source network simulator for learning, which runs entirely in your browser. You build a topology by dragging in routers, switches and PCs. You configure them from a command line that works the way real network gear does. Then you switch to **Simulation** mode and follow every frame hop by hop. Each device explains what it decided to do with the packet, and why.

There's no install, no account and no server. Open `index.html` through any static web server, or open the single-file build directly from disk.

## What you can do

| Area | Supported |
|---|---|
| Devices | Router (3 × Gigabit), switch (24 × Fast Ethernet + 2 × Gigabit), hub, PC, laptop, server |
| Layer 2 | MAC learning and flooding, VLANs, access and 802.1Q trunk ports, native VLAN, allowed-VLAN lists, spanning tree (root election, root/designated/blocked ports), switch management SVI |
| Layer 3 | ARP (with proxy ARP on routers), IPv4 forwarding with TTL, longest-prefix match, connected/local/static routes, router-on-a-stick sub-interfaces, RIP version 2 with split horizon and triggered updates |
| Services | DHCP server (router pools or server GUI), DHCP relay (`ip helper-address`), DNS server, simple web server and browser |
| Security | Numbered standard (1–99) and extended (100–199) access lists, `ip access-group in/out`, implicit deny, hit counters |
| Router/switch CLI | User/privileged/config modes, unique-prefix abbreviations (`sh ip int br`), `?` help, Tab completion, history, `do`, `interface range`, `show running-config`, `show ip route`, `show vlan brief`, `show interfaces trunk`, `show spanning-tree`, `show mac address-table`, `show cdp neighbors`, `show ip dhcp binding`, `show access-lists`, `show ip protocols`, `copy run start`, `reload`, `ping`, `traceroute` and more |
| PC command prompt | `ipconfig [/all /release /renew]`, `ping [-n]`, `tracert`, `arp -a/-d`, `nslookup`, `route print` |
| Learning | Simulation mode with step/play, protocol filters, animated envelopes, a per-hop packet inspector (Ethernet, 802.1Q, ARP, IPv4, ICMP, UDP, DHCP, DNS, RIP, HTTP), and eight guided labs with automatic checks |
| Files | Autosave in the browser, plus save/open topologies as `.onsim.json` |

### Guided labs

1. Your first LAN
2. Connect two networks with a router
3. Automatic addressing with DHCP
4. VLANs and router-on-a-stick
5. Static routes between two routers
6. Dynamic routing with RIP
7. Filter traffic with an access list
8. Loops and spanning tree

Each lab builds a starting network, explains the goal and has a **Check my work** button. The checks run in a private copy of your network, so they never disturb what you're doing.

## Running it

```bash
npm start            # serves the folder on http://localhost:8080
npm test             # engine, CLI and lab tests (Node 20+)
npm run build        # dist/opennetsim.html, a single self-contained file
```

`npm start` and the build need Node.js. To run without any tooling, use any static server, for example `python3 -m http.server`, and open `index.html`. ES modules don't load from `file://`, so use the built single file if you want to double-click it.

## How it is built

The project uses plain JavaScript modules, with no framework and no runtime dependencies. The simulation engine doesn't touch the DOM, so it runs the same in Node (tests) and in the browser.

```
src/engine/   network.js   discrete-event clock, cables, frame delivery, event recording
              l3.js        shared IPv4 stack: ARP, ICMP, routing table, ping/traceroute
              host.js      PC / laptop / server (+ DHCP client, DNS, HTTP) and hub
              switch.js    MAC table, VLANs, trunks, SVI          stp.js  spanning tree
              router.js    sub-interfaces, DHCP server/relay      rip.js  RIPv2   acl.js  ACLs
              dhcp.js      DHCP server and client state machines
              factory.js   device catalogue, save/load
src/cli/      parser.js    IOS-style grammar: prefixes, ambiguity, '?' help, Tab
              ios.js       router/switch commands and show output
              hostcmd.js   PC command prompt
src/ui/       app.js, canvas.js, devicewin.js, terminal.js, labs.js, icons.js, styles.css
tests/        node:test suites (engine scenarios, CLI sessions, every lab solved end to end)
```

There's a longer walkthrough in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues include more `show` commands, OSPF, NAT, IPv6, a wireless access point, and more labs.

## Clean-room statement

OpenNetSim is an independent project. It is not affiliated with or endorsed by Cisco Systems. "Cisco", "IOS" and "Packet Tracer" are trademarks of their owners. No code, images, icons, file formats or text were taken from any proprietary simulator.

The behaviour is implemented from public protocol standards (IEEE 802.3, 802.1Q and 802.1D; RFC 791, 792, 826, 2131 and 2453) and widely published command-line conventions. All device artwork is original.
