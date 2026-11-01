// Telnet (RFC 854) to routers and switches, carried over a simplified TCP (RFC 9293).
//
// The connection opens with the three-way handshake (SYN, SYN-ACK, ACK) and closes with FIN.
// Sequence and acknowledgement numbers are carried and counted in bytes, but the simulator does
// not retransmit lost data: only the SYN is retried. Each data segment carries text, not raw
// Telnet option bytes. The server side runs one CLI per session on a virtual terminal line
// (vty), configured with `line vty`, `password`, `login` and `transport input`.

export const TELNET_PORT = 23;
/** Sessions a device accepts at once (lines vty 0 to 4). */
export const VTY_LINES = 5;
export const VTY_MAX_LINE = 15;
const SYN_RETRIES = [1000, 2000];   // a SYN is resent after 1 s and again 2 s later
const CONNECT_GIVE_UP = 5000;       // then the client gives up
const SILENCE_LIMIT = 30000;        // a client waiting this long for any answer drops the session
const HANDSHAKE_LIMIT = 10000;      // a half-open connection gives its vty line back after this
const KEEPALIVE = 10000;            // while a remote command runs quietly, the server says it is still there
export const TRANSPORTS = ['all', 'telnet', 'ssh', 'none', 'telnet ssh'];

export function defaultVty() { return { login: true, password: null, transport: 'all' }; }

/** Vty settings from a saved file. Files from before Telnet get the defaults. */
export function loadVty(c) {
  const v = defaultVty();
  if (!c || typeof c !== 'object') return v;
  if (typeof c.login === 'boolean') v.login = c.login;
  if (typeof c.password === 'string' && c.password) v.password = c.password;
  if (TRANSPORTS.includes(c.transport)) v.transport = c.transport;
  return v;
}

export function saveVty(v) { return { login: v.login, password: v.password, transport: v.transport }; }

export function telnetAllowed(v) { return v.transport === 'all' || v.transport === 'telnet' || v.transport === 'telnet ssh'; }

// The engine stays independent of the CLI: ios.js registers how to make a CLI for a session.
let cliFactory = null;
export function setVtyCliFactory(fn) { cliFactory = fn; }

const dataLength = (p) => Math.max(1, (p?.text || p?.line || '').length);

/** Telnet server on a router or switch. */
export class TelnetServer {
  constructor(dev) {
    this.d = dev;
    this.sessions = new Map(); // "clientIp:clientPort" -> VtySession
  }

  /** Every TCP segment addressed to the device comes here. */
  receive(_iface, pkt) {
    const seg = pkt.payload;
    const key = `${pkt.src}:${seg.srcPort}`;
    const s = this.sessions.get(key);
    const d = this.d;
    if (seg.flags === 'SYN') {
      if (s) {
        if (s.state === 'syn-rcvd') { d.explain('Telnet: the client sent its SYN again; answering with SYN-ACK again'); s.sendSynAck(); }
        return;
      }
      if (seg.dstPort !== TELNET_PORT) {
        d.explain(`TCP: nothing listens on port ${seg.dstPort} here, so ${d.hostname} answers with a reset (RST)`);
        this.reset(pkt);
        return;
      }
      if (!telnetAllowed(d.vty)) {
        d.explain(`Telnet: the vty lines only accept "transport input ${d.vty.transport}", so the connection is refused with a reset (RST)`);
        this.reset(pkt);
        return;
      }
      const line = this.freeLine();
      if (line === null) {
        d.explain(`Telnet: all ${VTY_LINES} vty lines are in use, so the connection is refused with a reset (RST)`);
        this.reset(pkt);
        return;
      }
      const ns = new VtySession(this, { peer: pkt.src, peerPort: seg.srcPort, local: pkt.dst, line, isn: seg.seq });
      this.sessions.set(key, ns);
      d.net?.schedule(HANDSHAKE_LIMIT, () => {
        if (ns.state === 'syn-rcvd' && this.sessions.get(key) === ns) this.sessions.delete(key);
      });
      d.explain(`Telnet: connection request (SYN) from ${pkt.src} port ${seg.srcPort}; vty ${line} is free, so ${d.hostname} answers with SYN-ACK`);
      ns.sendSynAck();
      return;
    }
    if (!s) {
      if (seg.flags === 'RST' || seg.flags === 'ACK' || seg.flags === 'FIN-ACK') { d.explain('TCP: segment for a connection that is already closed; ignored'); return; }
      d.explain('TCP: segment for a connection this device does not know; answering with a reset (RST)');
      this.reset(pkt);
      return;
    }
    s.receive(seg);
  }

