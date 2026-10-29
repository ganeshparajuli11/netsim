// The Network owns devices, links and a discrete-event clock.
// Every frame that crosses a cable becomes a scheduled event, which is what lets the UI
// step through a simulation one hop at a time.

import { clone } from './util.js';

let linkSeq = 1;

export class Port {
  constructor(device, name, { kind = 'ethernet', mac = null } = {}) {
    this.device = device;
    this.name = name;
    this.kind = kind;
    this.mac = mac;
    this.link = null;
    this.shutdown = false;
    this.errDisabled = false; // set by port security; cleared by shutdown / no shutdown
    this._up = false;
  }
  get peer() {
    if (!this.link) return null;
    return this.link.a === this ? this.link.b : this.link.a;
  }
  /** Physical + administrative state of this end. */
  isUp() {
    const p = this.peer;
    return !!(p && !this.shutdown && !p.shutdown && !this.errDisabled && !p.errDisabled && this.device.powered && p.device.powered);
  }
}

export class Link {
  constructor(a, b, type = 'copper') {
    this.id = `L${linkSeq++}`;
    this.a = a;
    this.b = b;
    this.type = type;
  }
  other(port) { return port === this.a ? this.b : this.a; }
}

export class Network {
  constructor() {
    this.devices = new Map();
    this.links = new Map();
    this.time = 0;          // simulated milliseconds
    this.queue = [];
    this.seq = 0;
    this.hopDelay = 1;      // ms per cable hop
    this.recording = false; // simulation mode records every hop
    this.events = [];
    this.eventSeq = 0;
    this.current = null;    // event being processed (for explanations)
    this.listeners = new Map();
    this.maxEvents = 5000;
  }

  // ---------- pub/sub for the UI ----------
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type).delete(fn);
  }
  emit(type, data) {
    for (const fn of this.listeners.get(type) || []) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  }

  // ---------- topology ----------
  addDevice(d) {
    d.net = this;
    this.devices.set(d.id, d);
    this.emit('topology');
    return d;
  }
  removeDevice(id) {
    const d = this.devices.get(id);
    if (!d) return;
    for (const p of d.ports) if (p.link) this.disconnect(p.link.id);
    this.devices.delete(id);
    this.emit('topology');
  }
  findDevice(nameOrId) {
    if (this.devices.has(nameOrId)) return this.devices.get(nameOrId);
    for (const d of this.devices.values()) if (d.name === nameOrId) return d;
    return null;
  }
  uniqueName(base) {
    const names = new Set([...this.devices.values()].map((d) => d.name));
    for (let i = 0; ; i++) {
      const n = `${base}${i}`;
      if (!names.has(n)) return n;
    }
  }

  connect(portA, portB, type = 'copper') {
    if (!portA || !portB) throw new Error('Unknown port');
    if (portA.link || portB.link) throw new Error('Port already in use');
    if (portA.device === portB.device) throw new Error('Cannot connect a device to itself');
    const link = new Link(portA, portB, type);
    portA.link = link;
    portB.link = link;
    this.links.set(link.id, link);
    this.notifyPort(portA);
    this.notifyPort(portB);
    this.emit('topology');
    return link;
  }

  disconnect(linkId) {
    const link = this.links.get(linkId);
    if (!link) return;
    link.a.link = null;
    link.b.link = null;
    this.links.delete(linkId);
    // Drop any frames still on the wire.
    this.queue = this.queue.filter((e) => e.meta?.link !== link);
    link.a.device._portState(link.a);
    link.b.device._portState(link.b);
    this.emit('topology');
  }

  /** Called whenever something may have changed a port's state. */
  notifyPort(port) {
    port.device._portState(port);
    const p = port.peer;
    if (p) p.device._portState(p);
    this.emit('links');
  }

  // ---------- clock ----------
  schedule(delay, fn, meta = null) {
    const ev = { time: this.time + Math.max(0, delay), seq: this.seq++, fn, meta };
    // binary insert keeps the queue ordered by (time, seq)
    let lo = 0, hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this.queue[mid];
      if (q.time < ev.time || (q.time === ev.time && q.seq < ev.seq)) lo = mid + 1; else hi = mid;
    }
    this.queue.splice(lo, 0, ev);
    return ev;
  }
  cancel(ev) {
    const i = this.queue.indexOf(ev);
    if (i >= 0) this.queue.splice(i, 1);
  }

  /** Puts a frame on the cable attached to `port`. */
  transmit(port, frame) {
    if (!port.link || !port.isUp()) return false;
    const to = port.peer;
    const f = clone(frame);
    f._hops = (f._hops || 0) + 1;
    if (f._hops > 64) return false; // loop guard (no STP storm meltdown)
    f._id = f._id || `F${++this.eventSeq}`;
    this.schedule(this.hopDelay, () => to.device.receive(to, f), {
      kind: 'frame', link: port.link, from: port, to, frame: f, sentAt: this.time,
    });
    return true;
  }

  runEvent(ev) {
    this.time = Math.max(this.time, ev.time);
    if (ev.meta?.kind === 'frame') {
      const { from, to, frame } = ev.meta;
      // Cable might have been unplugged while the frame was in flight.
      if (!to.link || to.link !== from.link) return;
      const rec = {
        id: this.events.length + 1,
        time: this.time,
        from: from.device.name,
        fromPort: from.name,
        to: to.device.name,
        toPort: to.name,
        fromId: from.device.id,
        toId: to.device.id,
        linkId: from.link.id,
        frame: this.recording ? clone(frame) : frame, // snapshot as it arrived
        protocol: protocolOf(frame),
        summary: summarize(frame),
        notes: [],
      };
      this.current = rec;
      try { ev.fn(); } finally { this.current = null; }
      if (this.recording) {
        this.events.push(rec);
        if (this.events.length > this.maxEvents) this.events.shift();
        this.emit('event', rec);
      }
    } else {
      ev.fn();
    }
  }

  /** Records a human readable explanation of what the current device decided. */
  explain(text) {
    if (this.current) this.current.notes.push(text);
  }

  /** Runs everything up to absolute time t. */
  runUntil(t) {
    let n = 0;
    while (this.queue.length && this.queue[0].time <= t) {
      this.runEvent(this.queue.shift());
      if (++n > 200000) break; // safety
    }
    this.time = Math.max(this.time, t);
  }
  runFor(ms) { this.runUntil(this.time + ms); }

  /** Runs until the queue is empty (or a time budget is spent). */
  settle(maxMs = 60000) {
    const end = this.time + maxMs;
    while (this.queue.length && this.queue[0].time <= end) this.runEvent(this.queue.shift());
  }

  /** Frames that will arrive at the next frame timestamp (for the simulation animation). */
  pendingFrames() {
    const frames = this.queue.filter((e) => e.meta?.kind === 'frame');
    if (!frames.length) return { time: null, frames: [] };
    const t = Math.min(...frames.map((e) => e.time));
    return { time: t, frames: frames.filter((e) => e.time === t) };
  }

  /** Simulation mode step: process timers until the next batch of frames, then deliver it. */
  step() {
    const { time } = this.pendingFrames();
    if (time === null) {
      // nothing on the wire: advance to the next timer that may put something there
      if (!this.queue.length) return false;
      const ev = this.queue.shift();
      this.runEvent(ev);
      return true;
    }
    while (this.queue.length && this.queue[0].time <= time) this.runEvent(this.queue.shift());
    return true;
  }

  /** Advance timers (non frames) until a frame is pending or nothing is left. */
  advanceToNextFrame(limitMs = 120000) {
    const end = this.time + limitMs;
    while (this.queue.length && this.pendingFrames().time === null && this.queue[0].time <= end) {
      this.runEvent(this.queue.shift());
    }
    return this.pendingFrames().time !== null;
  }

  log(device, text) {
    this.emit('log', { device: device.id, text });
  }
}

