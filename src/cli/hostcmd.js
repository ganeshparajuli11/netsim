// Command prompt for end devices (PC, laptop, server).

import { formatMac, isValidIp } from '../engine/util.js';
import { openTelnet, TELNET_PORT } from '../engine/telnet.js';

const HELP = `Available commands:
  ipconfig [/all | /release | /renew]   Show or change IP settings
  ping [-n count] [-l size] [-f] [-i TTL] [-w timeout] [-t] <host>
                                         Test reachability (ICMP echo)
  tracert <host>                         Show the routers on the path
  telnet <host> [port]                   Open a remote command line on a router or switch
  arp -a | arp -d                        Show or clear the ARP cache
  nslookup <name>                        Ask the DNS server for an address
  netstat -r | route print               Show this host's routing decisions
  hostname                               Show this computer's name
  cls                                    Clear the screen
  help                                   This list
`;

export class HostCmd {
  constructor(host) {
    this.d = host;
    this.busy = null;
    this.out = () => {};
    this.history = [];
    this.remote = null; // the open Telnet session, if any
  }

  print(t) { this.out(t); }
  prompt() { return this.remote ? this.remote.prompt : 'C:\\>'; }
  /** True while the remote device is asking for a password, so the terminal hides typing. */
  get awaitPassword() { return !!this.remote && !this.remote.echo; }
  /** The remote CLI mode, so Ctrl+Z can leave configuration mode on the remote device. */
  get mode() { return this.remote?.mode; }
  banner() { return 'OpenNetSim Command Line 1.0\nType "help" for a list of commands.\n\n'; }

  cancel() {
    if (!this.busy) return;
    if (this.busy.remote) { this.busy.cancel(); return; } // the remote device answers when it has stopped
    this.busy.cancel(); this.busy = null; this.print('^C\n');
  }

  complete(line) {
    if (this.remote) return null;
    const cmds = ['ipconfig', 'ping', 'tracert', 'telnet', 'arp', 'nslookup', 'netstat', 'route', 'hostname', 'cls', 'help'];
    const m = cmds.filter((c) => c.startsWith(line.trim().toLowerCase()));
    return m.length === 1 && !line.includes(' ') ? `${m[0]} ` : null;
  }

  exec(line) {
    if (this.busy) return;
    if (this.remote) { this.sendRemote(line); return; }
    const t = line.trim().split(/\s+/).filter(Boolean);
    if (!t.length) return;
    this.history.push(line);
    const cmd = t[0].toLowerCase();
    const args = t.slice(1);
    switch (cmd) {
      case 'help': case '?': this.print(HELP); break;
      case 'hostname': this.print(`${this.d.name}\n`); break;
      case 'ipconfig': this.ipconfig(args); break;
      case 'ping': this.ping(args); break;
      case 'tracert': case 'traceroute': this.tracert(args); break;
      case 'telnet': this.telnet(args); break;
      case 'arp': this.arp(args); break;
      case 'nslookup': this.nslookup(args); break;
      case 'netstat': case 'route': this.routes(); break;
      case 'cls': case 'clear': this.print('\f'); break;
      default:
        this.print(`Invalid Command.\n`);
    }
  }

  ipconfig(args) {
    const d = this.d;
    const n = d.nic;
    const a = (args[0] || '').toLowerCase();
    if (a === '/release') {
      if (d.ipMode !== 'dhcp') { this.print('\nThe operation failed as no adapter is in the state permissible for this operation.\n\n'); return; }
      d.dhcp.release();
      this.print('\n   IP Address......................: 0.0.0.0\n   Subnet Mask.....................: 0.0.0.0\n   Default Gateway.................: 0.0.0.0\n   DNS Server......................: 0.0.0.0\n\n');
      return;
    }
    if (a === '/renew') {
      if (d.ipMode !== 'dhcp') { this.print('\nThe operation failed as no adapter is in the state permissible for this operation.\n\n'); return; }
      d.dhcp.start();
      this.print('Requesting an address from a DHCP server...\n');
      const prev = d.dhcp.onChange;
      const finish = (state) => {
        d.dhcp.onChange = prev;
        prev?.(state);
        this.busy = null;
        if (state === 'bound') this.print(`\n   IP Address......................: ${n.ip}\n   Subnet Mask.....................: ${n.mask}\n   Default Gateway.................: ${d.defaultGateway || '0.0.0.0'}\n   DNS Server......................: ${d.dnsServer || '0.0.0.0'}\n\n`);
        else this.print('\nDHCP request failed. Using an automatic private address.\n\n');
        this.onBusyDone?.();
      };
      d.dhcp.onChange = finish;
      this.busy = { cancel: () => { d.dhcp.onChange = prev; } };
      return;
    }
    const all = a === '/all';
    let out = '\nFastEthernet0 Connection:(default port)\n\n';
    if (all) {
      out += `   Connection-specific DNS Suffix..: \n   Physical Address................: ${formatMac(n.mac, 'dash').toUpperCase()}\n   DHCP Enabled....................: ${d.ipMode === 'dhcp' ? 'Yes' : 'No'}\n`;
    } else out += '   Connection-specific DNS Suffix..: \n';
    out += `   IPv4 Address....................: ${n.ip || '0.0.0.0'}\n   Subnet Mask.....................: ${n.mask || '0.0.0.0'}\n   Default Gateway.................: ${d.defaultGateway || '0.0.0.0'}\n`;
    if (all) out += `   DHCP Servers....................: ${d.dhcp.server || '0.0.0.0'}\n   DNS Servers.....................: ${d.dnsServer || '0.0.0.0'}\n`;
    if (!d.nic.port.isUp()) out += '\n   Media State.....................: Media disconnected\n';
    this.print(out + '\n');
  }

