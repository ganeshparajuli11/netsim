// Floating device windows: IP settings, command prompt, CLI, services, port overview.

import { Terminal } from './terminal.js';
import { iconSvg } from './icons.js';
import { isValidIp, isValidMask, formatMac, networkOf } from '../engine/util.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let z = 30;
let cascade = 0;

export class WindowManager {
  constructor(app) {
    this.app = app;
    this.host = document.getElementById('windows');
    this.wins = new Map();
  }

  open(device, tab = null) {
    let w = this.wins.get(device.id);
    if (w) { w.raise(); if (tab) w.show(tab); return w; }
    w = new DeviceWindow(this, device);
    this.wins.set(device.id, w);
    if (tab) w.show(tab);
    return w;
  }

  close(id) {
    const w = this.wins.get(id);
    if (w) { w.destroy(); this.wins.delete(id); }
  }

  closeAll() { for (const id of [...this.wins.keys()]) this.close(id); }

  /** Redraws Ports tabs whose counters changed. Called a few times a second by the main loop. */
  pollCounters() {
    for (const w of this.wins.values()) {
      if (w.tab !== 'ports') continue;
      const sig = counterSignature(w.d);
      if (sig !== w.counterSig) w.tab_ports();
    }
  }

  refresh(device) {
    const w = device ? this.wins.get(device.id) : null;
    if (w) w.refresh();
    else if (!device) for (const x of this.wins.values()) x.refresh();
  }
}

