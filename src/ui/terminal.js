// A small terminal widget that drives either the IOS CLI or the host command prompt.

export class Terminal {
  constructor(container, cli, device, net) {
    this.cli = cli;
    this.device = device;
    this.net = net;
    this.root = document.createElement('div');
    this.root.className = 'term';
    this.root.setAttribute('role', 'log');
    this.pre = document.createElement('pre');
    this.line = document.createElement('div');
    this.line.className = 'line';
    this.promptEl = document.createElement('span');
    this.promptEl.className = 'prompt';
    this.input = document.createElement('input');
    this.input.setAttribute('aria-label', 'Command');
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('autocapitalize', 'off');
    this.line.append(this.promptEl, this.input);
    this.root.append(this.pre, this.line);
    container.appendChild(this.root);
    this.histIdx = -1;

    if (!cli.__buffer) cli.__buffer = cli.banner ? cli.banner() : '';
    this.pre.textContent = cli.__buffer;
    cli.out = (t) => this.write(t);
    cli.onBusyDone = () => this.showInput();

    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root || e.target === this.pre) setTimeout(() => { if (!window.getSelection().toString()) this.input.focus(); }, 0);
    });
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.showInput();
  }

  write(t) {
    if (t.includes('\f')) {
      this.cli.__buffer = '';
      t = t.split('\f').pop();
    }
    this.cli.__buffer = (this.cli.__buffer + t).slice(-60000);
    this.pre.textContent = this.cli.__buffer;
    this.root.scrollTop = this.root.scrollHeight;
  }

  showInput() {
    const busy = !!this.cli.busy;
    this.line.style.display = busy ? 'none' : '';
    this.promptEl.textContent = this.cli.prompt();
    this.input.type = this.cli.awaitPassword ? 'password' : 'text';
    this.root.scrollTop = this.root.scrollHeight;
  }

  focus() { this.input.focus(); }

  onKey(e) {
    const cli = this.cli;
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      if (cli.busy) cli.cancel();
      else { this.write(`${cli.prompt()}${this.input.value}^C\n`); cli.abortDialog?.(); }
      this.input.value = '';
      this.showInput();
      return;
    }
    if (e.key === 'z' && e.ctrlKey) {
      e.preventDefault();
      if (cli.dialog) { this.write(`${cli.prompt()}${this.input.value}^Z\n`); cli.abortDialog(); this.input.value = ''; this.showInput(); return; }
      if (cli.mode && cli.mode !== 'user' && cli.mode !== 'priv') { this.write(`${cli.prompt()}^Z\n`); cli.exec('end'); }
      this.showInput();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = this.input.value;
      this.input.value = '';
      this.histIdx = -1;
      this.write(`${cli.prompt()}${cli.awaitPassword ? '' : v}\n`);
      cli.exec(v);
      this.showInput();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (cli.dialog) return;
      const r = cli.complete?.(this.input.value);
      if (r) this.input.value = r;
      return;
    }
    if (e.key === '?' && cli.help && !cli.dialog) {
      e.preventDefault();
      const v = this.input.value;
      this.write(`${cli.prompt()}${v}?\n${cli.help(v)}\n`);
      this.showInput();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const h = cli.history;
      if (!h.length) return;
      if (e.key === 'ArrowUp') this.histIdx = this.histIdx < 0 ? h.length - 1 : Math.max(0, this.histIdx - 1);
      else this.histIdx = this.histIdx < 0 ? -1 : this.histIdx + 1;
      if (this.histIdx >= h.length) this.histIdx = -1;
      this.input.value = this.histIdx < 0 ? '' : h[this.histIdx];
    }
  }

  destroy() {
    const cli = this.cli;
    cli.out = (t) => { cli.__buffer = (cli.__buffer + t).slice(-60000); };
    cli.onBusyDone = null;
  }
}
