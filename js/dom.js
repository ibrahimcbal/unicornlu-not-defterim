// Küçük DOM yardımcıları. Kullanıcı metni asla innerHTML ile basılmaz; yalnızca textContent.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5"/>',
  restore: '<path d="M4 9h10a5 5 0 010 10H8M4 9l4-4M4 9l4 4"/>',
  drop: '<path d="M12 3c3 4 6 7 6 10a6 6 0 01-12 0c0-3 3-6 6-10z"/>',
  list: '<path d="M10 6h10M10 12h10M10 18h10M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  text: '<path d="M5 6h14M5 11h14M5 16h9"/>',
  grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  sync: '<path d="M20 11a8 8 0 00-14-4L4 9M4 4v5h5M4 13a8 8 0 0014 4l2-2M20 20v-5h-5"/>',
  cloud: '<path d="M7 18a4 4 0 01-.5-8 5.5 5.5 0 0110.7-1A4.5 4.5 0 0117 18H7z"/>',
  cloudok: '<path d="M7 18a4 4 0 01-.5-8 5.5 5.5 0 0110.7-1A4.5 4.5 0 0117 18H7z"/><path d="M9.5 13l2 2 3.5-4"/>',
  cloudoff: '<path d="M7 18a4 4 0 01-.5-8c.1-.5.3-1 .5-1.4M10 6.2A5.5 5.5 0 0117.200 9 4.500 4.500 0 0120 12.500M17 18H7M4 4l16 16"/>',
  warn: '<path d="M12 4l9 16H3L12 4zM12 10v4M12 17v.5"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>',
  copy: '<path d="M9 9h10v10H9zM5 15V5h10"/>',
  link: '<path d="M10 14a4 4 0 005.6 0l3-3a4 4 0 00-5.6-5.6l-1 1M14 10a4 4 0 00-5.6 0l-3 3a4 4 0 005.6 5.6l1-1"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>',
  bell: '<path d="M6 9a6 6 0 0112 0c0 5 2 6 2 7H4c0-1 2-2 2-7zM10 19a2 2 0 004 0"/>',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  resize: '<path d="M15 21h6v-6M21 21l-8-8"/>',
  calendar: '<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4"/>',
  home: '<path d="M4 11l8-7 8 7M6 10v10h12V10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4"/>',
  moon: '<path d="M20 14.5A8 8 0 019.500 4 8 8 0 1020 14.500z"/>',
};

export function icon(name, size = 22) {
  size = Number(size) || 22; // innerHTML'e yalnızca sayı ve sabit yol girer
  const span = document.createElement('span');
  span.className = 'ic';
  span.innerHTML =
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
  return span;
}

export function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.firstChild) return;
    el.append(icon(el.dataset.icon, Number(el.dataset.size) || 22));
  });
}
