// Lego tuğla renkleri. Her renk için gölge/ışık/yazı rengi otomatik üretilir.

export const COLORS = [
  { key: 'yellow', name: 'Sarı', hex: '#FFC914' },
  { key: 'red', name: 'Kırmızı', hex: '#D2362F' },
  { key: 'orange', name: 'Turuncu', hex: '#FF8A1F' },
  { key: 'lime', name: 'Limon', hex: '#A8D32C' },
  { key: 'green', name: 'Yeşil', hex: '#18A058' },
  { key: 'teal', name: 'Turkuaz', hex: '#16B3C9' },
  { key: 'blue', name: 'Mavi', hex: '#2D6BE4' },
  { key: 'purple', name: 'Mor', hex: '#7B5BD6' },
  { key: 'pink', name: 'Pembe', hex: '#FF8FB8' },
  { key: 'white', name: 'Beyaz', hex: '#F2F4F8' },
  { key: 'black', name: 'Siyah', hex: '#2E323C' },
];

export const PLATES = [
  { key: 'gray', name: 'Gri', hex: '#DDE2E9' },
  { key: 'green', name: 'Yeşil', hex: '#7CC47F' },
  { key: 'blue', name: 'Mavi', hex: '#7DB8EC' },
  { key: 'sand', name: 'Kum', hex: '#E8D5A6' },
];

const KEYS = new Set(COLORS.map((c) => c.key));
export function colorKey(k) { return KEYS.has(k) ? k : 'yellow'; }
export function colorByKey(k) { return COLORS.find((c) => c.key === colorKey(k)); }

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
export function mix(a, b, t) {
  const A = rgb(a), B = rgb(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}
function lum(hex) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb(hex).map(f);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function inkFor(hex) {
  const dark = '#1B1D24', light = '#FFFFFF';
  return contrast(hex, light) >= contrast(hex, dark) ? light : dark;
}

/** Tüm renk sınıflarını (.c-yellow ...) tek seferde <style> olarak ekler. */
export function injectPaletteCss() {
  let css = '';
  for (const c of COLORS) {
    const b = c.hex;
    const bd = mix(b, '#000000', 0.26);
    const bl = mix(b, '#FFFFFF', 0.38);
    const bb = mix(b, '#000000', 0.42);
    const ink = inkFor(b);
    const tintLight = mix(b, '#FFFFFF', 0.86);
    const tintDark = mix(b, '#171b22', 0.86);
    css += `.c-${c.key}{--b:${b};--bd:${bd};--bl:${bl};--bb:${bb};--bi:${ink};--bt:${tintLight};--bti:#1d2330}\n`;
    css += `:root[data-scheme=dark] .c-${c.key}{--bt:${tintDark};--bti:#eef1f6}\n`;
  }
  const el = document.createElement('style');
  el.id = 'palette-css';
  el.textContent = css;
  document.head.append(el);
}