  ping(args) {
    let count = 4;
    let size = 32;
    let df = false;
    let ttl = null;
    let timeout = 1000;
    let host = null;
    const usage = 'Usage: ping [-t] [-n count] [-l size] [-f] [-i TTL] [-w timeout] <host>\n';
    const number = (flag, lo, hi) => {
      const v = args[flag.i + 1];
      if (v === undefined || !/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi) {
        this.print(v === undefined ? `Value must be supplied for option ${flag.name}.\n` : `Bad value for option ${flag.name}, valid range is from ${lo} to ${hi}.\n`);
        return null;
      }
      return Number(v);
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      const flag = { i, name: a };
      if (a === '-n') { if ((count = number(flag, 1, 100)) === null) return; i++; }
      else if (a === '-l') { if ((size = number(flag, 0, 65500)) === null) return; i++; }
      else if (a === '-i') { if ((ttl = number(flag, 1, 255)) === null) return; i++; }
      else if (a === '-w') { if ((timeout = number(flag, 1, 60000)) === null) return; i++; }
      else if (a === '-f') df = true;
      else if (a === '-t') count = 1000;
      else if (a.startsWith('-')) { this.print(`Bad option ${args[i]}.\n\n${usage}`); return; }
      else host = args[i];
    }
    if (!host) { this.print(usage); return; }
    const d = this.d;
    this.busy = { cancel: () => {} };
    d.resolveName(host, (ip) => {
      if (!ip) { this.busy = null; this.print(`Ping request could not find host ${host}. Please check the name and try again.\n`); this.onBusyDone?.(); return; }
      this.print(`\nPinging ${ip} with ${size} bytes of data:\n\n`);
      const h = d.ping(ip, {
        count, timeout, interval: 1000, size, df, ttl,
        onResult: (r) => {
          if (r.kind === 'reply') this.print(`Reply from ${ip}: bytes=${r.size ?? size} time${r.rtt < 1 ? '<1' : '='}${r.rtt}ms TTL=${r.ttl}\n`);
          else if (r.kind === 'timeout') this.print('Request timed out.\n');
          else if (r.kind === 'ttl') this.print(`Reply from ${r.from}: TTL expired in transit.\n`);
          else if (r.kind === 'too-big') this.print('Packet needs to be fragmented but DF set.\n');
          else if (r.kind === 'unreachable' && r.code === 4) this.print(`Reply from ${r.from}: Packet needs to be fragmented but DF set.\n`);
          else if (r.kind === 'unreachable') this.print(`Reply from ${r.from}: Destination host unreachable.\n`);
          else this.print('PING: transmit failed. General failure.\n');
        },
        onDone: (s) => {
          this.busy = null;
          const lost = s.sent - s.received;
          let out = `\nPing statistics for ${ip}:\n    Packets: Sent = ${s.sent}, Received = ${s.received}, Lost = ${lost} (${Math.round((lost / s.sent) * 100)}% loss),\n`;
          if (s.received) {
            const min = Math.min(...s.rtts), max = Math.max(...s.rtts);
            const avg = Math.round(s.rtts.reduce((x, y) => x + y, 0) / s.rtts.length);
            out += `Approximate round trip times in milli-seconds:\n    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms\n`;
          }
          this.print(out + '\n');
          this.onBusyDone?.();
        },
      });
      this.busy = h;
    });
  }

  tracert(args) {
    const host = args[0];
    if (!host) { this.print('Usage: tracert <host>\n'); return; }
    const d = this.d;
    this.busy = { cancel: () => {} };
    d.resolveName(host, (ip) => {
      if (!ip) { this.busy = null; this.print(`Unable to resolve target system name ${host}.\n`); this.onBusyDone?.(); return; }
      this.print(`\nTracing route to ${ip} over a maximum of 30 hops: \n\n`);
      this.busy = d.traceroute(ip, {
        timeout: 1000,
        onHop: ({ ttl, probes }) => {
          const cells = probes.map((p) => (p.kind === 'timeout' || p.kind === 'no-route' ? '     *   ' : `${String(p.rtt < 1 ? '<1' : p.rtt).padStart(4)} ms  `));
          const from = probes.find((p) => p.from)?.from || 'Request timed out.';
          this.print(`${String(ttl).padStart(3)}  ${cells.join('')}  ${from}\n`);
        },
        onDone: () => { this.busy = null; this.print('\nTrace complete.\n\n'); this.onBusyDone?.(); },
      });
    });
  }

