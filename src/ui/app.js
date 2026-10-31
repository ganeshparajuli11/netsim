// Application shell: wires the engine, canvas, windows, simulation panel and labs together.

import { Network, protocolOf } from '../engine/network.js';
import { createDevice, serializeNetwork, loadNetwork, DEVICE_TYPES } from '../engine/factory.js';
import { Device } from '../engine/device.js';
import { IosCli } from '../cli/ios.js';
import { HostCmd } from '../cli/hostcmd.js';
import { formatMac, maskToPrefix } from '../engine/util.js';
import { describeLsa } from '../engine/ospf.js';
import { ipLength } from '../engine/l3.js';
import { Canvas, shortPort, firstIp } from './canvas.js';
import { WindowManager } from './devicewin.js';
import { iconSvg, PROTO_COLORS } from './icons.js';
import { LABS } from './labs.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const PROTOCOLS = ['ARP', 'ICMP', 'DHCP', 'DNS', 'HTTP', 'RIP', 'OSPF', 'UDP'];

class App {
  constructor() {
    this.net = new Network();
    this.tool = 'select';
    this.mode = 'realtime';
    this.selected = null;
    this.selectedLinkId = null;
    this.prefs = { showPorts: true, showIps: true, ...(JSON.parse(store.get('opennetsim:prefs') || '{}')) };
    this.clis = new Map();
    this.lab = null;
    this.labResults = null;
    this.done = new Set(JSON.parse(store.get('opennetsim:labs-done') || '[]'));
    this.sim = { playing: false, speed: 1, filters: new Set(PROTOCOLS), animating: null, current: null };
    this.pduLog = [];
    this.sideTab = 'details';
    this.canvas = new Canvas(this);
    this.wins = new WindowManager(this);
    this.buildPalette();
    this.bindChrome();
    this.restore();
    this.loop();
  }

  // ------------------------------------------------------------ network lifecycle
  attach(net) {
    this.unsubs?.forEach((u) => u());
    this.net = net;
    this.clis.clear();
    const rerender = () => { this.canvas.requestRender(); this.scheduleSide(); };
    this.unsubs = [
      net.on('topology', rerender),
      net.on('links', rerender),
      net.on('config', (d) => { rerender(); this.wins.refresh(d); this.autosave(); }),
      net.on('event', () => this.scheduleEvents()),
      net.on('counters', (d) => this.wins.refresh(d)),
      net.on('log', ({ device, text }) => {
        const cli = this.clis.get(device);
        if (!cli) return;
        const buf = cli.__buffer || '';
        cli.out(`${buf && !buf.endsWith('\n') ? '\n' : ''}${text}\n`);
      }),
    ];
    net.recording = this.mode === 'simulation';
    this.canvas.render();
    this.scheduleSide();
  }

  restore() {
    const saved = store.get('opennetsim:autosave');
    let net = new Network();
    if (saved) {
      try {
        const data = JSON.parse(saved);
        net = loadNetwork(data);
        if (data.lab) this.lab = LABS.find((l) => l.id === data.lab) || null;
      } catch { net = new Network(); }
    }
    this.attach(net);
    requestAnimationFrame(() => this.canvas.fit());
  }

  changed() {
    this.canvas.requestRender();
    this.scheduleSide();
    this.autosave();
  }

