// Original line-drawn device symbols, drawn in a 64x48 box centred on 0,0.

const arrow = (x1, y1, x2, y2) => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const h = 4.5;
  const p1 = [x2 - h * Math.cos(a - 0.6), y2 - h * Math.sin(a - 0.6)];
  const p2 = [x2 - h * Math.cos(a + 0.6), y2 - h * Math.sin(a + 0.6)];
  return `M${x1} ${y1}L${x2} ${y2}M${p1[0].toFixed(1)} ${p1[1].toFixed(1)}L${x2} ${y2}L${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
};

export const ICONS = {
  router: `
    <ellipse class="halo" cx="0" cy="0" rx="34" ry="27"/>
    <ellipse class="body" cx="0" cy="5" rx="25" ry="13"/>
    <path class="body" d="M-25 -3v8a25 13 0 0 0 50 0v-8"/>
    <ellipse class="body" cx="0" cy="-3" rx="25" ry="13"/>
    <path class="glyph" d="${arrow(-4, -6, -16, -11)} ${arrow(4, 0, 16, 5)} ${arrow(16, -11, 4, -6)} ${arrow(-16, 5, -4, 0)}"/>`,
  switch: `
    <rect class="halo" x="-34" y="-25" width="68" height="50" rx="10"/>
    <path class="body" d="M-27 -10l8 -8h46l-8 8z"/>
    <path class="body" d="M19 -10l8 -8v18l-8 8z"/>
    <rect class="body" x="-27" y="-10" width="46" height="18"/>
    <path class="glyph" d="${arrow(-20, -3, -2, -3)} ${arrow(12, 3, -6, 3)} ${arrow(4, -3, 13, -3)} ${arrow(-11, 3, -20, 3)}"/>`,
  hub: `
    <rect class="halo" x="-34" y="-25" width="68" height="50" rx="10"/>
    <path class="body" d="M-27 -6l6 -6h46l-6 6z"/>
    <path class="body" d="M19 -6l6 -6v14l-6 6z"/>
    <rect class="body" x="-27" y="-6" width="46" height="14"/>
    <path class="glyph" d="${arrow(-4, 1, -20, 1)} ${arrow(-4, 1, 12, 1)}"/>`,
  pc: `
    <rect class="halo" x="-30" y="-27" width="60" height="54" rx="10"/>
    <rect class="body" x="-22" y="-20" width="44" height="30" rx="2.5"/>
    <rect class="glyph" x="-18" y="-16" width="36" height="22" rx="1"/>
    <path class="body" d="M-5 10h10l2 6h-14z"/>
    <rect class="body" x="-14" y="16" width="28" height="4" rx="1.5"/>`,
  laptop: `
    <rect class="halo" x="-32" y="-26" width="64" height="50" rx="10"/>
    <path class="body" d="M-18 -18h36v24h-36z"/>
    <rect class="glyph" x="-14" y="-14" width="28" height="16" rx="1"/>
    <path class="body" d="M-24 8h48l-4 8h-40z"/>`,
  server: `
    <rect class="halo" x="-24" y="-29" width="48" height="58" rx="10"/>
    <rect class="body" x="-15" y="-22" width="30" height="44" rx="2.5"/>
    <path class="glyph" d="M-10 -14h20M-10 -8h20M-10 -2h20"/>
    <circle class="glyph solid" cx="7" cy="13" r="2"/>
    <path class="glyph" d="M-10 13h10"/>`,
};

export function iconSvg(type, size = 44) {
  return `<svg viewBox="-34 -29 68 58" width="${size}" height="${Math.round(size * 0.78)}" class="device" aria-hidden="true"><g>${ICONS[type] || ''}</g></svg>`;
}

export const PROTO_COLORS = {
  ARP: 'var(--p-arp)', ICMP: 'var(--p-icmp)', DHCP: 'var(--p-dhcp)', DNS: 'var(--p-dns)', RIP: 'var(--p-rip)', HTTP: 'var(--p-http)', TCP: 'var(--p-http)', UDP: 'var(--p-other)', STP: 'var(--p-other)', IPv4: 'var(--p-other)',
};
