// SVG workspace: devices, cables, link lights, pan/zoom and the packet envelopes of simulation mode.

import { ICONS, PROTO_COLORS } from './icons.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent = null) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export class Canvas {
  constructor(app) {
    this.app = app;
    this.svg = document.getElementById('canvas');
    this.vp = document.getElementById('viewport');
    this.linksLayer = document.getElementById('links-layer');
    this.devLayer = document.getElementById('devices-layer');
    this.pduLayer = document.getElementById('pdu-layer');
    this.ghost = document.getElementById('cable-ghost');
    this.ghost.style.display = 'none';
    this.view = { x: 0, y: 0, k: 1 };
    this.drag = null;
    this.cableStart = null;
    this.pduStart = null;
    this.selectedLink = null;
    this.pending = false;
    this.bind();
  }

  get net() { return this.app.net; }

  // ---------- coordinates ----------
  toWorld(cx, cy) {
    const r = this.svg.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k };
  }
  applyView() {
    this.vp.setAttribute('transform', `translate(${this.view.x} ${this.view.y}) scale(${this.view.k})`);
    this.svg.querySelector('.grid-bg').setAttribute('transform', `translate(${this.view.x % (24 * this.view.k)} ${this.view.y % (24 * this.view.k)}) scale(${this.view.k})`);
  }
  zoom(f, cx, cy) {
    const r = this.svg.getBoundingClientRect();
    if (cx === undefined) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
    const k = Math.min(3, Math.max(0.3, this.view.k * f));
    const wx = (cx - r.left - this.view.x) / this.view.k;
    const wy = (cy - r.top - this.view.y) / this.view.k;
    this.view.k = k;
    this.view.x = cx - r.left - wx * k;
    this.view.y = cy - r.top - wy * k;
    this.applyView();
  }
  fit() {
    const ds = [...this.net.devices.values()];
    const r = this.svg.getBoundingClientRect();
    if (!ds.length || !r.width) { this.view = { x: r.width / 2, y: r.height / 2, k: 1 }; this.applyView(); return; }
    const xs = ds.map((d) => d.x), ys = ds.map((d) => d.y);
    const minX = Math.min(...xs) - 70, maxX = Math.max(...xs) + 70;
    const minY = Math.min(...ys) - 60, maxY = Math.max(...ys) + 80;
    const k = Math.min(1.4, Math.max(0.3, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    this.view.k = k;
    this.view.x = r.width / 2 - ((minX + maxX) / 2) * k;
    this.view.y = r.height / 2 - ((minY + maxY) / 2) * k;
    this.applyView();
  }

  // ---------- rendering ----------
  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }

  lightState(port) {
    if (!port.isUp()) return 'down';
    const d = port.device;
    if (d.stp && d.stp.enabled && !d.stp.forwarding(port)) return 'wait';
    // a routed interface that is up but whose peer cannot pass traffic still shows green, as on real gear
    return 'up';
  }

  render() {
    const net = this.net;
    this.linksLayer.textContent = '';
    this.devLayer.textContent = '';
    const showPorts = this.app.prefs.showPorts;
    // several cables between the same two devices are drawn side by side instead of on top of each other
    const pairKey = (l) => [l.a.device.id, l.b.device.id].sort().join('|');
    const pairs = new Map();
    for (const l of net.links.values()) { const k = pairKey(l); pairs.set(k, [...(pairs.get(k) || []), l]); }
    for (const l of net.links.values()) {
      const a = l.a.device, b = l.b.device;
      const g = el('g', { class: `link${this.selectedLink === l.id ? ' selected' : ''}`, 'data-link': l.id }, this.linksLayer);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const group = pairs.get(pairKey(l));
      // shift along a normal that does not depend on which end is "a", so siblings spread evenly
      const flip = a.id < b.id ? 1 : -1;
      const shift = (group.indexOf(l) - (group.length - 1) / 2) * 16;
      const sx = -uy * flip * shift, sy = ux * flip * shift;
      el('line', { class: 'hit', x1: a.x + sx, y1: a.y + sy, x2: b.x + sx, y2: b.y + sy }, g);
      el('line', { class: 'wire', x1: a.x + sx, y1: a.y + sy, x2: b.x + sx, y2: b.y + sy }, g);
      for (const [port, dev, dir] of [[l.a, a, 1], [l.b, b, -1]]) {
        const dx = ux * dir, dy = uy * dir;
        // keep lights clear of the icon, and clear of the name/IP text when the cable leaves downwards
        const off = Math.max(34, Math.min(60, len * 0.25));
        const lx = dev.x + dx * off + sx, ly = dev.y + dy * off + sy;
        el('circle', { class: `light ${this.lightState(port)}`, cx: lx, cy: ly, r: 5 }, g);
        if (showPorts) {
          // perpendicular offset, anchored away from the cable
          let px = -dy, py = dx;
          if (px < 0 || (px === 0 && py < 0)) { px = -px; py = -py; }
          // side-by-side cables: put each label on the outside of the bundle
          if (shift) { px = sx / Math.abs(shift); py = sy / Math.abs(shift); }
          const t = el('text', { class: 'port-label', x: lx + px * 10, y: ly + py * 10 + 4, 'text-anchor': Math.abs(px) > 0.35 ? 'start' : 'middle' }, g);
          t.textContent = shortPort(port.name);
        }
      }
      const title = el('title', {}, g);
      title.textContent = `${a.name} ${l.a.name} ↔ ${b.name} ${l.b.name}`;
    }
    for (const d of net.devices.values()) {
      const cls = ['device'];
      if (this.app.selected === d.id) cls.push('selected');
      if (this.cableStart?.device === d || this.pduStart === d) cls.push('pick');
      if (!d.powered) cls.push('off');
      const g = el('g', { class: cls.join(' '), transform: `translate(${d.x} ${d.y})`, 'data-dev': d.id, tabindex: 0, role: 'button', 'aria-label': `${d.name} (${d.type})` }, this.devLayer);
      g.innerHTML = ICONS[d.type] || '';
      // labels go under the icon, unless a cable leaves straight down: then beside it
      const down = d.ports.some((p) => p.link && (() => { const o = p.peer.device; const L = Math.hypot(o.x - d.x, o.y - d.y) || 1; return (o.y - d.y) / L > 0.8; })());
      const side = down ? { x: 38, anchor: 'start', y1: 0, y2: 14 } : { x: 0, anchor: 'middle', y1: 44, y2: 58 };
      const name = el('text', { class: 'name', x: side.x, y: side.y1, 'text-anchor': side.anchor }, g);
      name.textContent = d.name;
      const ip = firstIp(d);
      if (ip && this.app.prefs.showIps) {
        const t = el('text', { class: 'addr', x: side.x, y: side.y2, 'text-anchor': side.anchor }, g);
        t.textContent = ip;
      }
    }
    this.app.renderEmpty?.();
  }

  /** Draws envelopes: [{x, y, protocol, label, id}] */
  drawPdus(list) {
    this.pduLayer.textContent = '';
    for (const p of list) {
      const g = el('g', { class: 'pdu', transform: `translate(${p.x} ${p.y})` }, this.pduLayer);
      el('rect', { x: -11, y: -8, width: 22, height: 16, rx: 2, fill: PROTO_COLORS[p.protocol] || 'var(--p-other)' }, g);
      el('path', { d: 'M-10 -7l10 7 10 -7' }, g);
      if (p.label) { const t = el('text', { y: -12 }, g); t.textContent = p.label; }
    }
  }

  // ---------- interaction ----------
  bind() {
    const svg = this.svg;
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
    }, { passive: false });

    svg.addEventListener('pointerdown', (e) => this.onDown(e));
    svg.addEventListener('pointermove', (e) => this.onMove(e));
    svg.addEventListener('pointerup', (e) => this.onUp(e));
    svg.addEventListener('pointercancel', () => { this.drag = null; svg.classList.remove('panning'); });
    svg.addEventListener('keydown', (e) => {
      const d = this.devAt(e.target);
      if (d && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); this.app.openDevice(d); }
    });
    svg.addEventListener('contextmenu', (e) => {
      const d = this.devAt(e.target);
      if (!d) return;
      e.preventDefault();
      this.app.deviceMenu(d, e.clientX, e.clientY);
    });
  }

  devAt(target) {
    const g = target.closest?.('[data-dev]');
    return g ? this.net.devices.get(g.getAttribute('data-dev')) : null;
  }
  linkAt(target) {
    const g = target.closest?.('[data-link]');
    return g ? this.net.links.get(g.getAttribute('data-link')) : null;
  }

  onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    this.app.closeMenus();
    const d = this.devAt(e.target);
    const l = !d && this.linkAt(e.target);
    const tool = this.app.tool;
    const w = this.toWorld(e.clientX, e.clientY);
    if (tool === 'delete') {
      if (d) this.app.removeDevice(d);
      else if (l) this.app.removeLink(l);
      return;
    }
    if (tool === 'cable') {
      if (d) this.pickCablePort(d, e.clientX, e.clientY);
      else if (this.cableStart) this.cancelCable();
      else this.startPan(e);
      return;
    }
    if (tool === 'pdu') {
      if (d) this.pickPdu(d);
      else this.startPan(e);
      return;
    }
    if (d) {
      this.app.select(d.id);
      this.selectedLink = null;
      this.drag = { kind: 'dev', d, ox: w.x - d.x, oy: w.y - d.y, moved: false, sx: e.clientX, sy: e.clientY };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (l) {
      this.selectedLink = l.id;
      this.app.selectLink(l);
      this.requestRender();
      return;
    }
    this.app.select(null);
    this.selectedLink = null;
    this.startPan(e);
  }

  startPan(e) {
    this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
    this.svg.classList.add('panning');
    this.svg.setPointerCapture(e.pointerId);
  }

  onMove(e) {
    if (this.cableStart) {
      const w = this.toWorld(e.clientX, e.clientY);
      const s = this.cableStart.device;
      Object.entries({ x1: s.x, y1: s.y, x2: w.x, y2: w.y }).forEach(([k, v]) => this.ghost.setAttribute(k, v));
    }
    const dr = this.drag;
    if (!dr) return;
    if (Math.abs(e.clientX - dr.sx) + Math.abs(e.clientY - dr.sy) > 3) dr.moved = true;
    if (dr.kind === 'pan') {
      this.view.x = dr.vx + (e.clientX - dr.sx);
      this.view.y = dr.vy + (e.clientY - dr.sy);
      this.applyView();
    } else if (dr.kind === 'dev' && dr.moved) {
      const w = this.toWorld(e.clientX, e.clientY);
      dr.d.x = Math.round((w.x - dr.ox) / 4) * 4;
      dr.d.y = Math.round((w.y - dr.oy) / 4) * 4;
      this.requestRender();
      this.app.redrawPdus?.();
    }
  }

  onUp() {
    const dr = this.drag;
    this.drag = null;
    this.svg.classList.remove('panning');
    if (dr?.kind === 'dev' && dr.moved) this.app.changed();
    if (dr?.kind === 'dev' && !dr.moved) {
      const now = performance.now();
      if (this.lastClick && this.lastClick.d === dr.d && now - this.lastClick.t < 450) {
        this.lastClick = null;
        this.app.openDevice(dr.d);
      } else this.lastClick = { d: dr.d, t: now };
    }
  }

  // ---------- cable tool ----------
  pickCablePort(d, cx, cy) {
    const items = d.ports.map((p) => ({
      label: p.name,
      hint: p.link ? `→ ${p.peer.device.name}` : '',
      disabled: !!p.link || (this.cableStart && this.cableStart.device === d),
      run: () => this.choosePort(p),
    }));
    this.app.menu(cx, cy, items, this.cableStart ? `Connect ${this.cableStart.device.name} ${shortPort(this.cableStart.name)} to…` : `${d.name}: choose a port`);
  }

  choosePort(p) {
    if (!this.cableStart) {
      this.cableStart = p;
      this.ghost.style.display = '';
      Object.entries({ x1: p.device.x, y1: p.device.y, x2: p.device.x, y2: p.device.y }).forEach(([k, v]) => this.ghost.setAttribute(k, v));
      this.app.hint(`Now click the device to connect ${p.device.name} ${shortPort(p.name)} to. Esc cancels.`);
      this.requestRender();
      return;
    }
    const a = this.cableStart;
    this.cancelCable();
    this.app.connect(a, p);
  }

  cancelCable() {
    this.cableStart = null;
    this.ghost.style.display = 'none';
    this.app.hint('');
    this.requestRender();
  }

  // ---------- quick ping tool ----------
  pickPdu(d) {
    if (!d.nic && !d.ifaces) return;
    if (!this.pduStart) {
      if (!d.ping) { this.app.toast('Pick a device with an IP address'); return; }
      this.pduStart = d;
      this.app.hint(`Ping from ${d.name}: now click the destination.`);
      this.requestRender();
      return;
    }
    const src = this.pduStart;
    this.pduStart = null;
    this.app.hint('');
    this.requestRender();
    if (src === d) return;
    this.app.quickPing(src, d);
  }

  resetTools() {
    this.cancelCable();
    this.pduStart = null;
    this.app.hint('');
  }
}

export function shortPort(n) {
  return n.replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa').replace(/^Port/, 'P');
}

export function firstIp(d) {
  if (d.nic) return d.nic.ip ? d.nic.ip : d.ipMode === 'dhcp' ? 'DHCP…' : '';
  if (d.ifaces) {
    const i = d.ifaces.find((x) => x.ip);
    return i ? i.ip : '';
  }
  return '';
}