  autosave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      store.set('opennetsim:autosave', JSON.stringify(serializeNetwork(this.net, { lab: this.lab?.id || null })));
    }, 400);
  }

  newNetwork(net = new Network(), lab = null) {
    this.wins.closeAll();
    this.canvas.resetTools();
    this.sim.playing = false;
    this.selected = null;
    this.pduLog = [];
    this.lab = lab;
    this.labResults = null;
    this.attach(net);
    this.canvas.fit();
    this.autosave();
    this.sideTab = lab ? 'lab' : this.mode === 'simulation' ? 'events' : 'details';
    this.scheduleSide();
  }

  // ------------------------------------------------------------ main loop
  loop() {
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(100, now - last);
      last = now;
      if (this.mode === 'realtime') this.net.runUntil(this.net.time + dt);
      const c = document.getElementById('clock');
      const t = (this.net.time / 1000).toFixed(3);
      if (c.textContent !== `${t} s`) c.textContent = `${t} s`;
      if (now - (this.lastCounterPoll || 0) > 500) { this.lastCounterPoll = now; this.wins.pollCounters(); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ chrome
  buildPalette() {
    const pal = document.getElementById('palette');
    for (const [type, t] of Object.entries(DEVICE_TYPES)) {
      const b = document.createElement('div');
      b.className = 'pal-item';
      b.tabIndex = 0;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', `Add ${t.label}`);
      b.innerHTML = `${iconSvg(type, 44)}<span>${t.label}</span>`;
      b.addEventListener('pointerdown', (e) => this.dragFromPalette(e, type));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.addAtCenter(type); }
      });
      pal.appendChild(b);
    }
  }

  dragFromPalette(e, type) {
    e.preventDefault();
    const ghost = document.createElement('div');
    ghost.innerHTML = iconSvg(type, 56);
    Object.assign(ghost.style, { position: 'fixed', pointerEvents: 'none', zIndex: 99, opacity: '.8', left: `${e.clientX - 28}px`, top: `${e.clientY - 22}px` });
    document.body.appendChild(ghost);
    const sx = e.clientX, sy = e.clientY;
    const move = (ev) => { ghost.style.left = `${ev.clientX - 28}px`; ghost.style.top = `${ev.clientY - 22}px`; };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.remove();
      const r = this.canvas.svg.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) { this.addAtCenter(type); return; }
      if (!inside) return;
      const w = this.canvas.toWorld(ev.clientX, ev.clientY);
      this.addDevice(type, Math.round(w.x / 4) * 4, Math.round(w.y / 4) * 4);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  addAtCenter(type) {
    const r = this.canvas.svg.getBoundingClientRect();
    const w = this.canvas.toWorld(r.left + r.width / 2 + (Math.random() - 0.5) * 120, r.top + r.height / 2 + (Math.random() - 0.5) * 80);
    this.addDevice(type, Math.round(w.x), Math.round(w.y));
  }

  addDevice(type, x, y) {
    const d = createDevice(this.net, type, { x, y });
    this.select(d.id);
    this.changed();
    if (this.net.devices.size === 1) this.toast('Double-click a device to configure it');
    return d;
  }

  bindChrome() {
    document.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => this.action(b.dataset.action)));
    document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    document.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
      const z = b.dataset.zoom;
      if (z === 'fit') this.canvas.fit(); else this.canvas.zoom(z === 'in' ? 1.2 : 1 / 1.2);
    }));
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      this.prefs.theme = root.dataset.theme;
      this.savePrefs();
    });
    if (this.prefs.theme) document.documentElement.dataset.theme = this.prefs.theme;
    document.getElementById('file-input').addEventListener('change', (e) => this.openFile(e.target.files[0]));
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) this.closeMenus(); }, true);
    this.renderStatus();
  }

  savePrefs() { store.set('opennetsim:prefs', JSON.stringify(this.prefs)); }

  onKey(e) {
    if (e.target.closest('input, textarea, select, .term')) return;
    if (e.key === 'Escape') { this.setTool('select'); this.closeMenus(); document.querySelector('.modal-back')?.remove(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { const d = this.net.devices.get(this.selected); if (d) this.removeDevice(d); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedLinkId) { const l = this.net.links.get(this.selectedLinkId); if (l) this.removeLink(l); }
    else if (e.key === 'c' && !e.ctrlKey && !e.metaKey) this.setTool('cable');
    else if (e.key === 'p' && !e.ctrlKey && !e.metaKey) this.setTool('pdu');
    else if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.action('save'); }
    else if (e.key === 'o' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.action('open'); }
    else if (this.mode === 'simulation' && (e.key === 'ArrowRight' || e.key === '.')) { e.preventDefault(); this.simStep(); }
    else if (this.mode === 'simulation' && e.key === ' ') { e.preventDefault(); this.togglePlay(); }
  }

  setTool(t) {
    this.tool = t;
    this.canvas.resetTools();
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    const svg = this.canvas.svg;
    svg.classList.remove('tool-cable', 'tool-pdu', 'tool-delete');
    if (t !== 'select') svg.classList.add(`tool-${t}`);
    const hints = { cable: 'Click a device, choose a port, then click the second device.', pdu: 'Click the device that sends the ping, then the destination.', delete: 'Click a device or cable to delete it. Esc to stop.' };
    this.hint(hints[t] || '');
  }

  action(a) {
    if (a === 'new') {
      const go = () => { Device.resetIds(); this.newNetwork(); };
      if (!this.net.devices.size) { go(); return; }
      this.confirmBox('Start a new network?', 'The current network will be replaced. Save it first if you want to keep it.', 'Start new network', go);
    } else if (a === 'save') {
      this.showSave();
    } else if (a === 'open') {
      this.showOpen();
    } else if (a === 'labs') {
      this.showLabs();
    }
  }

  async openFile(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      Device.resetIds();
      const net = loadNetwork(data, new Network());
      this.newNetwork(net, LABS.find((l) => l.id === data.lab) || null);
      this.toast(`Opened ${file.name}`);
    } catch (err) {
      this.toast(`Could not open ${file.name}: ${err.message}`);
    }
    document.getElementById('file-input').value = '';
  }

  // ------------------------------------------------------------ selection & editing
  select(id) {
    this.selected = id;
    this.selectedLinkId = null;
    this.canvas.selectedLink = null;
    if (id && this.sideTab !== 'lab' && this.mode !== 'simulation') this.sideTab = 'details';
    this.canvas.requestRender();
    this.scheduleSide();
  }

  selectLink(l) {
    this.selected = null;
    this.selectedLinkId = l.id;
    if (this.mode !== 'simulation') this.sideTab = 'details';
    this.scheduleSide();
  }

  openDevice(d) { this.wins.open(d); }

  getCli(d) {
    let c = this.clis.get(d.id);
    if (!c) {
      c = d.type === 'router' || d.type === 'switch' ? new IosCli(d) : new HostCmd(d);
      c.__buffer = c.banner();
      c.out = (t) => { c.__buffer = (c.__buffer + t).slice(-60000); };
      this.clis.set(d.id, c);
    }
    return c;
  }

  removeDevice(d) {
    this.wins.close(d.id);
    this.net.removeDevice(d.id);
    this.clis.delete(d.id);
    if (this.selected === d.id) this.selected = null;
    this.changed();
  }

  removeLink(l) {
    this.net.disconnect(l.id);
    this.selectedLinkId = null;
    this.changed();
  }

  connect(a, b) {
    try {
      this.net.connect(a, b);
      this.changed();
      if (a.device.type === 'router' || b.device.type === 'router') {
        const r = a.device.type === 'router' ? a : b;
        if (r.shutdown) this.toast(`${r.device.name} ${shortPort(r.name)} is shut down. Use "no shutdown" in its CLI to bring it up.`);
      }
    } catch (err) {
      this.toast(err.message);
    }
  }

  deviceMenu(d, x, y) {
    const items = [
      { label: 'Open', run: () => this.openDevice(d) },
    ];
    if (d.type === 'router' || d.type === 'switch') items.push({ label: 'Open CLI', run: () => this.wins.open(d, 'cli') });
    if (d.nic) items.push({ label: 'Command prompt', run: () => this.wins.open(d, 'cmd') });
    items.push({ sep: true }, { label: d.powered ? 'Turn off' : 'Turn on', run: () => { d.powered = !d.powered; d.ports.forEach((p) => this.net.notifyPort(p)); d.stp?.markDirty(); this.changed(); } });
    items.push({ label: 'Delete', run: () => this.removeDevice(d) });
    this.menu(x, y, items, d.name);
  }

  menu(x, y, items, title = '') {
    this.closeMenus();
    const m = document.createElement('div');
    m.className = 'menu';
    m.setAttribute('role', 'menu');
    if (title) { const h = document.createElement('h4'); h.textContent = title; m.appendChild(h); }
    for (const it of items) {
      if (it.sep) { m.appendChild(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}`;
      b.disabled = !!it.disabled;
      b.onclick = () => { this.closeMenus(); it.run(); };
      m.appendChild(b);
    }
    document.getElementById('menus').appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 8))}px`;
    m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 8))}px`;
    m.querySelector('button:not(:disabled)')?.focus();
  }

  closeMenus() { document.getElementById('menus').textContent = ''; }

  hint(t) {
    const h = document.getElementById('hint');
    h.textContent = t;
    h.classList.toggle('show', !!t);
  }

  toast(t) {
    document.querySelector('.toast')?.remove();
    const d = document.createElement('div');
    d.className = 'toast';
    d.setAttribute('role', 'status');
    d.textContent = t;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 3200);
  }

  quickPing(src, dst) {
    const ip = dst.nic ? dst.nic.ip : dst.ifaces?.find((i) => i.ip && dst.ifaceUp(i))?.ip || dst.ifaces?.find((i) => i.ip)?.ip;
    if (!ip) { this.toast(`${dst.name} has no IP address yet`); return; }
    if (src.nic && !src.nic.ip) { this.toast(`${src.name} has no IP address yet`); return; }
    const entry = { src: src.name, dst: dst.name, ip, status: 'In progress', time: this.net.time };
    this.pduLog.unshift(entry);
    this.pduLog = this.pduLog.slice(0, 12);
    src.ping(ip, {
      count: 1, timeout: 2000,
      onResult: (r) => {
        entry.status = r.kind === 'reply' ? 'Successful' : r.kind === 'timeout' ? 'Failed (timed out)' : r.kind === 'unreachable' ? `Failed (unreachable from ${r.from})` : r.kind === 'ttl' ? 'Failed (TTL expired)' : 'Failed (no route)';
        this.scheduleSide();
        if (this.mode === 'realtime') this.toast(`${src.name} → ${dst.name}: ${entry.status}`);
      },
    });
    if (this.mode === 'simulation') { this.sideTab = 'events'; this.redrawPdus(); }
    this.scheduleSide();
  }

  // ------------------------------------------------------------ modes & simulation
  setMode(m) {
    if (m === this.mode) return;
    this.mode = m;
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
    this.net.recording = m === 'simulation';
    this.sim.playing = false;
    if (m === 'simulation') { this.sideTab = 'events'; this.redrawPdus(); }
    else { this.canvas.drawPdus([]); if (this.sideTab === 'events') this.sideTab = 'details'; }
    this.scheduleSide();
  }

  visibleFrames(frames) {
    return frames.filter((e) => this.sim.filters.has(protocolGroup(protocolOf(e.meta.frame))));
  }

  redrawPdus(t = 0, frames = null) {
    if (this.mode !== 'simulation') return;
    const list = frames || this.visibleFrames(this.net.pendingFrames().frames);
    this.canvas.drawPdus(list.map((e) => {
      const a = e.meta.from.device, b = e.meta.to.device;
      const { sx, sy } = this.canvas.linkOffset(e.meta.link || e.meta.from.link);
      return { x: a.x + (b.x - a.x) * t + sx, y: a.y + (b.y - a.y) * t + sy, protocol: protocolGroup(protocolOf(e.meta.frame)) };
    }));
  }

  /** Delivers the next visible batch of frames, animating them along their cables. */
  simStep() {
    if (this.sim.animating) return;
    for (let guard = 0; guard < 2000; guard++) {
      if (!this.net.advanceToNextFrame()) {
        this.sim.playing = false;
        this.canvas.drawPdus([]);
        this.scheduleSide();
        if (guard === 0) this.toast('Nothing on the wire. Send a ping or a simple PDU to create traffic.');
        return;
      }
      const { frames } = this.net.pendingFrames();
      const vis = this.visibleFrames(frames);
      if (!vis.length) { this.net.step(); continue; }
      const dur = 650 / this.sim.speed;
      const start = performance.now();
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.sim.animating = true;
      const frame = (now) => {
        const t = reduce ? 1 : Math.min(1, (now - start) / dur);
        this.redrawPdus(t, vis);
        if (t < 1) { requestAnimationFrame(frame); return; }
        this.net.step();
        this.sim.animating = null;
        this.redrawPdus();
        this.scheduleSide();
        if (this.sim.playing) setTimeout(() => this.sim.playing && this.simStep(), 120 / this.sim.speed);
      };
      requestAnimationFrame(frame);
      return;
    }
  }

  togglePlay() {
    this.sim.playing = !this.sim.playing;
    if (this.sim.playing) this.simStep();
    this.scheduleSide();
  }

  simReset() {
    this.sim.playing = false;
    this.net.events = [];
    this.net.queue = this.net.queue.filter((e) => e.meta?.kind !== 'frame');
    this.sim.current = null;
    this.canvas.drawPdus([]);
    this.scheduleSide();
  }

  skipTime(ms) {
    if (this.mode === 'simulation') {
      const rec = this.net.recording;
      this.net.recording = false;
      this.net.runFor(ms);
      this.net.recording = rec;
      this.redrawPdus();
    } else this.net.runFor(ms);
    this.toast(`Moved the clock forward ${ms / 1000} s`);
    this.changed();
  }

  // ------------------------------------------------------------ side panel
  scheduleSide() {
    if (this.sidePending) return;
    this.sidePending = true;
    requestAnimationFrame(() => { this.sidePending = false; this.renderSide(); });
  }

  scheduleEvents() {
    if (this.sideTab === 'events') this.scheduleSide();
  }

  renderSide() {
    const side = document.getElementById('side');
    const tabs = [];
    if (this.lab) tabs.push(['lab', 'Lab']);
    if (this.mode === 'simulation') tabs.push(['events', 'Events']);
    tabs.push(['details', 'Details']);
    if (!tabs.some(([id]) => id === this.sideTab)) this.sideTab = tabs[0][0];
    const keepScroll = side.querySelector('.events')?.scrollTop;
    const atBottom = (() => { const ev = side.querySelector('.events'); return !ev || ev.scrollTop + ev.clientHeight >= ev.scrollHeight - 4; })();
    side.innerHTML = `<div class="tabs" role="tablist" style="padding-top:8px">${tabs.map(([id, l]) => `<button role="tab" data-side="${id}" aria-selected="${id === this.sideTab}">${l}</button>`).join('')}</div>`;
    side.querySelectorAll('[data-side]').forEach((b) => { b.onclick = () => { this.sideTab = b.dataset.side; this.renderSide(); }; });
    if (this.sideTab === 'events') this.renderEvents(side, atBottom, keepScroll);
    else if (this.sideTab === 'lab') this.renderLab(side);
    else this.renderDetails(side);
  }

  renderDetails(side) {
    const d = this.selected && this.net.devices.get(this.selected);
    const l = this.selectedLinkId && this.net.links.get(this.selectedLinkId);
    const body = document.createElement('div');
    body.className = 'side-body';
    if (d) {
      const rows = [];
      if (d.nic) {
        rows.push(['IP address', d.nic.ip ? `${d.nic.ip}/${maskToPrefix(d.nic.mask || '0.0.0.0')}` : 'not set'], ['Gateway', d.defaultGateway || 'not set'], ['Addressing', d.ipMode === 'dhcp' ? `DHCP (${d.dhcp.state})` : 'static'], ['MAC', formatMac(d.nic.mac)]);
      }
      if (d.type === 'router') for (const i of d.ifaces) rows.push([shortPort(i.name), `${i.ip ? `${i.ip}/${maskToPrefix(i.mask)}` : 'no IP'}, ${d.ifaceStatus(i).protocol}`]);
      if (d.type === 'switch') {
        rows.push(['Ports in use', `${d.ports.filter((p) => p.link).length} of ${d.ports.length}`], ['VLANs', [...d.vlans.keys()].join(', ')], ['MAC table', `${d.macEntries().length} entries`]);
        d.stp.ensure();
        rows.push(['Spanning tree', d.stp.enabled ? (d.stp.rootId === d.stp.bridgeId ? 'root bridge' : `root port ${shortPort(d.stp.rootPort?.name || '-')}`) : 'off']);
      }
      body.innerHTML = `<h3>${esc(d.name)}</h3><dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        <div class="form-actions"><button class="primary" id="open-dev">${d.nic ? 'Open' : 'Open CLI'}</button>${d.nic ? '<button class="secondary" id="open-cmd">Command prompt</button>' : ''}</div>`;
      body.querySelector('#open-dev').onclick = () => this.wins.open(d, d.nic ? 'ip' : d.type === 'hub' ? null : 'cli');
      body.querySelector('#open-cmd')?.addEventListener('click', () => this.wins.open(d, 'cmd'));
    } else if (l) {
      body.innerHTML = `<h3>Cable</h3><dl class="kv"><dt>${esc(l.a.device.name)}</dt><dd>${esc(l.a.name)} (${this.canvas.lightState(l.a)})</dd><dt>${esc(l.b.device.name)}</dt><dd>${esc(l.b.name)} (${this.canvas.lightState(l.b)})</dd></dl>
        <div class="form-actions"><button class="secondary danger" id="del-link">Remove cable</button></div>`;
      body.querySelector('#del-link').onclick = () => this.removeLink(l);
    } else {
      const n = this.net.devices.size;
      body.innerHTML = `
        <h3>This network</h3>
        <p class="note" style="margin-top:0">${n ? `${n} device${n > 1 ? 's' : ''}, ${this.net.links.size} cable${this.net.links.size === 1 ? '' : 's'}.` : 'Empty. Drag a device from the left, or open a lab.'} Select a device to see its addresses; double-click to configure it.</p>
        <h3>Link lights</h3>
        <dl class="kv"><dt><span class="legend"><i style="background:var(--up)"></i></span></dt><dd style="font-family:var(--ui)">Up and forwarding</dd>
        <dt><span class="legend"><i style="background:var(--wait)"></i></span></dt><dd style="font-family:var(--ui)">Blocked by spanning tree</dd>
        <dt><span class="legend"><i style="background:var(--down)"></i></span></dt><dd style="font-family:var(--ui)">Down or shut down</dd>
        <dt><span class="legend"><i style="background:var(--down);box-shadow:0 0 0 2px var(--ink)"></i></span></dt><dd style="font-family:var(--ui)">Err-disabled by port security</dd></dl>
        ${this.pduLog.length ? `<h3>Quick pings</h3><table class="grid"><thead><tr><th>From</th><th>To</th><th>Result</th></tr></thead><tbody>${this.pduLog.map((p) => `<tr><td>${esc(p.src)}</td><td>${esc(p.dst)}</td><td class="${p.status === 'Successful' ? 'status-good' : p.status.startsWith('Failed') ? 'status-bad' : ''}">${esc(p.status)}</td></tr>`).join('')}</tbody></table>` : ''}
        <h3>Keyboard</h3>
        <dl class="kv"><dt>C</dt><dd style="font-family:var(--ui)">Cable tool</dd><dt>P</dt><dd style="font-family:var(--ui)">Quick ping tool</dd><dt>Del</dt><dd style="font-family:var(--ui)">Delete selection</dd><dt>Esc</dt><dd style="font-family:var(--ui)">Back to select</dd><dt>→ / Space</dt><dd style="font-family:var(--ui)">Step / play (simulation)</dd></dl>`;
    }
    side.appendChild(body);
  }

  renderEvents(side, atBottom, keepScroll) {
    const ctl = document.createElement('div');
    ctl.className = 'sim-controls';
    ctl.innerHTML = `
      <button id="sim-reset" title="Clear the event list and drop frames in flight" aria-label="Reset simulation"><svg viewBox="0 0 16 16"><path d="M3 3h2v10H3zM13 3v10L6 8z"/></svg></button>
      <button id="sim-play" class="play" aria-label="${this.sim.playing ? 'Pause' : 'Play'}" title="Play / pause (Space)">${this.sim.playing ? '<svg viewBox="0 0 16 16"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>' : '<svg viewBox="0 0 16 16"><path d="M4 2l10 6-10 6z"/></svg>'}</button>
      <button id="sim-step" aria-label="Step forward" title="Deliver the next packets (→)"><svg viewBox="0 0 16 16"><path d="M3 2l8 6-8 6zM11 3h2v10h-2z"/></svg></button>
      <label>Speed <input type="range" id="sim-speed" min="0.25" max="4" step="0.25" value="${this.sim.speed}"></label>`;
    side.appendChild(ctl);
    ctl.querySelector('#sim-reset').onclick = () => this.simReset();
    ctl.querySelector('#sim-play').onclick = () => this.togglePlay();
    ctl.querySelector('#sim-step').onclick = () => this.simStep();
    ctl.querySelector('#sim-speed').oninput = (e) => { this.sim.speed = Number(e.target.value); };

    const f = document.createElement('div');
    f.className = 'filters';
    f.setAttribute('aria-label', 'Show protocols');
    f.innerHTML = PROTOCOLS.map((p) => `<label class="chip ${this.sim.filters.has(p) ? '' : 'off'}"><input type="checkbox" data-p="${p}" ${this.sim.filters.has(p) ? 'checked' : ''}><span class="sw" style="background:${PROTO_COLORS[p]}"></span>${p}</label>`).join('');
    f.querySelectorAll('input').forEach((i) => { i.onchange = () => { if (i.checked) this.sim.filters.add(i.dataset.p); else this.sim.filters.delete(i.dataset.p); this.redrawPdus(); this.renderSide(); }; });
    side.appendChild(f);

    const ev = document.createElement('div');
    ev.className = 'events';
    const list = this.net.events.filter((e) => this.sim.filters.has(protocolGroup(e.protocol)));
    if (!list.length) {
      const pending = this.net.pendingFrames().frames.length;
      ev.innerHTML = `<div class="events-empty">${pending ? 'Packets are waiting on the wire. Press <b>step</b> to deliver them one hop at a time, or <b>play</b>.' : 'No events yet. Use the <b>Ping</b> tool on two devices, or run <code>ping</code> from a command prompt, then step through it here.'}</div>`;
    } else {
      const rows = list.slice(-400).map((e) => `<tr data-ev="${e.id}" class="${this.sim.current === e.id ? 'current' : ''}"><td class="t">${(e.time / 1000).toFixed(3)}</td><td>${esc(e.from)}</td><td>${esc(e.to)}</td><td><span class="ptag" style="background:${PROTO_COLORS[protocolGroup(e.protocol)]}">${e.protocol}</span></td></tr>`).join('');
      ev.innerHTML = `<table><thead><tr><th>Time (s)</th><th>From</th><th>At device</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table>`;
      ev.querySelectorAll('tr[data-ev]').forEach((tr) => { tr.onclick = () => { this.sim.current = Number(tr.dataset.ev); this.showEvent(this.net.events.find((x) => x.id === this.sim.current)); this.renderSide(); }; });
    }
    side.appendChild(ev);
    if (atBottom) ev.scrollTop = ev.scrollHeight; else if (keepScroll !== undefined) ev.scrollTop = keepScroll;
  }

  showEvent(rec) {
    if (!rec) return;
    const f = rec.frame;
    const layers = [];
    const kv = (o) => `<dl class="kv">${Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    layers.push(['Ethernet II', 'layer 2', kv({ 'Destination MAC': f.dst === 'FFFF.FFFF.FFFF' ? `${formatMac(f.dst)} (broadcast)` : formatMac(f.dst), 'Source MAC': formatMac(f.src), EtherType: f.type === 'ARP' ? '0x0806 (ARP)' : '0x0800 (IPv4)' })]);
    if (f.vlan !== undefined && f.vlan !== null) layers.push(['802.1Q tag', 'layer 2', kv({ 'VLAN ID': f.vlan, Note: 'Added by a trunk port so the next switch knows which VLAN this frame belongs to' })]);
    if (f.type === 'ARP') {
      const a = f.payload;
      layers.push(['ARP', 'layer 2.5', kv({ Operation: a.op === 1 ? '1 (request)' : '2 (reply)', 'Sender MAC': formatMac(a.senderMac), 'Sender IP': a.senderIp, 'Target MAC': formatMac(a.targetMac), 'Target IP': a.targetIp })]);
    } else if (f.type === 'IPv4') {
      const ip = f.payload;
      layers.push(['IPv4', 'layer 3', kv({ Source: ip.src, Destination: ip.dst, TTL: ip.ttl, Protocol: ip.proto, Identification: ip.ident, 'Total length': ip.proto === 'ICMP' && Number.isFinite(ip.payload?.size) ? `${ipLength(ip)} bytes` : undefined, "Don't fragment": ip.df ? 'set' : undefined })]);
      const p = ip.payload;
      if (ip.proto === 'ICMP') {
        const names = { 0: 'Echo reply', 8: 'Echo request', 3: 'Destination unreachable', 11: 'Time exceeded' };
        layers.push(['ICMP', 'layer 3', kv({ Type: `${p.type} (${names[p.type] || '?'})`, Code: p.type === 3 && p.code === 4 ? '4 (fragmentation needed and DF set)' : p.code, 'Next-hop MTU': p.mtu, 'Data size': Number.isFinite(p.size) ? `${p.size} bytes` : undefined, Identifier: p.id ?? p.orig?.icmp?.id, Sequence: p.seq ?? p.orig?.icmp?.seq, 'About packet': p.orig ? `${p.orig.src} → ${p.orig.dst}` : undefined })]);
      } else if (ip.proto === 'UDP') {
        layers.push(['UDP', 'layer 4', kv({ 'Source port': p.srcPort, 'Destination port': p.dstPort })]);
        const m = p.payload;
        if (p.dstPort === 67 || p.dstPort === 68) layers.push(['DHCP', 'layer 7', kv({ Message: m.msg, 'Transaction ID': `0x${(m.xid >>> 0).toString(16)}`, 'Client MAC': formatMac(m.chaddr), 'Your IP (offered)': m.yiaddr, 'Relay agent': m.giaddr !== '0.0.0.0' ? m.giaddr : undefined, 'Subnet mask': m.options?.mask, Router: m.options?.router, DNS: m.options?.dns, 'Requested IP': m.options?.requestedIp, 'Server ID': m.options?.serverId })]);
        else if (p.dstPort === 53 || p.srcPort === 53) layers.push(['DNS', 'layer 7', kv({ Kind: m.qr ? 'Response' : 'Query', Name: m.name, Type: m.type, Answer: m.qr ? m.answer || 'not found' : undefined })]);
        else if (p.dstPort === 520) layers.push(['RIP v2', 'layer 7', `<dl class="kv">${(m.entries || []).map((e) => `<dt>${e.network}/${maskToPrefix(e.mask)}</dt><dd>metric ${e.metric}${e.metric >= 16 ? ' (unreachable)' : ''}</dd>`).join('')}</dl>`]);
      } else if (ip.proto === 'OSPF') {
        const typeNames = { Hello: '1 (Hello)', DBD: '2 (Database description)', LSR: '3 (Link-state request)', LSU: '4 (Link-state update)', LSAck: '5 (Link-state acknowledgement)' };
        const ospfFields = { Type: typeNames[p.type] || p.type, 'Router ID': p.routerId, Area: p.area };
        if (p.type === 'Hello') {
          Object.assign(ospfFields, {
            'Network mask': p.mask, 'Hello interval': `${p.hello} s`, 'Dead interval': `${p.dead} s`, Priority: p.priority,
            'Designated router': p.dr, 'Backup designated router': p.bdr,
            'Neighbours seen': p.neighbors?.length ? p.neighbors.join(', ') : 'none yet',
          });
        } else if (p.type === 'DBD') {
          Object.assign(ospfFields, { Role: p.master ? 'master' : 'slave', Acknowledges: p.ack ? 'yes' : 'no', 'LSA headers': p.lsas?.length || 0 });
        } else {
          const list = p.type === 'LSR' ? p.requests : p.lsas;
          ospfFields[p.type === 'LSU' ? 'LSAs' : 'LSA headers'] = (list || []).map(describeLsa).join('; ') || 'none';
        }
        layers.push(['OSPF', 'layer 3, IP protocol 89', kv(ospfFields)]);
      } else if (ip.proto === 'TCP') {
        layers.push(['TCP', 'layer 4', kv({ 'Source port': p.srcPort, 'Destination port': p.dstPort })]);
        layers.push(['HTTP', 'layer 7', kv(p.payload.method ? { Request: `${p.payload.method} ${p.payload.path}`, Host: p.payload.host } : { Status: p.payload.status, Body: `${(p.payload.body || '').length} bytes` })]);
      }
    }
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-label="Packet details">
      <div class="modal-head"><h2>${esc(rec.protocol)} at ${esc(rec.to)}</h2><button class="x" aria-label="Close">×</button></div>
      <div class="modal-body">
        <p style="margin-top:0">${esc(rec.summary)}. Sent from <b>${esc(rec.from)}</b> ${esc(rec.fromPort)} to <b>${esc(rec.to)}</b> ${esc(rec.toPort)} at ${(rec.time / 1000).toFixed(3)} s.</p>
        <h3 style="font-size:15px;margin:14px 0 6px">What ${esc(rec.to)} did with it</h3>
        ${rec.notes.length ? `<ol class="decisions">${rec.notes.map((n) => `<li>${esc(n.replace(/^[^:]+: /, ''))}</li>`).join('')}</ol>` : '<p class="note">Nothing (the frame was discarded).</p>'}
        <h3 style="font-size:15px;margin:16px 0 6px">Inside the frame</h3>
        <div class="pdu-layers">${layers.map(([t, s, h]) => `<div class="layer"><h4>${t} <small>${s}</small></h4>${h}</div>`).join('')}</div>
      </div></div>`;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.x')) back.remove(); });
    document.body.appendChild(back);
    back.querySelector('.x').focus();
  }

  modal(title, html) {
    document.querySelector('.modal-back')?.remove();
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-label="${esc(title)}" style="width:min(560px,100%)"><div class="modal-head"><h2>${esc(title)}</h2><button class="x" aria-label="Close">×</button></div><div class="modal-body">${html}</div></div>`;
    back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('.x')) back.remove(); });
    document.body.appendChild(back);
    return back;
  }

  confirmBox(title, text, okLabel, onOk) {
    const m = this.modal(title, `<p style="margin-top:0">${esc(text)}</p><div class="form-actions"><button class="primary" id="ok">${esc(okLabel)}</button><button class="secondary" id="cancel">Cancel</button></div>`);
    m.querySelector('#ok').onclick = () => { m.remove(); onOk(); };
    m.querySelector('#cancel').onclick = () => m.remove();
    m.querySelector('#ok').focus();
  }

  showSave() {
    const data = JSON.stringify(serializeNetwork(this.net, { lab: this.lab?.id || null }), null, 1);
    const name = `${this.lab ? this.lab.id : 'network'}.onsim.json`;
    const m = this.modal('Save network', `
      <p style="margin-top:0">Download the topology as <code>${esc(name)}</code>, or copy it and keep it anywhere. Open it again later with <b>Open…</b>.</p>
      <div class="form-actions" style="margin-top:0"><button class="primary" id="dl">Download file</button><button class="secondary" id="cp">Copy to clipboard</button></div>
      <textarea class="field" id="save-json" rows="8" readonly style="margin-top:12px;font-size:12px">${esc(data)}</textarea>
      <p class="note" id="save-msg">Your work is also saved automatically in this browser.</p>`);
    const msg = m.querySelector('#save-msg');
    m.querySelector('#dl').onclick = async () => {
      // Inside a hosted viewer, ask it to save the file; elsewhere use a normal browser download.
      const dl = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
      if (dl) {
        try { await dl.save({ filename: name, data }); msg.textContent = 'Saved.'; } catch (err) { msg.textContent = err?.code === 'declined' ? 'Download cancelled.' : 'The download was blocked. Use Copy to clipboard instead.'; }
        return;
      }
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      msg.textContent = 'If no download started (some embedded viewers block them), use Copy to clipboard instead.';
    };
    m.querySelector('#cp').onclick = () => {
      const ta = m.querySelector('#save-json');
      navigator.clipboard?.writeText(data).then(() => { msg.textContent = 'Copied. Paste it into a text file to keep it.'; })
        .catch(() => { ta.focus(); ta.select(); msg.textContent = 'Press Ctrl+C (or Cmd+C) to copy the selected text.'; });
    };
  }

  showOpen() {
    const m = this.modal('Open network', `
      <p style="margin-top:0">Choose a saved <code>.onsim.json</code> file, or paste its contents below. This replaces the current network.</p>
      <div class="form-actions" style="margin-top:0"><button class="primary" id="pick">Choose file…</button></div>
      <textarea class="field" id="open-json" rows="6" placeholder="…or paste a saved network here" style="margin-top:12px;font-size:12px"></textarea>
      <div class="form-actions"><button class="secondary" id="load-paste">Open pasted network</button></div>
      <p class="note" id="open-msg"></p>`);
    m.querySelector('#pick').onclick = () => { m.remove(); document.getElementById('file-input').click(); };
    m.querySelector('#load-paste').onclick = () => {
      try {
        const data = JSON.parse(m.querySelector('#open-json').value);
        Device.resetIds();
        const net = loadNetwork(data, new Network());
        m.remove();
        this.newNetwork(net, LABS.find((l) => l.id === data.lab) || null);
        this.toast('Network opened');
      } catch (err) {
        m.querySelector('#open-msg').innerHTML = `<span class="status-bad">That is not a saved network (${esc(err.message)}). Paste the whole file, starting with {.</span>`;
      }
    };
  }

  // ------------------------------------------------------------ labs
  showLabs() {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-label="Labs">
      <div class="modal-head"><h2>Labs</h2><button class="x" aria-label="Close">×</button></div>
      <div class="modal-body">
        <p style="margin-top:0;color:var(--ink-2)">Each lab loads a starting network, explains the goal and checks your work. Your current network is replaced, so save it first if you need it.</p>
        <div class="labs-list">${LABS.map((l) => `<button class="lab-card ${this.done.has(l.id) ? 'done' : ''}" data-lab="${l.id}"><strong>${esc(l.title)}</strong><span>${esc(l.summary)}</span><em>${l.level}${this.done.has(l.id) ? ', completed' : ''}</em></button>`).join('')}</div>
      </div></div>`;
    back.addEventListener('click', (e) => {
      const card = e.target.closest('[data-lab]');
      if (card) { back.remove(); this.startLab(LABS.find((l) => l.id === card.dataset.lab)); return; }
      if (e.target === back || e.target.closest('.x')) back.remove();
    });
    document.body.appendChild(back);
    back.querySelector('.lab-card').focus();
  }

  startLab(lab) {
    Device.resetIds();
    const net = new Network();
    lab.build(net);
    net.settle(200);
    net.time = 0;
    this.newNetwork(net, lab);
  }

  renderLab(side) {
    const lab = this.lab;
    const body = document.createElement('div');
    body.className = 'side-body lab-guide';
    const res = this.labResults;
    const passed = res ? res.filter(Boolean).length : 0;
    body.innerHTML = `<h3 style="font-size:17px;color:var(--ink)">${esc(lab.title)}</h3>${lab.guide}
      <h3>Checklist</h3>
      ${res ? `<div class="progress" role="progressbar" aria-valuenow="${passed}" aria-valuemax="${lab.checks.length}"><div style="width:${(passed / lab.checks.length) * 100}%"></div></div>` : ''}
      <ul class="checks">${lab.checks.map((c, i) => `<li class="${res ? (res[i] ? 'ok' : 'fail') : ''}"><span class="mark">${res && res[i] ? '✓' : ''}</span><span>${esc(c.text)}</span></li>`).join('')}</ul>
      <div class="form-actions"><button class="primary" id="check">Check my work</button><button class="secondary" id="restart">Restart lab</button></div>
      ${res && passed === lab.checks.length ? '<p class="status-good" style="font-weight:700">All checks pass. Lab complete.</p>' : ''}`;
    body.querySelector('#check').onclick = (e) => {
      e.target.textContent = 'Checking…';
      e.target.disabled = true;
      setTimeout(() => {
        this.labResults = lab.checks.map((c) => { try { return !!c.fn(this.net); } catch (err) { console.error(err); return false; } });
        if (this.labResults.every(Boolean)) { this.done.add(lab.id); store.set('opennetsim:labs-done', JSON.stringify([...this.done])); }
        this.renderSide();
      }, 30);
    };
    body.querySelector('#restart').onclick = () => this.confirmBox('Restart this lab?', 'Your changes to this lab will be lost.', 'Restart lab', () => this.startLab(lab));
    side.appendChild(body);
  }

  renderEmpty() {
    const ws = document.getElementById('workspace');
    let e = ws.querySelector('.empty-state');
    if (this.net.devices.size) { e?.remove(); return; }
    if (e) return;
    e = document.createElement('div');
    e.className = 'empty-state';
    e.innerHTML = `<div><h1>Build a network, then watch it work</h1>
      <p>Drag routers, switches and PCs onto this workspace and connect them with cables. Configure them like real equipment, then switch to Simulation to follow every packet.</p>
      <div class="row"><button class="primary" id="es-labs">Start with a guided lab</button><button class="secondary" id="es-demo">Load an example network</button></div></div>`;
    ws.appendChild(e);
    e.querySelector('#es-labs').onclick = () => this.showLabs();
    e.querySelector('#es-demo').onclick = () => this.loadDemo();
  }

  loadDemo() {
    const lab = LABS.find((l) => l.id === 'router-basics');
    Device.resetIds();
    const net = new Network();
    lab.build(net);
    const r = net.findDevice('R1');
    for (const [i, ip] of [['GigabitEthernet0/0', '10.1.1.1'], ['GigabitEthernet0/1', '10.2.2.1']]) {
      const f = r.getIface(i); f.ip = ip; f.mask = '255.255.255.0'; r.getPort(i).shutdown = false; net.notifyPort(r.getPort(i));
    }
    net.findDevice('PC-A').defaultGateway = '10.1.1.1';
    net.findDevice('PC-B').defaultGateway = '10.2.2.1';
    net.settle(200);
    net.time = 0;
    this.newNetwork(net, null);
    this.toast('Example loaded. Try the Ping tool from PC-A to PC-B in Simulation mode.');
  }

  renderStatus() {
    const s = document.getElementById('statusbar');
    s.innerHTML = `
      <label><input type="checkbox" id="pref-ports" ${this.prefs.showPorts ? 'checked' : ''}> Port labels</label>
      <label><input type="checkbox" id="pref-ips" ${this.prefs.showIps ? 'checked' : ''}> IP addresses</label>
      <button class="btn" id="skip" title="Advance the simulated clock (useful for RIP, OSPF and DHCP timers)">Skip 30 s</button>
      <span class="push">OpenNetSim is open source (MIT licence)</span>`;
    s.querySelector('#pref-ports').onchange = (e) => { this.prefs.showPorts = e.target.checked; this.savePrefs(); this.canvas.render(); };
    s.querySelector('#pref-ips').onchange = (e) => { this.prefs.showIps = e.target.checked; this.savePrefs(); this.canvas.render(); };
    s.querySelector('#skip').onclick = () => this.skipTime(30000);
  }
}

function protocolGroup(p) {
  if (p === 'TCP') return 'HTTP';
  if (PROTOCOLS.includes(p)) return p;
  return 'UDP';
}

window.app = new App();
void firstIp;