  reset(pkt) {
    const seg = pkt.payload;
    this.d.sendIp({ src: pkt.dst, dst: pkt.src, proto: 'TCP', payload: { srcPort: seg.dstPort, dstPort: seg.srcPort, flags: 'RST', seq: 0, ack: (seg.seq || 0) + 1 } });
  }

  freeLine() {
    const used = new Set([...this.sessions.values()].map((s) => s.line));
    for (let i = 0; i < VTY_LINES; i++) if (!used.has(i)) return i;
    return null;
  }

  /** Open sessions, in line order (for `show users`). */
  list() { return [...this.sessions.values()].filter((s) => s.state !== 'syn-rcvd').sort((a, b) => a.line - b.line); }

  /** Ends every session, for example when the device reloads. */
  closeAll(text = '') { for (const s of [...this.sessions.values()]) s.close(text); }
}

class VtySession {
  constructor(server, { peer, peerPort, local, line, isn }) {
    this.server = server;
    this.d = server.d;
    this.peer = peer;
    this.peerPort = peerPort;
    this.local = local;
    this.line = line;
    this.state = 'syn-rcvd';
    this.seq = 1000 + Math.floor(Math.random() * 9000);
    this.ack = (isn || 0) + 1;
    this.tries = 0;
    this.cli = null;
    this.buf = '';
    this.flushPending = false;
  }

  send(flags, payload) {
    const seg = { srcPort: TELNET_PORT, dstPort: this.peerPort, flags, seq: this.seq, ack: this.ack };
    if (payload) seg.payload = payload;
    this.seq += flags === 'SYN-ACK' || flags === 'FIN' ? 1 : payload ? dataLength(payload) : 0;
    this.d.sendIp({ src: this.local, dst: this.peer, proto: 'TCP', payload: seg });
  }

  sendSynAck() {
    if (this.state === 'syn-rcvd') {
      this.seq = this.isnSent ?? this.seq;
      this.isnSent = this.seq;
    }
    this.send('SYN-ACK');
  }

  /** Sends text to the client; `ready` means the client may type the next line. */
  sendText(text, { prompt = '', echo = true, ready = true, mode } = {}) {
    this.send('PSH-ACK', { text, prompt, echo, ready, mode });
  }

  receive(seg) {
    const d = this.d;
    if (seg.flags === 'RST') {
      d.explain(`Telnet: ${this.peer} reset the connection; vty ${this.line} is free again`);
      this.drop();
      return;
    }
    if (seg.flags === 'FIN' || seg.flags === 'FIN-ACK') {
      if (seg.flags === 'FIN') {
        d.explain(`Telnet: ${this.peer} closed the connection (FIN); vty ${this.line} is free again`);
        this.ack = (seg.seq || 0) + 1;
        this.send('ACK');
      } else d.explain(`Telnet: ${this.peer} acknowledged the close; vty ${this.line} is free again`);
      this.drop();
      return;
    }
    if (this.state === 'syn-rcvd') {
      if (seg.flags !== 'ACK') return;
      this.state = 'open';
      d.explain(`Telnet: handshake complete (SYN, SYN-ACK, ACK); session from ${this.peer} runs on vty ${this.line}`);
      this.start();
      return;
    }
    const p = seg.payload;
    if (!p) { d.explain('TCP: acknowledgement only, no data'); return; }
    this.ack = (seg.seq || 0) + dataLength(p);
    if (p.brk) { this.interrupt(); return; }
    if (this.state === 'login') this.login(String(p.line ?? ''));
    else if (this.state === 'exec') this.command(String(p.line ?? ''));
  }