class DeviceWindow {
  constructor(mgr, d) {
    this.mgr = mgr;
    this.app = mgr.app;
    this.d = d;
    const root = document.createElement('section');
    root.className = 'win';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', d.name);
    const isNet = d.type === 'router' || d.type === 'switch';
    const w = Math.min(isNet ? 720 : 620, window.innerWidth - 24);
    const h = Math.min(isNet ? 520 : 470, window.innerHeight - 90);
    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
    root.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, 240 + (cascade % 6) * 28))}px`;
    root.style.top = `${Math.max(56, Math.min(window.innerHeight - h - 8, 70 + (cascade % 6) * 28))}px`;
    cascade++;
    root.innerHTML = `
      <div class="win-head"><div class="ttl">${iconSvg(d.type, 28)}<span class="nm"></span></div><button class="x" aria-label="Close">×</button></div>
      <div class="tabs" role="tablist"></div>
      <div class="win-body"></div>`;
    this.root = root;
    this.body = root.querySelector('.win-body');
    root.querySelector('.x').onclick = () => this.mgr.close(d.id);
    root.addEventListener('pointerdown', () => this.raise());
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.target.closest('.term')) this.mgr.close(d.id); });
    this.dragHead(root.querySelector('.win-head'));
    this.tabs = this.tabList();
    const tl = root.querySelector('.tabs');
    for (const [id, label] of this.tabs) {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('role', 'tab');
      b.dataset.tab = id;
      b.onclick = () => this.show(id);
      tl.appendChild(b);
    }
    mgr.host.appendChild(root);
    this.raise();
    this.refreshTitle();
    this.show(this.tabs[0][0]);
  }

  tabList() {
    const t = this.d.type;
    if (t === 'router' || t === 'switch') return [['cli', 'CLI'], ['ports', 'Ports'], ['settings', 'Settings']];
    if (t === 'hub') return [['ports', 'Ports'], ['settings', 'Settings']];
    const tabs = [['ip', 'IP configuration'], ['cmd', 'Command prompt'], ['web', 'Web browser']];
    if (t === 'server') tabs.push(['services', 'Services']);
    tabs.push(['settings', 'Settings']);
    return tabs;
  }

  refreshTitle() { this.root.querySelector('.nm').textContent = this.d.name; }

  raise() { this.root.style.zIndex = ++z; }

  dragHead(head) {
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = this.root.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => {
        this.root.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - ox))}px`;
        this.root.style.top = `${Math.max(48, Math.min(window.innerHeight - 40, ev.clientY - oy))}px`;
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  show(id) {
    this.tab = id;
    for (const b of this.root.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    this.term?.destroy();
    this.term = null;
    this.body.className = 'win-body';
    this.body.textContent = '';
    this[`tab_${id}`]();
  }

  refresh() {
    this.refreshTitle();
    if (this.tab === 'ports') this.tab_ports();
    if (this.tab === 'ip' && !this.root.contains(document.activeElement)) this.tab_ip();
  }

  destroy() {
    this.term?.destroy();
    this.root.remove();
  }

  // ---------------- tabs ----------------

  tab_cli() {
    this.body.className = 'win-body flush';
    const cli = this.app.getCli(this.d);
    this.term = new Terminal(this.body, cli, this.d, this.app.net);
    const help = document.createElement('div');
    help.className = 'term-help';
    help.innerHTML = 'Type <b>?</b> for help, <b>Tab</b> to complete, <b>↑/↓</b> for history, <b>Ctrl+C</b> to stop a ping, <b>Ctrl+Z</b> to leave config mode.';
    this.body.appendChild(help);
    setTimeout(() => this.term?.focus(), 0);
  }

  tab_cmd() {
    this.body.className = 'win-body flush';
    const cli = this.app.getCli(this.d);
    this.term = new Terminal(this.body, cli, this.d, this.app.net);
    setTimeout(() => this.term?.focus(), 0);
  }

  tab_ip() {
    const d = this.d;
    const dhcp = d.ipMode === 'dhcp';
    const st = d.dhcp.state;
    const dhcpMsg = !dhcp ? '' : st === 'bound' ? '<span class="status-good">DHCP request successful.</span>'
      : st === 'failed' ? '<span class="status-bad">DHCP failed: no server answered. Using an automatic private address.</span>'
        : st === 'idle' ? (d.nic.port.isUp() ? '' : 'Connect a cable to request an address.') : 'Requesting an address…';
    this.body.innerHTML = `
      <form class="form" autocomplete="off">
        <label>Addressing</label>
        <div class="radio-row" role="radiogroup">
          <label><input type="radio" name="mode" value="dhcp" ${dhcp ? 'checked' : ''}> DHCP</label>
          <label><input type="radio" name="mode" value="static" ${!dhcp ? 'checked' : ''}> Static</label>
        </div>
        <label for="ip-${d.id}">IPv4 address</label><input type="text" id="ip-${d.id}" name="ip" value="${esc(d.nic.ip)}" ${dhcp ? 'disabled' : ''} placeholder="192.168.1.10">
        <label for="mask-${d.id}">Subnet mask</label><input type="text" id="mask-${d.id}" name="mask" value="${esc(d.nic.mask)}" ${dhcp ? 'disabled' : ''} placeholder="255.255.255.0">
        <label for="gw-${d.id}">Default gateway</label><input type="text" id="gw-${d.id}" name="gateway" value="${esc(d.defaultGateway)}" ${dhcp ? 'disabled' : ''} placeholder="192.168.1.1">
        <label for="dns-${d.id}">DNS server</label><input type="text" id="dns-${d.id}" name="dns" value="${esc(d.dnsServer)}" ${dhcp ? 'disabled' : ''} placeholder="optional">
        <label>MAC address</label><div><code>${formatMac(d.nic.mac)}</code></div>
        <div class="full note" id="ipmsg">${dhcpMsg}</div>
      </form>`;
    const f = this.body.querySelector('form');
    const msg = f.querySelector('#ipmsg');
    f.addEventListener('submit', (e) => e.preventDefault());
    f.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
      if (r.value === 'dhcp') d.setDhcp(); else d.setStatic({ ip: d.nic.ip, mask: d.nic.mask, gateway: d.defaultGateway, dns: d.dnsServer });
      this.app.changed();
      this.tab_ip();
    }));
    const apply = () => {
      const v = Object.fromEntries(['ip', 'mask', 'gateway', 'dns'].map((k) => [k, f.elements[k].value.trim()]));
      const bad = [];
      if (v.ip && !isValidIp(v.ip)) bad.push('ip');
      if (v.mask && !isValidMask(v.mask)) bad.push('mask');
      if (v.gateway && !isValidIp(v.gateway)) bad.push('gateway');
      if (v.dns && !isValidIp(v.dns)) bad.push('dns');
      if (!v.mask && v.ip && isValidIp(v.ip)) {
        const first = Number(v.ip.split('.')[0]);
        v.mask = first < 128 ? '255.0.0.0' : first < 192 ? '255.255.0.0' : '255.255.255.0';
        f.elements.mask.value = v.mask;
      }
      for (const k of ['ip', 'mask', 'gateway', 'dns']) f.elements[k].classList.toggle('bad', bad.includes(k));
      if (bad.length) { msg.innerHTML = `<span class="status-bad">Check the highlighted ${bad.length > 1 ? 'fields' : 'field'}: use dotted decimal like 192.168.1.10${bad.includes('mask') ? ', and a mask like 255.255.255.0' : ''}.</span>`; return; }
      if (v.ip && v.mask && v.ip === networkOf(v.ip, v.mask)) { msg.innerHTML = '<span class="status-bad">That is the network address itself. Pick a host address inside the subnet.</span>'; f.elements.ip.classList.add('bad'); return; }
      d.setStatic({ ip: v.ip || null, mask: v.mask || null, gateway: v.gateway || null, dns: v.dns || null });
      msg.textContent = v.ip ? 'Saved.' : '';
      this.app.changed();
    };
    f.querySelectorAll('input[type=text]').forEach((i) => {
      i.addEventListener('change', apply);
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    });
  }

  tab_web() {
    const d = this.d;
    this.body.className = 'win-body flush';
    this.body.innerHTML = `<div class="browser"><form class="bar"><input class="field" name="url" value="http://" aria-label="Address"><button class="secondary">Go</button></form><div class="msg">Enter a server's IP address or DNS name, for example <code>http://10.0.0.100</code>.</div></div>`;
    const f = this.body.querySelector('form');
    const holder = this.body.querySelector('.browser');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      holder.querySelector('.msg, iframe')?.remove();
      const m = document.createElement('div');
      m.className = 'msg';
      m.textContent = 'Loading… (in simulation mode, step or play to deliver the packets)';
      holder.appendChild(m);
      d.httpGet(f.elements.url.value.trim(), (r) => {
        m.remove();
        if (r.error) {
          const e2 = document.createElement('div'); e2.className = 'msg'; e2.textContent = r.error; holder.appendChild(e2); return;
        }
        const fr = document.createElement('iframe');
        fr.setAttribute('sandbox', '');
        fr.srcdoc = `<base target="_blank"><style>body{font-family:system-ui;padding:16px}</style>${r.body}`;
        holder.appendChild(fr);
      });
    });
  }

  tab_services() {
    const d = this.d;
    const s = d.dhcpServer;
    const pools = s.pools;
    this.body.innerHTML = `
      <h3 style="margin-top:0">DHCP</h3>
      <label><input type="checkbox" id="dhcp-on" ${s.enabled ? 'checked' : ''}> Hand out addresses</label>
      <table class="grid" style="margin-top:8px"><thead><tr><th>Pool</th><th>Gateway</th><th>DNS</th><th>Start IP</th><th>Mask</th><th>Max</th><th></th></tr></thead>
      <tbody>${pools.map((p, i) => `<tr data-i="${i}"><td><input name="name" value="${esc(p.name)}"></td><td><input name="defaultRouter" value="${esc(p.defaultRouter)}"></td><td><input name="dns" value="${esc(p.dns)}"></td><td><input name="startIp" value="${esc(p.startIp)}"></td><td><input name="mask" value="${esc(p.mask)}"></td><td><input name="maxUsers" value="${esc(p.maxUsers)}" style="width:48px"></td><td><button class="btn danger" data-del="${i}" aria-label="Remove pool">×</button></td></tr>`).join('')}</tbody></table>
      <button class="secondary" id="add-pool" style="margin-top:8px">Add pool</button>
      <p class="note">Leases: ${[...s.bindings.entries()].map(([m, b]) => `${b.ip} → ${formatMac(m)}`).join(', ') || 'none yet'}</p>

      <h3>DNS</h3>
      <label><input type="checkbox" id="dns-on" ${d.dns.enabled ? 'checked' : ''}> Answer DNS queries</label>
      <table class="grid" style="margin-top:8px"><thead><tr><th>Name</th><th>Address</th><th></th></tr></thead>
      <tbody>${d.dns.records.map((r, i) => `<tr data-r="${i}"><td><input name="name" value="${esc(r.name)}"></td><td><input name="ip" value="${esc(r.ip)}"></td><td><button class="btn danger" data-rdel="${i}" aria-label="Remove record">×</button></td></tr>`).join('')}</tbody></table>
      <button class="secondary" id="add-rec" style="margin-top:8px">Add record</button>

      <h3>Web server</h3>
      <label><input type="checkbox" id="http-on" ${d.http.enabled ? 'checked' : ''}> Serve web pages on port 80</label>
      <textarea class="field" id="page" rows="5" style="margin-top:8px;font-size:12.5px">${esc(d.http.pages['index.html'])}</textarea>`;
    const b = this.body;
    const save = () => this.app.changed();
    b.querySelector('#dhcp-on').onchange = (e) => { s.enabled = e.target.checked; save(); };
    b.querySelector('#dns-on').onchange = (e) => { d.dns.enabled = e.target.checked; save(); };
    b.querySelector('#http-on').onchange = (e) => { d.http.enabled = e.target.checked; save(); };
    b.querySelector('#page').onchange = (e) => { d.http.pages['index.html'] = e.target.value; save(); };
    b.querySelector('#add-pool').onclick = () => {
      const base = d.nic.ip && d.nic.mask ? networkOf(d.nic.ip, d.nic.mask) : '192.168.1.0';
      const start = base.replace(/\d+$/, (n) => String(Number(n) + 100));
      pools.push({ name: `pool${pools.length + 1}`, network: base, mask: d.nic.mask || '255.255.255.0', defaultRouter: '', dns: d.nic.ip || '', startIp: start, maxUsers: 50 });
      save(); this.tab_services();
    };
    b.querySelector('#add-rec').onclick = () => { d.dns.records.push({ name: 'www.example.lab', ip: d.nic.ip || '' }); save(); this.tab_services(); };
    b.querySelectorAll('[data-del]').forEach((x) => { x.onclick = () => { pools.splice(Number(x.dataset.del), 1); save(); this.tab_services(); }; });
    b.querySelectorAll('[data-rdel]').forEach((x) => { x.onclick = () => { d.dns.records.splice(Number(x.dataset.rdel), 1); save(); this.tab_services(); }; });
    b.querySelectorAll('tr[data-i] input').forEach((inp) => {
      inp.onchange = () => {
        const p = pools[Number(inp.closest('tr').dataset.i)];
        const v = inp.value.trim();
        if (inp.name === 'maxUsers') p.maxUsers = Number(v) || 0;
        else p[inp.name] = v || null;
        if (p.startIp && p.mask && isValidIp(p.startIp) && isValidMask(p.mask)) p.network = networkOf(p.startIp, p.mask);
        inp.classList.toggle('bad', ['defaultRouter', 'dns', 'startIp'].includes(inp.name) && v && !isValidIp(v));
        save();
      };
    });
    b.querySelectorAll('tr[data-r] input').forEach((inp) => {
      inp.onchange = () => { d.dns.records[Number(inp.closest('tr').dataset.r)][inp.name] = inp.value.trim(); save(); };
    });
  }

  tab_ports() {
    const d = this.d;
    this.counterSig = counterSignature(d);
    const rows = d.ports.map((p) => {
      const peer = p.link ? `${p.peer.device.name} ${p.peer.name}` : '—';
      const st = p.shutdown ? 'admin down' : p.errDisabled ? 'err-disabled (port security)' : p.isUp() ? (d.stp && !d.stp.forwarding(p) ? 'blocking (STP)' : 'up') : p.link ? 'down' : 'not connected';
      let extra = '';
      if (d.type === 'switch') {
        extra = p.sw.mode === 'trunk' ? `trunk (native ${p.sw.nativeVlan})` : `access VLAN ${p.sw.accessVlan}`;
        const ps = p.sw.portSecurity;
        if (ps?.enabled && p.sw.mode === 'access') extra += `, secure ${ps.addresses.length} of ${ps.maximum}`;
      }
      if (d.type === 'router') {
        const ifs = d.ifaces.filter((i) => i.port === p && i.ip).map((i) => `${i.parent ? `.${i.name.split('.')[1]} ` : ''}${i.ip}/${i.mask ? i.mask.split('.').map(Number).reduce((a, o) => a + o.toString(2).split('1').length - 1, 0) : ''}`);
        extra = ifs.join(', ') || 'no IP';
      }
      const cls = st === 'up' ? 'status-good' : st.startsWith('blocking') ? '' : p.link ? 'status-bad' : '';
      const c = p.counters;
      const drops = c.inDrops + c.outDrops;
      return `<tr><td>${p.name}</td><td class="${cls}">${st}</td>${d.type === 'hub' ? '' : `<td>${esc(extra)}</td>`}<td>${esc(peer)}</td><td class="num">${c.inPackets}</td><td class="num">${c.outPackets}</td><td class="num${drops ? ' status-bad' : ''}" title="${c.inDrops} in, ${c.outDrops} out">${c.inDrops} / ${c.outDrops}</td><td>${formatMac(p.mac)}</td></tr>`;
    }).join('');
    const third = d.type === 'hub' ? '' : `<th>${d.type === 'switch' ? 'VLAN' : 'Address'}</th>`;
    this.body.innerHTML = `<div class="table-scroll"><table class="grid"><thead><tr><th>Port</th><th>Status</th>${third}<th>Connected to</th><th class="num" title="Frames received">In</th><th class="num" title="Frames sent">Out</th><th class="num" title="Frames dropped coming in / going out">Drops</th><th>MAC</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="row-actions"><button class="btn" type="button" data-act="clear-counters">Clear counters</button></div>
      ${d.type === 'hub' ? '<p class="note">A hub repeats every frame out of all its other ports, so it has no reason to drop anything.</p>' : '<p class="note">Drops count frames this device threw away on the port: spanning tree blocking, a VLAN the port does not carry, port security, an interface that is down, or an access list that denied the packet.</p>'}
      ${d.type === 'switch' && d.ports.some((p) => p.errDisabled) ? '<p class="note">A port security violation put a port in the err-disabled state. In the CLI, enter <code>shutdown</code> and then <code>no shutdown</code> on that interface to bring it back.</p>' : ''}
      ${d.type === 'router' ? '<p class="note">Router interfaces start shut down. In the CLI: <code>enable</code>, <code>configure terminal</code>, <code>interface g0/0</code>, <code>ip address …</code>, <code>no shutdown</code>.</p>' : ''}`;
    this.body.querySelector('[data-act="clear-counters"]').onclick = () => d.clearCounters();
  }

  tab_settings() {
    const d = this.d;
    this.body.innerHTML = `
      <form class="form">
        <label for="nm-${d.id}">Display name</label><input type="text" id="nm-${d.id}" value="${esc(d.name)}" style="font-family:var(--ui)">
        <label>Power</label><div><button type="button" class="secondary" id="pwr">${d.powered ? 'Turn off' : 'Turn on'}</button></div>
        <label>Model</label><div>${{ router: 'Router, 3 × Gigabit Ethernet', switch: 'Switch, 24 × Fast Ethernet + 2 × Gigabit', hub: 'Hub, 8 ports', pc: 'PC, 1 × Fast Ethernet', laptop: 'Laptop, 1 × Fast Ethernet', server: 'Server, 1 × Fast Ethernet' }[d.type]}</div>
      </form>
      <div class="form-actions"><button class="secondary danger" id="del">Delete device</button></div>`;
    const nm = this.body.querySelector(`#nm-${d.id}`);
    nm.onchange = () => {
      const v = nm.value.trim().replace(/\s+/g, '-');
      if (!v) return;
      d.name = v;
      if (d.hostname !== undefined) d.hostname = v;
      this.refreshTitle();
      this.app.changed();
    };
    this.body.querySelector('#pwr').onclick = () => {
      d.powered = !d.powered;
      for (const p of d.ports) this.app.net.notifyPort(p);
      if (d.stp) d.stp.markDirty();
      this.app.changed();
      this.tab_settings();
    };
    this.body.querySelector('#del').onclick = () => this.app.removeDevice(d);
  }
}

/** A cheap fingerprint of a device's port counters, so the Ports tab only redraws when they move. */
function counterSignature(d) {
  return d.ports.map((p) => { const c = p.counters; return `${c.inPackets},${c.outPackets},${c.inDrops},${c.outDrops}`; }).join(';');
}