export function protocolOf(frame) {
  if (frame.type === 'ARP') return 'ARP';
  if (frame.type === 'STP') return 'STP';
  if (frame.type === 'IPv4') {
    const ip = frame.payload;
    if (ip.proto === 'ICMP') return 'ICMP';
    if (ip.proto === 'UDP') {
      const u = ip.payload;
      if (u.dstPort === 67 || u.dstPort === 68) return 'DHCP';
      if (u.dstPort === 53 || u.srcPort === 53) return 'DNS';
      if (u.dstPort === 520) return 'RIP';
      return 'UDP';
    }
    if (ip.proto === 'TCP') {
      const t = ip.payload;
      if (t.dstPort === 80 || t.srcPort === 80) return 'HTTP';
      return 'TCP';
    }
    if (ip.proto === 'OSPF') return 'OSPF';
    return 'IPv4';
  }
  return frame.type || '?';
}

export const OSPF_TYPES = { Hello: 'hello', DBD: 'database description', LSR: 'link-state request', LSU: 'link-state update', LSAck: 'link-state acknowledgement' };

export function summarize(frame) {
  const p = protocolOf(frame);
  if (p === 'ARP') {
    const a = frame.payload;
    return a.op === 1 ? `Who has ${a.targetIp}? Tell ${a.senderIp}` : `${a.senderIp} is at ${a.senderMac}`;
  }
  if (frame.type === 'IPv4') {
    const ip = frame.payload;
    if (ip.proto === 'ICMP') {
      const t = { 0: 'Echo reply', 8: 'Echo request', 3: 'Destination unreachable', 11: 'Time exceeded' }[ip.payload.type] || `type ${ip.payload.type}`;
      return `${ip.src} → ${ip.dst} ${t}`;
    }
    if (p === 'DHCP') return `DHCP ${ip.payload.payload.msg}`;
    if (p === 'DNS') return `DNS ${ip.payload.payload.qr ? 'response' : 'query'} ${ip.payload.payload.name}`;
    if (p === 'RIP') return `RIP update from ${ip.src}`;
    if (p === 'OSPF') return `OSPF ${OSPF_TYPES[ip.payload.type] || ip.payload.type} from ${ip.payload.routerId}`;
    if (p === 'HTTP') return `HTTP ${ip.payload.payload.method || ip.payload.payload.status || ''}`;
    return `${ip.src} → ${ip.dst} ${ip.proto}`;
  }
  if (p === 'STP') return `BPDU root ${frame.payload.rootId}`;
  return p;
}