  start() {
    const d = this.d;
    const v = d.vty;
    const banner = d.banner ? `\n${d.banner}\n` : '';
    if (v.login && !v.password) {
      d.explain(`Telnet: line vty has "login" but no password, so ${d.hostname} refuses the session. Set one with "password" under "line vty 0 4"`);
      this.close(`${banner}\nPassword required, but none set\n`);
      return;
    }
    if (v.login) {
      d.explain('Telnet: line vty asks for a password (login)');
      this.state = 'login';
      this.sendText(`${banner}\n\nUser Access Verification\n\nPassword: `, { echo: false });
      return;
    }
    d.explain('Telnet: line vty has "no login", so the session starts without a password');
    this.buf = banner;
    this.enterExec();
  }

  login(pw) {
    const d = this.d;
    d.explain('Telnet: a password arrived; Telnet carries it as plain text');
    if (d.vty.password && pw === d.vty.password) {
      d.explain('Telnet: the vty password is correct; the user is in user EXEC mode');
      this.enterExec();
      return;
    }
    this.tries++;
    if (this.tries >= 3) {
      d.explain('Telnet: three wrong passwords; closing the session');
      this.close('% Bad passwords\n');
      return;
    }
    d.explain(`Telnet: wrong vty password (try ${this.tries} of 3)`);
    this.sendText('Password: ', { echo: false });
  }

  enterExec() {
    if (!cliFactory) { this.close('% No command line is available\n'); return; }
    this.state = 'exec';
    const cli = cliFactory(this.d);
    cli.vty = this;
    cli.out = (t) => this.write(t);
    cli.onBusyDone = () => this.flush(true);
    this.cli = cli;
    this.flush(true);
  }

  command(line) {
    const cli = this.cli;
    if (cli.busy) return;
    this.d.explain(cli.awaitPassword ? 'Telnet: the user typed a password, which crossed the network unencrypted' : `Telnet: runs "${line}" on vty ${this.line}`);
    cli.exec(line);
    if (this.state !== 'exec') return; // the command ended the session
    this.flush(!cli.busy);
    if (cli.busy) this.keepAlive();
  }

  /** An empty ACK every few seconds tells the client a long, quiet command is still running. */
  keepAlive() {
    this.d.net?.schedule(KEEPALIVE, () => {
      if (this.state !== 'exec' || !this.cli.busy) return;
      this.send('ACK');
      this.keepAlive();
    });
  }

  interrupt() {
    const cli = this.cli;
    if (!cli) {
      this.d.explain('Telnet: the user pressed Ctrl+C at the password prompt; closing the session');
      this.close('\n');
      return;
    }
    this.d.explain('Telnet: the user pressed Ctrl+C');
    if (cli.busy) cli.cancel();
    else if (cli.dialog) { this.write('^C\n'); cli.abortDialog(); }
    this.flush(true);
  }

  /** CLI output; while a command such as ping runs, it is sent as it appears. */
  write(t) {
    this.buf += t;
    if (this.cli?.busy && !this.flushPending && this.d.net) {
      this.flushPending = true;
      this.d.net.schedule(0, () => {
        this.flushPending = false;
        if (this.state === 'exec' && this.buf && this.cli.busy) this.flush(false);
      });
    }
  }

  flush(ready) {
    if (this.state !== 'exec') return;
    if (!ready && !this.buf) return;
    const cli = this.cli;
    const text = this.buf;
    this.buf = '';
    this.sendText(text, ready ? { prompt: cli.prompt(), echo: !cli.awaitPassword, mode: cli.mode } : { ready: false });
  }

  /** `exit` or `logout` in the session. */
  logout() {
    this.d.explain(`Telnet: the user logged out of vty ${this.line}`);
    this.close('');
  }

  close(text) {
    if (this.state === 'closed') return;
    const extra = this.buf;
    this.buf = '';
    this.state = 'closed';
    this.send('FIN', { text: extra + text, ready: false });
    this.drop();
  }

  drop() {
    this.state = 'closed';
    if (this.cli?.busy) this.cli.busy.cancel?.();
    this.server.sessions.delete(`${this.peer}:${this.peerPort}`);
  }
}

/**
 * Telnet client on a PC. handlers: onOpen(), onData(payload), onClose(reason), onFail(reason)
 * where a failure reason is 'refused', 'timeout' or 'no-route', and a close reason is 'remote',
 * 'reset' or 'lost'.
 */
