// Port security for switch access ports.
// Each secured port accepts frames from a limited number of source MAC addresses. Addresses are
// configured by hand (static), learned and kept in the running configuration (sticky), or
// learned and forgotten when the link goes down (dynamic). A frame from any other address is a
// violation, handled in one of three ways:
//   protect  - drop the frame quietly
//   restrict - drop the frame, count it and log it
//   shutdown - put the port in the err-disabled state (the default)
// An err-disabled port stays down until someone enters `shutdown` and then `no shutdown`.

import { formatMac } from './util.js';

export const PSEC_MAX = 132;

export function defaultPortSecurity() {
  return { enabled: false, maximum: 1, sticky: false, violation: 'shutdown', addresses: [], violations: 0, lastSource: null };
}

/** Restores port security settings from a saved file, filling in defaults for older files. */
export function loadPortSecurity(c) {
  const d = defaultPortSecurity();
  if (!c) return d;
  return {
    enabled: !!c.enabled,
    maximum: Number.isInteger(c.maximum) && c.maximum >= 1 && c.maximum <= PSEC_MAX ? c.maximum : 1,
    sticky: !!c.sticky,
    violation: ['shutdown', 'restrict', 'protect'].includes(c.violation) ? c.violation : 'shutdown',
    // dynamic addresses are never saved: they are forgotten as soon as the link goes down
    addresses: (c.addresses || []).filter((a) => a && a.mac && (a.type === 'static' || a.type === 'sticky')).map((a) => ({ mac: String(a.mac).toUpperCase(), type: a.type })),
    violations: 0,
    lastSource: null,
  };
}

/** Saved form: settings plus configured (static and sticky) addresses. */
export function savePortSecurity(ps) {
  return {
    enabled: ps.enabled, maximum: ps.maximum, sticky: ps.sticky, violation: ps.violation,
    addresses: ps.addresses.filter((a) => a.type !== 'dynamic').map((a) => ({ mac: a.mac, type: a.type })),
  };
}

/**
 * Accepts "0001.0002.0003", "00:01:00:02:00:03" or "00-01-00-02-00-03".
 * Returns the internal form (XXXX.XXXX.XXXX) or null. Multicast addresses are refused,
 * since a frame can never come from one.
 */
export function parseMac(text) {
  const hex = String(text).replace(/[.:-]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null;
  const valid = /^[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}$/.test(text)
    || /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(text);
  if (!valid) return null;
  if (parseInt(hex.slice(0, 2), 16) & 1) return null;
  return hex.toUpperCase().match(/..../g).join('.');
}

/** Port Status shown by `show port-security interface`. */
export function portSecurityStatus(port) {
  const ps = port.sw.portSecurity;
  if (!ps.enabled) return 'Secure-down';
  if (port.errDisabled) return 'Secure-shutdown';
  return port.isUp() ? 'Secure-up' : 'Secure-down';
}

/**
 * Checks a frame arriving on an access port. Returns true when the frame may go on.
 * `sw` is the switch, used for logging, explanations and err-disabling the port.
 */
export function checkPortSecurity(sw, port, frame, vlan) {
  const ps = port.sw.portSecurity;
  if (!ps || !ps.enabled || port.sw.mode !== 'access') return true;
  const mac = frame.src;
  const short = shortName(port.name);
  if (ps.addresses.some((a) => a.mac === mac)) {
    sw.explain(`port security on ${short}: ${formatMac(mac)} is a secure address, frame accepted`);
    return true;
  }
  // The same address secured on another port in this VLAN is a violation too.
  const elsewhere = sw.ports.find((p) => p !== port && p.sw.portSecurity?.enabled && p.sw.mode === 'access'
    && p.sw.accessVlan === vlan && p.sw.portSecurity.addresses.some((a) => a.mac === mac));
  if (!elsewhere && ps.addresses.length < ps.maximum) {
    const type = ps.sticky ? 'sticky' : 'dynamic';
    ps.addresses.push({ mac, type });
    ps.lastSource = { mac, vlan };
    sw.explain(`port security on ${short}: learned ${formatMac(mac)} as a ${type} secure address (${ps.addresses.length} of ${ps.maximum})`);
    if (type === 'sticky') sw.net?.emit('config', sw);
    return true;
  }
  ps.lastSource = { mac, vlan };
  const why = elsewhere
    ? `${formatMac(mac)} is already a secure address on ${shortName(elsewhere.name)}`
    : `${formatMac(mac)} is not a secure address and the port already has its maximum of ${ps.maximum}`;
  if (ps.violation === 'protect') {
    sw.explain(`port security violation on ${short}: ${why}. Mode protect: frame dropped without logging`);
    return false;
  }
  ps.violations++;
  if (ps.violation === 'restrict') {
    sw.explain(`port security violation on ${short}: ${why}. Mode restrict: frame dropped, violation counted (${ps.violations}) and logged`);
    sw.syslog(`%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${formatMac(mac)} on port ${port.name}.`);
    return false;
  }
  sw.explain(`port security violation on ${short}: ${why}. Mode shutdown: the port goes into the err-disabled state. Enter "shutdown" and then "no shutdown" on it to bring it back`);
  sw.syslog(`%PM-4-ERR_DISABLE: psecure-violation error detected on ${short}, putting ${short} in err-disable state`);
  sw.syslog(`%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${formatMac(mac)} on port ${port.name}.`);
  port.errDisabled = true;
  sw.net?.notifyPort(port);
  sw.net?.emit('config', sw);
  return false;
}

function shortName(n) {
  return n.replace(/^GigabitEthernet/, 'Gi').replace(/^FastEthernet/, 'Fa');
}
