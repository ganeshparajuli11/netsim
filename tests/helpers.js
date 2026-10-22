import { IosCli } from '../src/cli/ios.js';
import { HostCmd } from '../src/cli/hostcmd.js';

export function ios(dev) {
  const c = new IosCli(dev);
  let buf = '';
  c.out = (t) => { buf += t; };
  return {
    cli: c,
    run(lines) {
      buf = '';
      for (const l of lines.split('\n').map((x) => x.trim()).filter(Boolean)) c.exec(l);
      return buf;
    },
    get out() { return buf; },
  };
}

export function cmd(host) {
  const c = new HostCmd(host);
  let buf = '';
  c.out = (t) => { buf += t; };
  return { cli: c, run(line, net) { buf = ''; c.exec(line); if (net) net.settle(120000); return buf; } };
}