export function openTelnet(host, ip, port, handlers) {
  const local = host.nextEphemeral++;
  const key = `tcp:${local}`;
  const c = {
    state: 'syn-sent', ip, port, seq: 1000 + Math.floor(Math.random() * 9000), ack: 0, waitingSince: null, lastHeard: host.net.time,
  };
  const timers = [];
  const later = (ms, fn) => timers.push(host.net.schedule(ms, fn));
  const finish = () => {
    c.state = 'closed';
    host.udpHandlers.delete(key);
    for (const t of timers) host.net.cancel(t);
  };
  const send = (flags, payload) => {
    const seg = { srcPort: local, dstPort: port, flags, seq: c.seq, ack: c.ack };
    if (payload) seg.payload = payload;
    if (flags === 'SYN' || flags === 'FIN' || flags === 'FIN-ACK') c.seq += flags === 'SYN' ? 0 : 1;
    else if (payload) c.seq += dataLength(payload);
    return host.sendIp({ dst: ip, proto: 'TCP', payload: seg });
  };
  const sendSyn = () => send('SYN');

  host.udpHandlers.set(key, (pkt) => {
    const seg = pkt.payload;
    if (pkt.src !== ip || seg.srcPort !== port) return;
    c.lastHeard = host.net.time;
    if (seg.flags === 'RST') {
      host.explain(c.state === 'syn-sent' ? `Telnet: ${ip} refused the connection (RST)` : `Telnet: ${ip} reset the connection (RST)`);
      const was = c.state;
      finish();
      if (was === 'syn-sent') handlers.onFail?.('refused'); else handlers.onClose?.('reset');
      return;
    }
    if (c.state === 'syn-sent') {
      if (seg.flags !== 'SYN-ACK') return;
      c.seq += 1;
      c.ack = (seg.seq || 0) + 1;
      c.state = 'open';
      for (const t of timers.splice(0)) host.net.cancel(t);
      host.explain(`Telnet: ${ip} accepted the connection (SYN-ACK); sending ACK to complete the handshake`);
      send('ACK');
      c.waitingSince = host.net.time;
      arm();
      handlers.onOpen?.();
      return;
    }
    if (c.state !== 'open') return;
    const p = seg.payload;
    if (seg.flags === 'FIN') {
      c.ack = (seg.seq || 0) + (p ? dataLength(p) : 0) + 1;
      host.explain(`Telnet: ${ip} closed the session (FIN); acknowledging with FIN-ACK`);
      if (p) handlers.onData?.(p);
      send('FIN-ACK');
      finish();
      handlers.onClose?.('remote');
      return;
    }
    if (p) {
      c.ack = (seg.seq || 0) + dataLength(p);
      host.explain(`Telnet: ${p.text ? `${p.text.length} characters of output` : 'a prompt'} from ${ip}`);
      if (p.ready) c.waitingSince = null;
      handlers.onData?.(p);
    }
  });

  // While the client waits for an answer, a long silence means the session is lost.
  const arm = () => {
    later(SILENCE_LIMIT, () => {
      if (c.state !== 'open' || c.waitingSince === null) return;
      const quiet = host.net.time - c.lastHeard;
      if (quiet < SILENCE_LIMIT) { arm(); return; }
      send('RST'); // tell the server, in case it can still hear us, so it frees the line
      finish();
      handlers.onClose?.('lost');
    });
  };

  const r = sendSyn();
  if (r !== 'ok') {
    finish();
    handlers.onFail?.(r === 'no-route' ? 'no-route' : 'timeout');
    return c;
  }
  let t = 0;
  for (const ms of SYN_RETRIES) { t += ms; later(t, () => { if (c.state === 'syn-sent') sendSyn(); }); }
  later(CONNECT_GIVE_UP, () => { if (c.state === 'syn-sent') { finish(); handlers.onFail?.('timeout'); } });

  c.send = (line, { secret = false } = {}) => {
    if (c.state !== 'open') return;
    c.waitingSince = host.net.time;
    c.lastHeard = host.net.time;
    send('PSH-ACK', secret ? { line, secret: true } : { line });
    arm();
  };
  c.brk = () => {
    if (c.state !== 'open') return;
    c.waitingSince = host.net.time;
    c.lastHeard = host.net.time;
    send('PSH-ACK', { brk: true });
    arm();
  };
  c.abort = () => {
    if (c.state === 'syn-sent') { finish(); return; }
    if (c.state === 'open') { send('FIN'); finish(); }
  };
  return c;
}
