import { Port } from './network.js';
import { randomMac } from './util.js';

let deviceSeq = 1;

export class Device {
  constructor(type, name) {
    this.id = `D${deviceSeq++}`;
    this.type = type;
    this.name = name;
    this.x = 0;
    this.y = 0;
    this.ports = [];
    this.powered = true;
    this.net = null;
    this.consoleLines = []; // unsolicited messages (syslog) waiting for the CLI
  }

  static resetIds() { deviceSeq = 1; }
  static bumpId(id) {
    const n = Number(String(id).replace(/\D/g, ''));
    if (n >= deviceSeq) deviceSeq = n + 1;
  }

  addPort(name, opts = {}) {
    const p = new Port(this, name, { mac: randomMac(), ...opts });
    this.ports.push(p);
    return p;
  }

  getPort(name) {
    const n = String(name).toLowerCase();
    return this.ports.find((p) => p.name.toLowerCase() === n) || null;
  }

  freePorts() { return this.ports.filter((p) => !p.link); }

  /** Frame arrived on a port. */
  receive(_port, _frame) {}

  /** Internal: detects transitions so devices only see real up/down changes. */
  _portState(port) {
    const up = port.isUp();
    if (port._up === up) return;
    port._up = up;
    this.onPortChange(port, up);
  }

  /** Re-evaluates every port (e.g. after power toggling). */
  refreshPorts() {
    for (const p of this.ports) { this.net?.notifyPort(p); }
  }

  /** Port went up or down. */
  onPortChange(_port, _up) {}

  /** Device level status messages (shown in CLI like syslog). */
  syslog(text) {
    this.consoleLines.push(text);
    if (this.consoleLines.length > 200) this.consoleLines.shift();
    this.net?.log(this, text);
  }

  get now() { return this.net ? this.net.time : 0; }

  explain(text) { this.net?.explain(`${this.name}: ${text}`); }

  saveConfig() { return {}; }
  loadConfig(_cfg) {}

  serialize() {
    return { id: this.id, type: this.type, name: this.name, x: this.x, y: this.y, config: this.saveConfig() };
  }
}