  telnet(args) {
    const host = args[0];
    if (!host) { this.print('Usage: telnet <host> [port]\n'); return; }
    let port = TELNET_PORT;
    if (args[1] !== undefined) {
      if (!/^\d+$/.test(args[1]) || Number(args[1]) < 1 || Number(args[1]) > 65535) { this.print('Bad port number. Use a number from 1 to 65535.\n'); return; }
      port = Number(args[1]);
    }
    const d = this.d;
    let cancelled = false;
    this.busy = { cancel: () => { cancelled = true; } };
    const done = () => { this.busy = null; this.onBusyDone?.(); };
    d.resolveName(host, (ip) => {
      if (cancelled) return; // Ctrl+C while the name was being looked up
      if (!ip) { this.print(`Could not find host ${host}. Please check the name and try again.\n`); done(); return; }
      this.print(`Trying ${ip}${port === TELNET_PORT ? '' : ` port ${port}`} ...`);
      let session = null;
      session = openTelnet(d, ip, port, {
        onOpen: () => {
          this.print('Open\n');
          this.remote = { ip, session, prompt: '', echo: true, mode: undefined };
          this.busy = { remote: true, cancel: () => session.brk() };
        },
        onData: (p) => {
          if (p.text) this.print(p.text);
          if (!p.ready || !this.remote) return;
          Object.assign(this.remote, { prompt: p.prompt || '', echo: p.echo !== false, mode: p.mode });
          done();
        },
        onClose: (why) => {
          this.remote = null;
          this.print(why === 'lost' ? `\n\nConnection to ${ip} lost: the device stopped answering.\n\n`
            : why === 'reset' ? `\n\n[Connection to ${ip} was reset]\n\n`
            : `\n[Connection to ${ip} closed by foreign host]\n`);
          done();
        },
        onFail: (why) => {
          this.print(why === 'refused' ? '\n% Connection refused by remote host\n\n'
            : why === 'no-route' ? '\n% No route to host\n\n'
            : '\n% Connection timed out; remote host not responding\n\n');
          done();
        },
      });
      if (session.state === 'syn-sent') this.busy = { cancel: () => session.abort() };
    });
  }

  /** Ctrl+C at a question from the remote device (such as extended ping) stops the dialogue there. */
  abortDialog() {
    if (!this.remote || this.busy) return;
    const { session } = this.remote;
    this.busy = { remote: true, cancel: () => {} };
    session.brk();
  }

  sendRemote(line) {
    if (this.remote.echo && line.trim()) this.history.push(line);
    const { session } = this.remote;
    this.busy = { remote: true, cancel: () => session.brk() };
    session.send(line, { secret: !this.remote.echo });
  }

  arp(args) {
    const d = this.d;
    if ((args[0] || '').toLowerCase() === '-d') { d.clearArp(); return; }
    if (!d.arp.size) { this.print('No ARP Entries Found\n'); return; }
    let out = `\n  Internet Address      Physical Address      Type\n`;
    for (const [ip, e] of d.arp) out += `  ${ip.padEnd(22)}${formatMac(e.mac).padEnd(22)}dynamic\n`;
    this.print(out + '\n');
  }

  nslookup(args) {
    const name = args[0];
    const d = this.d;
    if (!name) { this.print('Usage: nslookup <name>\n'); return; }
    this.print(`\nServer: ${d.dnsServer || '[none]'}\nAddress: ${d.dnsServer || '0.0.0.0'}\n\n`);
    if (isValidIp(name)) { this.print(`Name: ${name}\n\n`); return; }
    this.busy = { cancel: () => {} };
    d.resolveName(name, (ip) => {
      this.busy = null;
      this.print(ip ? `Non-authoritative answer:\nName:\t${name}\nAddress:  ${ip}\n\n` : `*** ${d.dnsServer || 'DNS'} can't find ${name}: Non-existent domain\n\n`);
      this.onBusyDone?.();
    });
  }

  routes() {
    const d = this.d;
    let out = '===========================================================================\nActive Routes:\nNetwork Destination        Netmask          Gateway       Interface\n';
    for (const r of d.routes()) {
      out += `${r.network.padStart(18)}  ${r.mask.padStart(15)}  ${(r.nextHop || 'On-link').padStart(15)}  ${(r.iface.ip || '').padStart(15)}\n`;
    }
    this.print(out + '===========================================================================\n');
  }
}
