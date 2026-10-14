// Not Defterim — arayüz. Veri: store.js, eşitleme: sync.js.
import { Store, openBestBackend, SIZES, noteSearchText, fold, newItemId, sameContent, fromRemote } from './store.js';
import { SyncEngine, encodeSetup, decodeSetup, cleanRepo } from './sync.js';
import { COLORS, PLATES, colorKey, injectPaletteCss } from './palette.js';
import { h, icon, clear, fillIcons } from './dom.js';
import * as fx from './fx.js';

const VERSION = '1.1.0';
const DEFAULT_REPO = 'ibrahimcbal/unicornlu-notlar';
const TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

const $ = (id) => document.getElementById(id);
const els = {};
let store;
let sync;
let prefs = { scheme: 'auto', plate: 'gray', sound: false, sort: 'updated', textSize: 'm', font: 'round', shortcuts: true };
const ui = { filter: 'all', query: '', cols: 4, cell: 90, cards: new Map(), firstRender: true, quiet: new Set(), renderQueued: false, sheetKind: null };
const ed = { id: null, fresh: false, patch: null, timer: 0, items: [], pop: null, closing: false };
let sheetOpen = false;
let installEvent = null;

// ------------------------------------------------------------------ yardımcılar

const tfmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
const dfmt = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short' });

function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const diff = now - d;
  if (diff < 45_000) return 'az önce';
  if (diff < 3_600_000) return Math.round(diff / 60_000) + ' dk önce';
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, now)) return 'bugün ' + tfmt.format(d);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (same(d, y)) return 'dün ' + tfmt.format(d);
  return dfmt.format(d) + ' ' + tfmt.format(d);
}

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
const isMobileLayout = () => window.matchMedia('(max-width: 699px)').matches;
const finePointer = () => window.matchMedia('(pointer: fine)').matches;

function isEmptyNote(n) {
  return !n.title.trim() && !n.body.trim() && !(n.items || []).some((i) => i.t.trim());
}

function autoSize(n) {
  let w = n.title.length * 1.5;
  if (n.type === 'list') w += (n.items || []).reduce((s, i) => s + Math.min(i.t.length, 60) + 12, 0);
  else w += n.body.length;
  if (w <= 70) return '2x2';
  if (w <= 150) return '2x3';
  if (w <= 220) return '4x2';
  return '4x3';
}

function brickDims(n) {
  const s = SIZES.includes(n.size) ? n.size : autoSize(n);
  const [w, hh] = s.split('x').map(Number);
  return { w: Math.min(w, ui.cols), h: hh };
}

// ------------------------------------------------------------------ tercihler

function resolveScheme() {
  if (prefs.scheme === 'light' || prefs.scheme === 'dark') return prefs.scheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyPrefs() {
  const root = document.documentElement;
  const scheme = resolveScheme();
  root.dataset.scheme = scheme;
  root.dataset.plate = prefs.plate;
  root.dataset.text = prefs.textSize || 'm';
  root.dataset.font = prefs.font || 'round';
  fx.setSound(prefs.sound);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', scheme === 'dark' ? '#0f1217' : '#f3efe8');
}

function savePrefs() {
  store.setMeta('prefs', prefs);
  try { localStorage.setItem('unb:prefs', JSON.stringify(prefs)); } catch {}
  applyPrefs();
}

// ------------------------------------------------------------------ odak / erişilebilirlik

function setBackgroundInert(on) {
  for (const el of [els.top, els.boardWrap, els.fabs]) {
    if ('inert' in el) el.inert = on;
    else el.setAttribute('aria-hidden', String(on));
  }
}

let returnFocusTo = null;
function rememberFocus() {
  if (!returnFocusTo) returnFocusTo = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
}
function restoreFocus() {
  const el = returnFocusTo;
  returnFocusTo = null;
  // Eski öğe artık yoksa (ör. çöpe atılan kart) ilk karta ya da "yeni not" düğmesine dön.
  const target = el && el.isConnected ? el : document.querySelector('.brick') || els.fabNew;
  if (target && typeof target.focus === 'function') { try { target.focus({ preventScroll: true }); } catch {} }
}

function focusKeyOf(el) {
  return el && el.tagName ? el.tagName + '|' + (el.getAttribute('aria-label') || el.textContent.trim()) : null;
}
function refocus(root, key) {
  if (!key) return;
  for (const c of root.querySelectorAll('button, a, input, textarea')) {
    if (focusKeyOf(c) === key) { try { c.focus({ preventScroll: true }); } catch {} return; }
  }
}

/** Tab, açık iletişim kutusunun içinde dönsün. */
function trapTab(e) {
  if (e.key !== 'Tab') return;
  const box = ed.id ? els.ed : sheetOpen ? els.sheetPanel : null;
  if (!box) return;
  const items = [...box.querySelectorAll('button, input, textarea, a[href], [tabindex="0"]')].filter(
    (n) => !n.disabled && !n.closest('[hidden]') && n.offsetParent !== null,
  );
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const a = document.activeElement;
  if (!box.contains(a)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
}

// ------------------------------------------------------------------ bildirim

function toast(msg, { action, ms = 4500 } = {}) {
  while (els.toasts.children.length >= 2) els.toasts.firstChild.remove();
  let t;
  const dismiss = () => {
    if (!t.isConnected) return;
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  };
  t = h('div', { class: 'toast', role: 'status' }, h('span', null, msg),
    action ? h('button', { type: 'button', onclick: () => { action.fn(); dismiss(); } }, action.label) : null);
  els.toasts.append(t);
  setTimeout(dismiss, ms);
  return dismiss;
}

// ------------------------------------------------------------------ filtre / liste

function buildChips() {
  clear(els.chips);
  const mk = (key, content, cls, label) =>
    h('button', {
      type: 'button',
      class: 'chip ' + (cls || ''),
      'aria-pressed': String(ui.filter === key),
      'aria-label': label,
      title: label,
      dataset: { f: key },
      onclick: () => setFilter(ui.filter === key && key !== 'all' ? 'all' : key),
    }, content);
  els.chips.append(mk('all', 'Hepsi', '', 'Hepsi'));
  for (const c of COLORS) els.chips.append(mk(c.key, null, 'dot c-' + c.key, c.name));
  els.chips.append(mk('trash', [icon('trash', 18), 'Çöp'], '', 'Çöp kutusu'));
}

function setFilter(f) {
  ui.filter = f;
  for (const b of els.chips.children) b.setAttribute('aria-pressed', String(b.dataset.f === f));
  render();
  window.scrollTo({ top: 0 });
}

function visibleNotes() {
  const q = fold(ui.query.trim());
  let list = store.all().filter((n) => !n._purge);
  if (ui.filter === 'trash') list = list.filter((n) => n.trashedAt);
  else {
    list = list.filter((n) => !n.trashedAt);
    if (ui.filter !== 'all') list = list.filter((n) => colorKey(n.color) === ui.filter);
  }
  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    list = list.filter((n) => {
      const t = noteSearchText(n);
      return words.every((w) => t.includes(w));
    });
  }
  if (ui.filter === 'trash') list.sort((a, b) => (b.trashedAt || 0) - (a.trashedAt || 0));
  else {
    const colorIdx = (n) => COLORS.findIndex((c) => c.key === colorKey(n.color));
    const byUpdated = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
    const cmp = {
      updated: byUpdated,
      created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      title: (a, b) => (a.title.trim() || '\uffff').localeCompare(b.title.trim() || '\uffff', 'tr') || byUpdated(a, b),
      color: (a, b) => colorIdx(a) - colorIdx(b) || byUpdated(a, b),
    }[prefs.sort] || byUpdated;
    list.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || cmp(a, b));
  }
  return list;
}

function layoutGrid() {
  const board = els.board;
  const cs = getComputedStyle(board);
  const inner = board.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (inner <= 0) return false;
  const target = inner < 560 ? 90 : 98;
  const cols = Math.max(2, 2 * Math.round(inner / target / 2));
  const cell = inner / cols;
  const changed = cols !== ui.cols || Math.abs(cell - ui.cell) > 0.5;
  ui.cols = cols;
  ui.cell = cell;
  els.grid.style.setProperty('--cols', cols);
  els.grid.style.setProperty('--cell', cell + 'px');
  return changed;
}

function cardSig(n, d) {
  return JSON.stringify([
    n.title, n.body.slice(0, 500), n.type,
    (n.items || []).slice(0, 12).map((i) => [i.t.slice(0, 80), i.d]), (n.items || []).length,
    colorKey(n.color), n.pinned, d.w, d.h, ui.filter === 'trash',
  ]);
}

function studsEl(w) {
  const s = h('div', { class: 'studs', 'aria-hidden': 'true' });
  for (let i = 0; i < w; i++) s.append(h('i'));
  return s;
}

function fillCard(el, n, d) {
  for (const c of [...el.classList]) if (c.startsWith('c-')) el.classList.remove(c);
  el.classList.add('c-' + colorKey(n.color));
  el.style.setProperty('--w', d.w);
  el.style.setProperty('--h', d.h);
  clear(el);
  const inTrash = ui.filter === 'trash';
  const body = h('div', { class: 'bb' });
  const title = n.title.trim();
  if (title) body.append(h('h3', null, title));
  if (n.type === 'list') {
    const items = n.items || [];
    if (items.length) {
      const ul = h('ul', { class: 'chk' });
      for (const it of items.slice(0, 9)) ul.append(h('li', { class: it.d ? 'd' : '' }, h('i', { class: 'cb' }), h('span', null, it.t || '…')));
      if (items.length > 9) ul.append(h('li', { class: 'more' }, `+${items.length - 9} madde daha`));
      body.append(ul);
    } else if (!title) body.append(h('p', { class: 'none' }, 'Boş liste'));
  } else if (n.body.trim()) {
    body.append(h('p', null, n.body.slice(0, 500)));
  } else if (!title) {
    body.append(h('p', { class: 'none' }, 'Boş not'));
  }
  el.append(studsEl(d.w), body);
  if (n.pinned && !inTrash) el.append(h('span', { class: 'pinned-badge' }, icon('pin', 18)));
  const quick = h('div', { class: 'quick' + (inTrash ? ' show' : '') });
  if (inTrash) {
    quick.append(
      h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); store.restore(n.id); fx.snap(); } }, icon('restore', 17), 'Geri al'),
      h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); purgeWithConfirm(n.id); } }, icon('x', 17), 'Sil'),
    );
  } else {
    quick.append(
      h('button', { type: 'button', 'aria-label': n.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle', onclick: (e) => { e.stopPropagation(); store.edit(n.id, { pinned: !n.pinned }); fx.snap(0.7); } }, icon('pin', 17)),
      h('button', { type: 'button', 'aria-label': 'Çöpe at', onclick: (e) => { e.stopPropagation(); trashCard(n.id); } }, icon('trash', 17)),
    );
  }
  el.append(quick);
  el.setAttribute('aria-label', (title || 'Adsız not') + (n.type === 'list' ? ', liste' : '') + (inTrash ? '' : '. Düzenlemek için Enter'));
}

function makeCard(id) {
  const el = h('article', { class: 'brick', tabindex: '0', dataset: { id } });
  el.addEventListener('click', () => {
    if (ui.filter === 'trash') return;
    openEditor(id);
  });
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
      e.preventDefault();
      if (ui.filter !== 'trash') openEditor(id);
    }
  });
  return el;
}

function render() {
  ui.renderQueued = false;
  const list = visibleNotes();
  const first = new Map();
  if (fx.motionOK() && ui.cards.size && ui.cards.size < 160) {
    for (const el of ui.cards.values()) if (el.isConnected) first.set(el, el.getBoundingClientRect());
  }
  const seen = new Set();
  let prev = null;
  let enterIdx = 0;
  for (const n of list) {
    seen.add(n.id);
    const d = brickDims(n);
    let el = ui.cards.get(n.id);
    let isNew = false;
    if (!el) { el = makeCard(n.id); ui.cards.set(n.id, el); isNew = true; }
    const sig = cardSig(n, d);
    if (el._sig !== sig) { fillCard(el, n, d); el._sig = sig; }
    const expected = prev ? prev.nextElementSibling : els.grid.firstElementChild;
    if (el !== expected) els.grid.insertBefore(el, expected);
    prev = el;
    if (isNew && fx.motionOK() && !ui.quiet.has(n.id)) {
      el.classList.add('enter');
      el.style.animationDelay = Math.min(enterIdx++ * 30, 480) + 'ms';
      el.addEventListener('animationend', () => { el.classList.remove('enter'); el.style.animationDelay = ''; }, { once: true });
    }
  }
  for (const [id, el] of ui.cards) {
    if (!seen.has(id)) { el.remove(); ui.cards.delete(id); }
  }
  ui.quiet.clear();
  ui.firstRender = false;
  fx.flip(first);

  // boş durum
  const total = store.all().filter((n) => !n._purge && !n.trashedAt).length;
  els.empty.hidden = list.length > 0;
  if (!els.empty.hidden) {
    if (ui.filter === 'trash') { els.emptyTitle.textContent = 'Çöp kutusu boş'; els.emptyText.textContent = 'Sildiğin notlar 30 gün burada bekler.'; }
    else if (ui.query.trim()) { els.emptyTitle.textContent = 'Eşleşen tuğla yok'; els.emptyText.textContent = 'Başka bir sözcükle aramayı dene.'; }
    else if (total && ui.filter !== 'all') { els.emptyTitle.textContent = 'Bu renkte not yok'; els.emptyText.textContent = 'Başka bir renk seç ya da yeni bir tuğla ekle.'; }
    else { els.emptyTitle.textContent = 'Taban plakası boş'; els.emptyText.textContent = 'İlk tuğlanı eklemek için sağ alttaki + düğmesine bas.'; }
  }
}

function scheduleRender() {
  if (ui.renderQueued) return;
  ui.renderQueued = true;
  requestAnimationFrame(render);
}

async function trashCard(id) {
  const el = ui.cards.get(id);
  if (el) { el.classList.add('leaving'); await fx.crumble(el); }
  store.trash(id);
  fx.snap(0.7);
  toast('Çöpe taşındı', { action: { label: 'Geri al', fn: () => store.restore(id) } });
}

function purgeWithConfirm(id) {
  if (!window.confirm('Bu not kalıcı olarak silinecek. (Depo geçmişindeki eski sürümleri GitHub\'da kalabilir.) Emin misin?')) return;
  store.purge(id);
}

// ------------------------------------------------------------------ yeni not

function createNote(type) {
  if (ed.id) return;
  const lastColor = store.getMeta('lastColor', 'yellow');
  const n = store.create({
    type,
    color: colorKey(lastColor),
    items: type === 'list' ? [{ id: newItemId(), t: '', d: false }] : [],
  });
  ui.quiet.add(n.id);
  render();
  const rect = (type === 'list' ? els.fabList : els.fabNew).getBoundingClientRect();
  openEditor(n.id, { fromRect: rect, fresh: true });
}

// ------------------------------------------------------------------ editör

function autosize(ta) {
  const sc = ta.closest('.ed-scroll');
  const y = sc ? sc.scrollTop : 0;
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
  if (sc) sc.scrollTop = y;
}

function buildEdStuds() {
  if (els.edStuds.childElementCount) return;
  for (let i = 0; i < 8; i++) els.edStuds.append(h('i'));
}

function setEdInfo(text) { els.edInfo.textContent = text; }

/** Notun düz metin hâli (kopyala / paylaş / kelime sayısı için). */
function noteText(n) {
  const parts = [];
  if (n.title.trim()) parts.push(n.title.trim());
  if (n.type === 'list') parts.push((n.items || []).filter((i) => i.t.trim()).map((i) => (i.d ? '☑ ' : '☐ ') + i.t).join('\n'));
  else if (n.body.trim()) parts.push(n.body);
  return parts.join('\n\n');
}

function insertDate() {
  const ta = els.edBody;
  if (ta.hidden) return;
  const d = new Date();
  const text = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).format(d) + ' ' + tfmt.format(d);
  ta.focus({ preventScroll: true });
  const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  const e = ta.selectionEnd == null ? s : ta.selectionEnd;
  ta.setRangeText(text, s, e, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

async function copyCurrentNote() {
  flushSave();
  const n = store.get(ed.id);
  if (!n) return;
  const ok = await copyText(noteText(n));
  toast(ok ? 'Not kopyalandı.' : 'Kopyalanamadı.');
}

async function shareCurrentNote() {
  flushSave();
  const n = store.get(ed.id);
  if (!n || !navigator.share) return;
  try { await navigator.share({ title: n.title || 'Not', text: noteText(n) }); } catch {}
}

function updateEdInfo() {
  const n = ed.id && store.get(ed.id);
  if (!n) return;
  const when = 'Düzenlendi: ' + fmtWhen(n.updatedAt);
  let st = '';
  if (sync.isConfigured()) st = n._dirty ? 'Eşitlenmeyi bekliyor' : 'Eşitlendi';
  else st = 'Yalnızca bu cihazda';
  const words = noteText(n).trim().split(/\s+/).filter(Boolean).length;
  setEdInfo(words + ' kelime · ' + when + ' · ' + st);
}

function fillEditor(n) {
  buildEdStuds();
  els.ed.className = 'ed c-' + colorKey(n.color);
  els.edTitle.value = n.title;
  els.edPin.setAttribute('aria-pressed', String(!!n.pinned));
  ed.items = (n.items || []).map((i) => ({ ...i }));
  setTypeUi(n);
  updateEdInfo();
}

function setTypeUi(n) {
  const isList = n.type === 'list';
  els.edBody.hidden = isList;
  els.edDate.hidden = isList;
  els.edList.hidden = !isList;
  clear(els.edType).append(icon(isList ? 'text' : 'list'));
  els.edType.setAttribute('aria-label', isList ? 'Düz metne çevir' : 'Listeye çevir');
  if (isList) {
    if (!ed.items.length) ed.items.push({ id: newItemId(), t: '', d: false });
    renderList();
  } else {
    els.edBody.value = n.body;
    requestAnimationFrame(() => autosize(els.edBody));
  }
}

function queueSave(patch) {
  ed.patch = { ...(ed.patch || {}), ...patch };
  clearTimeout(ed.timer);
  ed.timer = setTimeout(flushSave, 300);
}

function flushSave() {
  clearTimeout(ed.timer);
  if (!ed.id || !ed.patch) return;
  const patch = ed.patch;
  ed.patch = null;
  const cur = store.get(ed.id);
  if (!cur) return;
  if (sameContent({ ...cur, ...patch }, cur)) return;
  store.edit(ed.id, patch);
  updateEdInfo();
}

function listItemsForSave() {
  return ed.items.map((i) => ({ id: i.id, t: i.t, d: !!i.d }));
}

function renderList(focusId) {
  clear(els.edList);
  for (const it of ed.items) els.edList.append(listRow(it));
  els.edList.append(
    h('button', { class: 'li-add', type: 'button', onclick: () => addItemAfter(ed.items.length ? ed.items[ed.items.length - 1].id : null) },
      h('span', { class: 'plus' }, icon('plus', 16)), 'Madde ekle'),
  );
  if (ed.items.some((i) => i.d)) {
    els.edList.append(h('button', { class: 'li-clean', type: 'button', onclick: clearDone }, 'Tamamlananları temizle'));
  }
  els.edList.querySelectorAll('textarea').forEach(autosize);
  if (focusId) {
    const row = els.edList.querySelector(`.li[data-id="${focusId}"] textarea`);
    if (row) row.focus();
  }
}

function listRow(it) {
  const ta = h('textarea', { class: 'li-text', rows: '1', placeholder: 'Madde', 'aria-label': 'Madde', enterkeyhint: 'next' });
  ta.value = it.t;
  const row = h('div', { class: 'li' + (it.d ? ' done' : ''), dataset: { id: it.id } });
  const cb = h('button', {
    class: 'li-cb', type: 'button', 'aria-label': 'Tamamlandı olarak işaretle', 'aria-pressed': String(!!it.d),
    onclick: () => toggleItem(it.id, row, cb),
  }, icon('check', 18));
  ta.addEventListener('input', () => {
    it.t = ta.value.replace(/\n/g, ' ');
    autosize(ta);
    queueSave({ items: listItemsForSave() });
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      addItemAfter(it.id);
    } else if (e.key === 'Backspace' && ta.value === '' && ed.items.length > 1) {
      e.preventDefault();
      removeItem(it.id, true);
    }
  });
  row.append(cb, ta, h('button', { class: 'li-del', type: 'button', 'aria-label': 'Maddeyi sil', onclick: () => removeItem(it.id, false) }, icon('x', 16)));
  return row;
}

function toggleItem(id, row, cb) {
  const it = ed.items.find((i) => i.id === id);
  if (!it) return;
  it.d = !it.d;
  row.classList.toggle('done', it.d);
  cb.setAttribute('aria-pressed', String(it.d));
  fx.snap(0.8);
  fx.buzz(8);
  queueSave({ items: listItemsForSave() });
  const total = ed.items.filter((i) => i.t.trim()).length;
  if (it.d && total >= 2 && ed.items.filter((i) => i.t.trim()).every((i) => i.d)) {
    const r = cb.getBoundingClientRect();
    fx.confetti({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, 22);
  }
  // "Tamamlananları temizle" düğmesi görünürlüğü
  const hasClean = els.edList.querySelector('.li-clean');
  const anyDone = ed.items.some((i) => i.d);
  if (anyDone && !hasClean) els.edList.append(h('button', { class: 'li-clean', type: 'button', onclick: clearDone }, 'Tamamlananları temizle'));
  if (!anyDone && hasClean) hasClean.remove();
}

function addItemAfter(id) {
  const item = { id: newItemId(), t: '', d: false };
  const idx = id ? ed.items.findIndex((i) => i.id === id) : -1;
  ed.items.splice(idx < 0 ? ed.items.length : idx + 1, 0, item);
  renderList(item.id);
  const row = els.edList.querySelector(`.li[data-id="${item.id}"]`);
  if (row && fx.motionOK()) row.classList.add('pop-in');
  queueSave({ items: listItemsForSave() });
}

function removeItem(id, focusPrev) {
  const idx = ed.items.findIndex((i) => i.id === id);
  if (idx < 0) return;
  ed.items.splice(idx, 1);
  if (!ed.items.length) ed.items.push({ id: newItemId(), t: '', d: false });
  const neighbor = focusPrev ? ed.items[Math.max(0, idx - 1)] : ed.items[Math.min(idx, ed.items.length - 1)];
  // Dokunmatik cihazda klavye açılmasın diye yalnızca klavye/fare ile odaklanır.
  renderList(focusPrev || finePointer() ? neighbor.id : null);
  queueSave({ items: listItemsForSave() });
}

function clearDone() {
  ed.items = ed.items.filter((i) => !i.d);
  if (!ed.items.length) ed.items.push({ id: newItemId(), t: '', d: false });
  renderList();
  const addBtn = els.edList.querySelector('.li-add');
  if (addBtn) addBtn.focus({ preventScroll: true });
  queueSave({ items: listItemsForSave() });
  fx.snap(0.8);
}

function convertType() {
  flushSave();
  const n = store.get(ed.id);
  if (!n) return;
  if (n.type === 'text') {
    const items = n.body
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^\[( |x|X)\]\s*(.*)$/.exec(l);
        return { id: newItemId(), t: m ? m[2] : l, d: m ? m[1].toLowerCase() === 'x' : false };
      });
    store.edit(ed.id, { type: 'list', items, body: '' });
  } else {
    const body = (n.items || []).filter((i) => i.t.trim()).map((i) => (i.d ? '[x] ' : '') + i.t).join('\n');
    store.edit(ed.id, { type: 'text', body, items: [] });
  }
  const n2 = store.get(ed.id);
  ed.items = (n2.items || []).map((i) => ({ ...i }));
  setTypeUi(n2);
  updateEdInfo();
  fx.snap();
}

function closePopover() {
  if (!ed.pop) return;
  const hadFocus = els.pop.contains(document.activeElement);
  const trigger = ed.pop === 'color' ? els.edColor : els.edSize;
  ed.pop = null;
  els.pop.hidden = true;
  clear(els.pop);
  els.edColor.setAttribute('aria-expanded', 'false');
  els.edSize.setAttribute('aria-expanded', 'false');
  if (hadFocus) trigger.focus({ preventScroll: true });
}

function openPopover(kind) {
  if (ed.pop === kind) { closePopover(); return; }
  closePopover();
  const n = store.get(ed.id);
  if (!n) return;
  ed.pop = kind;
  clear(els.pop);
  if (kind === 'color') {
    els.pop.append(h('h4', null, 'Tuğla rengi'));
    const g = h('div', { class: 'swatches' });
    for (const c of COLORS) {
      g.append(h('button', {
        type: 'button', class: 'swatch c-' + c.key, 'aria-label': c.name,
        'aria-pressed': String(colorKey(n.color) === c.key),
        onclick: () => {
          flushSave();
          store.edit(ed.id, { color: c.key });
          store.setMeta('lastColor', c.key);
          els.ed.className = 'ed c-' + c.key;
          for (const b of g.children) b.setAttribute('aria-pressed', String(b.classList.contains('c-' + c.key)));
          fx.snap();
          fx.buzz(8);
          updateEdInfo();
          setTimeout(closePopover, 260);
        },
      }, colorKey(n.color) === c.key ? icon('check', 16) : null));
    }
    els.pop.append(g);
    els.edColor.setAttribute('aria-expanded', 'true');
  } else {
    els.pop.append(h('h4', null, 'Tuğla boyutu (genişlik × yükseklik)'));
    const g = h('div', { class: 'sizes' });
    const cur = SIZES.includes(n.size) ? n.size : 'auto';
    for (const s of ['auto', ...SIZES]) {
      let mini;
      if (s === 'auto') mini = h('span', { class: 'mini auto' }, 'A');
      else {
        const [w, hh] = s.split('x').map(Number);
        mini = h('span', { class: 'mini', style: { '--w': w } });
        for (let i = 0; i < w * hh; i++) mini.append(h('i'));
      }
      g.append(h('button', {
        type: 'button', class: 'size-opt', 'aria-pressed': String(cur === s),
        onclick: () => {
          flushSave();
          store.edit(ed.id, { size: s });
          fx.snap();
          setTimeout(closePopover, 200);
        },
      }, mini, s === 'auto' ? 'Otomatik' : s.replace('x', '×')));
    }
    els.pop.append(g);
    els.edSize.setAttribute('aria-expanded', 'true');
  }
  els.pop.hidden = false;
  const firstBtn = els.pop.querySelector('button[aria-pressed="true"]') || els.pop.querySelector('button');
  if (firstBtn) firstBtn.focus({ preventScroll: true });
}

function syncViewport() {
  const vv = window.visualViewport;
  const mobile = !!vv && isMobileLayout();
  if (ed.id) {
    if (mobile) {
      els.ed.style.top = vv.offsetTop + 'px';
      els.ed.style.height = vv.height + 'px';
      els.ed.style.bottom = 'auto';
    } else {
      els.ed.style.top = els.ed.style.height = els.ed.style.bottom = '';
    }
  }
  if (sheetOpen) {
    if (mobile) {
      els.sheet.style.top = vv.offsetTop + 'px';
      els.sheet.style.height = vv.height + 'px';
      els.sheet.style.bottom = 'auto';
    } else {
      els.sheet.style.top = els.sheet.style.height = els.sheet.style.bottom = '';
    }
  }
}

function lockScroll(on) {
  document.documentElement.classList.toggle('modal-open', on);
  document.body.classList.toggle('modal-open', on);
}

function openEditor(id, { fromRect = null, fresh = false } = {}) {
  const n = store.get(id);
  if (!n || ed.id) return;
  closeSheetNow();
  rememberFocus();
  ed.scrollY = window.scrollY;
  setBackgroundInert(true);
  ed.id = id;
  ed.fresh = fresh;
  ed.patch = null;
  ed.closing = false;
  const card = ui.cards.get(id);
  const rect = fromRect || (card ? card.getBoundingClientRect() : null);
  fillEditor(n);
  els.editor.hidden = false;
  lockScroll(true);
  syncViewport();
  try { history.pushState({ ed: id }, ''); } catch {}
  if (card) card.style.visibility = 'hidden';
  fx.morph(els.ed, rect, { duration: 460 });
  if (els.edBackdrop.animate) els.edBackdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: 'backwards' });
  if (els.edPaper.animate && fx.motionOK()) els.edPaper.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 140, fill: 'backwards' });
  fx.snap(0.8);
  setTimeout(() => {
    if (n.type === 'text') autosize(els.edBody);
    els.edList.querySelectorAll('textarea').forEach(autosize);
    let focused = false;
    if (fresh || finePointer()) {
      focused = true;
      if (fresh && n.type === 'list') {
        const ta = els.edList.querySelector('textarea');
        if (ta) ta.focus({ preventScroll: true });
      } else if (fresh) els.edTitle.focus({ preventScroll: true });
      else if (n.type === 'text' && finePointer()) {
        els.edBody.focus({ preventScroll: true });
        const l = els.edBody.value.length;
        els.edBody.setSelectionRange(l, l);
      } else focused = false;
    }
    if (!focused) els.edBack.focus({ preventScroll: true });
  }, 40);
}

function requestCloseEditor() {
  // Çift dokunuşta ikinci history.back() uygulamadan çıkarmasın.
  if (!ed.id || ed.closing || ed.closeRequested) return;
  ed.closeRequested = true;
  if (history.state && history.state.ed) {
    history.back();
    // popstate gelmezse (nadir) yine de kapat.
    const id = ed.id;
    setTimeout(() => { if (ed.id === id && !ed.closing) closeEditorAnimated(); }, 700);
  } else closeEditorAnimated();
}

async function closeEditorAnimated() {
  if (!ed.id || ed.closing) return;
  ed.closing = true;
  flushSave();
  closePopover();
  const id = ed.id;
  let n = store.get(id);
  // gereksiz boş madde satırlarını temizle
  if (n && n.type === 'list' && (n.items || []).some((i) => !i.t.trim()) && (n.items || []).some((i) => i.t.trim())) {
    store.edit(id, { items: n.items.filter((i) => i.t.trim()) });
    n = store.get(id);
  }
  if (n && ed.fresh && isEmptyNote(n)) { store.purge(id); n = null; }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  render();
  const card = ui.cards.get(id);
  let anim = null;
  if (n && n.trashedAt) {
    await fx.crumble(els.ed);
  } else if (card && n) {
    lockScroll(false);
    const r0 = card.getBoundingClientRect();
    if (r0.bottom < 0 || r0.top > window.innerHeight) card.scrollIntoView({ block: 'center' });
    lockScroll(true);
    card.style.visibility = 'hidden';
    anim = fx.morph(els.ed, card.getBoundingClientRect(), { reverse: true, duration: 400 });
  } else {
    anim = fx.morph(els.ed, null, { reverse: true });
  }
  if (els.edBackdrop.animate) els.edBackdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, fill: 'forwards' });
  await fx.done(anim);
  els.editor.hidden = true;
  for (const e of [els.ed, els.edBackdrop, els.edPaper]) e.getAnimations && e.getAnimations().forEach((a) => a.cancel());
  els.ed.style.top = els.ed.style.height = els.ed.style.bottom = '';
  lockScroll(false);
  setBackgroundInert(false);
  if (card) { card.style.visibility = ''; if (n && !n.trashedAt) { fx.land(card); fx.snap(0.8); } }
  restoreFocus();
  if (typeof ed.scrollY === 'number' && Math.abs(window.scrollY - ed.scrollY) > 1) window.scrollTo(0, ed.scrollY);
  ed.id = null;
  ed.closing = false;
  ed.closeRequested = false;
  ed.fresh = false;
}

function trashFromEditor() {
  const id = ed.id;
  if (!id || ed.closing) return;
  const n = store.get(id);
  if (!n) return;
  if (ed.fresh && isEmptyNote(n)) { requestCloseEditor(); return; }
  flushSave();
  store.trash(id);
  toast('Çöpe taşındı', { action: { label: 'Geri al', fn: () => store.restore(id) } });
  requestCloseEditor();
}

function togglePinFromEditor() {
  flushSave();
  const n = store.get(ed.id);
  if (!n) return;
  store.edit(ed.id, { pinned: !n.pinned });
  els.edPin.setAttribute('aria-pressed', String(!n.pinned));
  fx.snap(0.7);
  fx.buzz(8);
  updateEdInfo();
}

/** Başka cihazdan gelen değişikliği açık editöre yansıt (yazmakta olan alanlara dokunma). */
function refreshEditorFromStore() {
  const n = store.get(ed.id);
  if (!n) {
    toast('Bu not başka bir cihazda silindi.');
    requestCloseEditor();
    return;
  }
  if (ed.patch) return;
  const active = document.activeElement;
  if (active !== els.edTitle && els.edTitle.value !== n.title) els.edTitle.value = n.title;
  if (n.type === 'text' && !els.edBody.hidden && active !== els.edBody && els.edBody.value !== n.body) {
    els.edBody.value = n.body;
    autosize(els.edBody);
  }
  if (n.type === 'list' && !els.edList.hidden && !(active && els.edList.contains(active))) {
    if (JSON.stringify(ed.items) !== JSON.stringify(n.items)) {
      ed.items = n.items.map((i) => ({ ...i }));
      if (!ed.items.length) ed.items.push({ id: newItemId(), t: '', d: false });
      renderList();
    }
  }
  els.ed.className = 'ed c-' + colorKey(n.color);
  els.edPin.setAttribute('aria-pressed', String(!!n.pinned));
  updateEdInfo();
}

// ------------------------------------------------------------------ alt sayfa

function openSheet(title, content, kind) {
  els.sheetTitle.textContent = title;
  clear(els.sheetBody).append(content);
  ui.sheetKind = kind;
  if (sheetOpen) return;
  sheetOpen = true;
  rememberFocus();
  setBackgroundInert(true);
  els.sheet.hidden = false;
  lockScroll(true);
  syncViewport();
  setTimeout(() => els.sheetClose.focus({ preventScroll: true }), 40);
  try { history.pushState({ sheet: 1 }, ''); } catch {}
  if (fx.motionOK() && els.sheetPanel.animate) {
    const small = window.matchMedia('(min-width: 700px)').matches;
    els.sheetPanel.animate(
      small
        ? [{ opacity: 0, transform: 'translateY(30px) scale(.95)' }, { opacity: 1, transform: 'none' }]
        : [{ transform: 'translateY(100%)' }, { transform: 'none' }],
      { duration: 380, easing: 'cubic-bezier(.2,.85,.25,1.04)', fill: 'backwards' },
    );
    els.sheetBackdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, fill: 'backwards' });
  }
  fx.snap(0.7);
}

function requestCloseSheet() {
  if (!sheetOpen || ui.sheetCloseRequested) return;
  ui.sheetCloseRequested = true;
  if (history.state && history.state.sheet) {
    history.back();
    setTimeout(() => { if (sheetOpen) closeSheetAnimated(); }, 700);
  } else closeSheetAnimated();
}

async function closeSheetAnimated() {
  if (!sheetOpen) return;
  sheetOpen = false;
  if (fx.motionOK() && els.sheetPanel.animate) {
    const small = window.matchMedia('(min-width: 700px)').matches;
    const a = els.sheetPanel.animate(
      small ? [{ opacity: 1 }, { opacity: 0, transform: 'scale(.96)' }] : [{ transform: 'none' }, { transform: 'translateY(100%)' }],
      { duration: 260, easing: 'ease-in', fill: 'forwards' },
    );
    els.sheetBackdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' });
    await fx.done(a);
  }
  closeSheetNow();
}

function closeSheetNow() {
  if (els.sheet.hidden && !sheetOpen) return;
  sheetOpen = false;
  els.sheet.hidden = true;
  for (const e of [els.sheetPanel, els.sheetBackdrop]) e.getAnimations && e.getAnimations().forEach((a) => a.cancel());
  ui.sheetKind = null;
  ui.sheetCloseRequested = false;
  els.sheet.style.top = els.sheet.style.height = els.sheet.style.bottom = '';
  if (!ed.id) { lockScroll(false); setBackgroundInert(false); restoreFocus(); }
}

// ------------------------------------------------------------------ eşitleme arayüzü

function statusText(s) {
  switch (s.state) {
    case 'off': return 'Eşitleme kapalı';
    case 'syncing': return 'Eşitleniyor…';
    case 'ok': return s.pending ? `${sync.pendingCount()} değişiklik bekliyor` : 'Eşitlendi' + (s.lastSyncAt ? ' · ' + fmtWhen(s.lastSyncAt) : '');
    case 'offline': return 'Çevrimdışı — internet gelince otomatik eşitlenir';
    case 'auth': return s.message || 'Anahtar sorunu — yeniden bağlan';
    case 'error': return s.message || 'Eşitleme hatası';
    default: return s.pending ? `${sync.pendingCount()} değişiklik bekliyor` : 'Hazır';
  }
}

function onSyncStatus(s) {
  let state = s.state;
  if ((state === 'ok' || state === 'idle') && s.pending) state = 'pending';
  const b = els.syncBtn;
  if (b.dataset.state !== state) {
    b.dataset.state = state;
    const name = state === 'offline' ? 'cloudoff' : state === 'syncing' ? 'sync' : state === 'auth' || state === 'error' ? 'warn' : state === 'ok' ? 'cloudok' : 'cloud';
    const holder = b.querySelector('[data-icon]');
    holder.dataset.icon = name;
    clear(holder).append(icon(name));
  }
  b.setAttribute('aria-label', 'Eşitleme: ' + statusText(s));
  if (sheetOpen && ui.sheetKind === 'settings') renderSettings();
  if (ed.id) updateEdInfo();
}

async function manualSync() {
  if (!sync.isConfigured()) { openWizard(); return; }
  if (sync.status.state === 'auth') { openSettings(); return; }
  toast('Eşitleniyor…', { ms: 1200 });
  await sync.syncNow('manual');
  const s = sync.status;
  toast(s.state === 'ok' ? 'Her şey eşitlendi ✓' : statusText(s), { ms: 3200 });
}

// ------------------------------------------------------------------ ayarlar

function section(title, ...children) {
  return h('div', { class: 'card' }, title ? h('h3', null, title) : null, ...children);
}

function seg(options, current, onPick) {
  const wrap = h('div', { class: 'seg', role: 'group' });
  for (const [val, label] of options) {
    wrap.append(h('button', { type: 'button', 'aria-pressed': String(current === val), onclick: () => onPick(val) }, label));
  }
  return wrap;
}

function renderSettings() {
  const scroll = els.sheetBody.scrollTop;
  const fk = els.sheetBody.contains(document.activeElement) ? focusKeyOf(document.activeElement) : null;
  const root = h('div');
  const cfg = sync.config;

  // Eşitleme
  const s = sync.status;
  const syncCard = section('Eşitleme');
  if (!sync.isConfigured()) {
    syncCard.append(
      h('p', null, 'Notlar şu an yalnızca bu cihazda duruyor. Eşitlemeyi kurarsan iPhone, Windows ve Mac\'te aynı notları görürsün.'),
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', type: 'button', onclick: () => openWizard() }, 'Eşitlemeyi kur')),
    );
  } else {
    syncCard.append(
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Depo', h('span', { class: 'sub' }, cfg.repo)), null),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Durum', h('span', { class: 'sub' }, statusText(s))), null),
    );
    if (s.state === 'auth' || s.state === 'error') syncCard.append(h('div', { class: 'note bad' }, s.message || 'Eşitleme sorunu.'));
    syncCard.append(
      h('div', { class: 'btns', style: { marginTop: '10px' } },
        h('button', { class: 'btn primary', type: 'button', onclick: () => manualSync() }, icon('sync', 18), 'Şimdi eşitle'),
        h('button', { class: 'btn', type: 'button', onclick: () => copySetupCode() }, icon('copy', 18), 'Kurulum kodunu kopyala'),
      ),
      h('p', { style: { marginTop: '12px' } }, 'Kurulum kodu, diğer cihazlarında tek yapıştırmayla bağlanmanı sağlar. Anahtarını içerir; yalnızca kendi cihazlarına gönder.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => openWizard('token') }, 'Anahtarı değiştir'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => disconnectSync() }, 'Bağlantıyı kes'),
      ),
    );
  }
  root.append(syncCard);

  // Görünüm
  const look = section('Görünüm');
  look.append(
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Tema'),
      seg([['auto', 'Otomatik'], ['light', 'Açık'], ['dark', 'Koyu']], prefs.scheme, (v) => { prefs.scheme = v; savePrefs(); renderSettings(); })),
  );
  const plates = h('div', { class: 'plates' });
  for (const p of PLATES) {
    plates.append(h('button', {
      type: 'button', class: 'plate-opt', 'aria-label': p.name + ' plaka', 'aria-pressed': String(prefs.plate === p.key),
      style: { background: p.hex }, onclick: () => { prefs.plate = p.key; savePrefs(); renderSettings(); fx.snap(); },
    }, prefs.plate === p.key ? icon('check', 20) : null));
  }
  look.append(
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Yazı boyutu', h('span', { class: 'sub' }, 'Not yazarken')),
      seg([['s', 'Küçük'], ['m', 'Orta'], ['l', 'Büyük']], prefs.textSize, (v) => { prefs.textSize = v; savePrefs(); renderSettings(); })),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Yazı tipi'),
      seg([['round', 'Yuvarlak'], ['system', 'Sade'], ['mono', 'Kod']], prefs.font, (v) => { prefs.font = v; savePrefs(); renderSettings(); })),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Sıralama'),
      seg([['updated', 'Düzenleme'], ['created', 'Oluşturma'], ['title', 'Başlık'], ['color', 'Renk']], prefs.sort, (v) => { prefs.sort = v; savePrefs(); renderSettings(); render(); })),
  );
  look.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Taban plakası', h('span', { class: 'sub' }, 'Tuğlaların oturduğu zemin')), plates));
  look.append(h('div', { class: 'row' },
    h('span', { class: 'lbl' }, 'Klavye kısayolları', h('span', { class: 'sub' }, 'n yeni not, l yeni liste, / ara')),
    h('button', {
      type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(prefs.shortcuts !== false), 'aria-label': 'Klavye kısayolları',
      onclick: () => { prefs.shortcuts = prefs.shortcuts === false; savePrefs(); renderSettings(); },
    })));
  look.append(h('div', { class: 'row' },
    h('span', { class: 'lbl' }, 'Tuk sesi', h('span', { class: 'sub' }, 'Tuğla yerine oturunca hafif bir tık')),
    h('button', {
      type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(prefs.sound), 'aria-label': 'Tuk sesi',
      onclick: () => { prefs.sound = !prefs.sound; savePrefs(); renderSettings(); if (prefs.sound) fx.snap(); },
    })));
  root.append(look);

  // Veri
  const trashCount = store.all().filter((n) => n.trashedAt && !n._purge).length;
  const data = section('Notların');
  data.append(
    h('div', { class: 'btns' },
      h('button', { class: 'btn', type: 'button', onclick: exportNotes }, icon('download', 18), 'Yedek indir'),
      h('button', { class: 'btn', type: 'button', onclick: importNotes }, icon('upload', 18), 'Yedekten yükle'),
    ),
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('span', { class: 'lbl' }, 'Çöp kutusu', h('span', { class: 'sub' }, trashCount ? `${trashCount} not · 30 gün sonra kendiliğinden silinir` : 'Boş')),
      h('button', { class: 'btn', type: 'button', disabled: trashCount ? null : '', onclick: emptyTrash }, 'Boşalt')),
  );
  root.append(data);

  // Hakkında
  const about = section('Hakkında');
  about.append(
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Sürüm'), h('span', null, VERSION)),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Not sayısı'), h('span', null, String(store.all().filter((n) => !n._purge && !n.trashedAt).length))),
  );
  const abtn = h('div', { class: 'btns', style: { marginTop: '8px' } });
  if (installEvent) abtn.append(h('button', { class: 'btn primary', type: 'button', onclick: doInstall }, 'Uygulamayı yükle'));
  abtn.append(h('button', { class: 'btn', type: 'button', onclick: hardRefresh }, 'Uygulamayı yenile'));
  about.append(abtn);
  if (isIOS() && !isStandalone()) {
    about.append(h('div', { class: 'note', style: { marginTop: '12px' } }, 'iPhone\'da uygulama gibi kullanmak için Safari\'de Paylaş düğmesine, sonra "Ana Ekrana Ekle"ye dokun.'));
  }
  root.append(about);

  clear(els.sheetBody).append(root);
  els.sheetBody.scrollTop = scroll;
  refocus(els.sheetBody, fk);
}

function openSettings() {
  openSheet('Ayarlar', h('div'), 'settings');
  renderSettings();
}

async function copyText(text) {
  // Önce eşzamanlı yöntem: dokunma/tıklama hareketinin içinde güvenle çalışır (iOS Safari dahil).
  const ta = h('textarea', { readonly: '', style: { position: 'fixed', opacity: '0', top: '0', left: '0', fontSize: '16px' } });
  ta.value = text;
  document.body.append(ta);
  ta.focus({ preventScroll: true });
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  if (ok) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copySetupCode() {
  const c = sync.config;
  if (!c || !c.token) return;
  const code = encodeSetup({ repo: c.repo, token: c.token });
  const ok = await copyText(code);
  if (ok) toast('Kurulum kodu kopyalandı. Diğer cihazda yapıştır.');
  else window.prompt('Kurulum kodu — kopyala ve diğer cihazda yapıştır:', code);
}

function disconnectSync() {
  if (!window.confirm('Eşitleme bu cihazda durdurulacak. Notların bu cihazda kalır. Devam edilsin mi?')) return;
  sync.disconnect();
  toast('Eşitleme kapatıldı.');
  renderSettings();
}

function emptyTrash() {
  const list = store.all().filter((n) => n.trashedAt && !n._purge);
  if (!list.length) return;
  if (!window.confirm(`Çöpteki ${list.length} not kalıcı olarak silinecek. Emin misin?`)) return;
  for (const n of list) store.purge(n.id);
  toast('Çöp kutusu boşaltıldı.');
  renderSettings();
}

function exportNotes() {
  const notes = store.all().filter((n) => !n._purge).map((n) => {
    const o = {};
    for (const [k, v] of Object.entries(n)) if (!k.startsWith('_')) o[k] = v;
    return o;
  });
  const blob = new Blob([JSON.stringify({ app: 'not-defterim', version: 1, exportedAt: new Date().toISOString(), notes }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `not-defterim-yedek-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast(`${notes.length} not yedeklendi.`);
}

function importNotes() {
  const input = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    input.remove();
    if (!f) return;
    try {
      if (f.size > 10 * 1024 * 1024) throw new Error('big');
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : data.notes;
      if (!Array.isArray(list)) throw new Error('bad');
      let added = 0;
      for (const raw of list.slice(0, 20000)) {
        if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id) || store.get(raw.id)) continue;
        const clean = fromRemote(raw, raw.id);
        if (!clean) continue;
        store.create({ ...clean, color: colorKey(clean.color) });
        added++;
      }
      toast(added ? `${added} not yüklendi.` : 'Yeni not bulunamadı (hepsi zaten var).');
      renderSettings();
    } catch {
      toast('Dosya okunamadı. Geçerli bir yedek dosyası seç.');
    }
  });
  document.body.append(input);
  input.click();
}

async function hardRefresh() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}
  location.reload();
}

async function doInstall() {
  if (!installEvent) return;
  installEvent.prompt();
  try { await installEvent.userChoice; } catch {}
  installEvent = null;
  if (sheetOpen && ui.sheetKind === 'settings') renderSettings();
}

// ------------------------------------------------------------------ kurulum sihirbazı

function openWizard(step) {
  const host = h('div');
  const show = (node, focus = true) => {
    clear(host).append(node);
    if (focus) requestAnimationFrame(() => { const f = host.querySelector('input, button, a'); if (f) f.focus({ preventScroll: true }); });
  };
  const wasOpen = sheetOpen;
  const repoDefault = (sync.config && sync.config.repo) || DEFAULT_REPO;

  const welcome = () =>
    h('div', { class: 'hero' },
      h('img', { src: 'icons/icon.svg', width: '110', height: '110', alt: '' }),
      h('h3', null, 'Notların her cihazda hazır olsun'),
      h('p', null, 'Notlar, kendi özel GitHub deponda saklanır. Böylece iPhone, Windows ve Mac\'te aynı notları görürsün. Kurulum bir kez yapılır, yaklaşık 2 dakika sürer.'),
      h('div', { class: 'stack', style: { marginTop: '16px' } },
        h('button', { class: 'btn primary block', type: 'button', onclick: () => show(tokenStep()) }, 'Eşitlemeyi kur'),
        h('button', { class: 'btn ghost block', type: 'button', onclick: () => { store.setMeta('setupSkipped', true); requestCloseSheet(); } }, 'Şimdilik sadece bu cihazda kullan'),
      ),
    );

  const tokenStep = () => {
    const tokenIn = h('input', { type: 'text', class: 'secret', id: 'w-token', placeholder: 'github_pat_… ya da UNB1.… kurulum kodu', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const repoIn = h('input', { type: 'text', id: 'w-repo', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    repoIn.value = repoDefault;
    const msg = h('div', { role: 'alert' });
    const btn = h('button', { class: 'btn primary block', type: 'button' }, 'Bağlan');
    const go = async () => {
      let token = tokenIn.value.trim();
      let repo = repoIn.value.trim();
      const code = decodeSetup(token);
      if (code) { token = code.token; repo = code.repo; }
      if (!token) { clear(msg).append(h('div', { class: 'note bad' }, 'Önce anahtarı ya da kurulum kodunu yapıştır.')); return; }
      if (!cleanRepo(repo)) { clear(msg).append(h('div', { class: 'note bad' }, 'Depo adı "kullanici/depo" biçiminde olmalı.')); return; }
      const localCount = store.all().filter((x) => !x._purge).length;
      const prevRepo = sync.config && sync.config.repo;
      if (localCount && (!prevRepo || prevRepo.toLowerCase() !== cleanRepo(repo).toLowerCase())) {
        const ok = window.confirm(
          `Bu cihazdaki ${localCount} not "${cleanRepo(repo)}" deposuna gönderilecek. ` +
          'Bu depo sana mı ait? Tanımadığın bir kaynaktan geldiyse "İptal"e bas.',
        );
        if (!ok) return;
      }
      btn.setAttribute('disabled', '');
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = 'Bağlanıyor…';
      clear(msg);
      try {
        await sync.connect({ token, repo });
        show(doneStep());
      } catch (e) {
        clear(msg).append(h('div', { class: 'note bad' }, e && e.message ? e.message : 'Bağlanılamadı.'));
        btn.removeAttribute('disabled');
        btn.removeAttribute('aria-busy');
        btn.textContent = 'Bağlan';
      }
    };
    btn.addEventListener('click', go);
    tokenIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    tokenIn.addEventListener('input', () => {
      const code = decodeSetup(tokenIn.value);
      if (code) { repoIn.value = code.repo; }
    });
    const iosWarn = isIOS() && !isStandalone()
      ? h('div', { class: 'note', style: { marginBottom: '12px' } }, 'iPhone\'da önce Paylaş ▸ "Ana Ekrana Ekle" ile uygulamayı ekle, sonra bu kurulumu Ana Ekran\'daki uygulamadan yap. Safari ve Ana Ekran uygulaması ayrı depolama kullanır.')
      : null;
    return h('div', null,
      iosWarn,
      h('div', { class: 'card' },
        h('h3', null, 'Başka cihazdan kurulum kodun var mı?'),
        h('p', null, 'Varsa aşağıdaki kutuya yapıştır ve Bağlan\'a bas. 1–3. adımları atlayabilirsin.'),
      ),
      h('div', { class: 'card' },
        h('h3', null, 'Anahtar oluştur (bir kez)'),
        h('ol', { class: 'steps' },
          h('li', null, 'GitHub\'da giriş yapmış olarak anahtar sayfasını aç.',
            h('div', { style: { marginTop: '8px' } },
              h('a', { class: 'btn', href: TOKEN_URL, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 18), 'Anahtar sayfasını aç'))),
          h('li', null, 'Şunları doldur:',
            h('table', { class: 'kv' },
              h('tbody', null,
                h('tr', null, h('td', null, 'Token name'), h('td', null, h('b', null, 'Not Defterim'))),
                h('tr', null, h('td', null, 'Expiration'), h('td', null, h('b', null, 'No expiration'), ' (süresiz)')),
                h('tr', null, h('td', null, 'Repository access'), h('td', null, h('b', null, 'Only select repositories'), ' → ', h('code', null, repoDefault))),
                h('tr', null, h('td', null, 'Permissions'), h('td', null, 'Repository permissions → ', h('b', null, 'Contents'), ' → ', h('b', null, 'Read and write')))))),
          h('li', null, 'Sayfanın altındaki ', h('b', null, 'Generate token'), ' düğmesine bas. Çıkan ', h('code', null, 'github_pat_…'), ' kodunu kopyala.'),
          h('li', null, 'Kodu buraya yapıştır:'),
        ),
      ),
      h('div', { class: 'field' }, h('label', { for: 'w-token' }, 'Anahtar ya da kurulum kodu'), tokenIn),
      h('div', { class: 'field' }, h('label', { for: 'w-repo' }, 'Veri deposu (kullanıcı/depo)'), repoIn),
      msg,
      h('div', { style: { marginTop: '12px' } }, btn),
    );
  };

  const doneStep = () => {
    const s = sync.status;
    const ok = s.state === 'ok';
    const n = store.all().filter((x) => !x._purge && !x.trashedAt).length;
    setTimeout(() => fx.confetti({ x: window.innerWidth / 2, y: window.innerHeight / 2.4 }, 30), 150);
    return h('div', { class: 'hero' },
      h('img', { src: 'icons/icon.svg', width: '110', height: '110', alt: '' }),
      h('h3', null, ok ? 'Bağlandı!' : 'Bağlantı kuruldu'),
      h('p', null, ok ? `${n} not eşitlendi. Artık değişiklikler tüm cihazlarında görünecek.` : statusText(s)),
      h('div', { class: 'stack', style: { marginTop: '14px' } },
        h('button', { class: 'btn primary block', type: 'button', onclick: () => requestCloseSheet() }, 'Harika!'),
        h('button', { class: 'btn block', type: 'button', onclick: () => copySetupCode() }, icon('copy', 18), 'Diğer cihazlar için kurulum kodunu kopyala'),
      ),
    );
  };

  show(step === 'token' ? tokenStep() : welcome(), false);
  if (wasOpen && ui.sheetKind === 'settings') {
    // ayarlardan geldiyse aynı sayfada içeriği değiştir
    els.sheetTitle.textContent = 'Eşitleme kurulumu';
    clear(els.sheetBody).append(host);
    ui.sheetKind = 'wizard';
  } else {
    openSheet('Eşitleme kurulumu', host, 'wizard');
  }
}

function maybeFirstRun() {
  if (sync.isConfigured() || store.getMeta('setupSkipped')) return;
  const c = sync.config;
  if (c && c.repo && !c.token) return; // bilerek bağlantıyı kesmiş
  openWizard();
}

function maybeIosHint() {
  if (!isIOS() || isStandalone() || store.getMeta('iosHintSeen')) return;
  const hint = h('div', { class: 'hint', role: 'note' },
    h('p', null, 'iPhone\'da uygulama gibi kullanmak için Safari\'de ', h('b', null, 'Paylaş'), ' düğmesine, sonra ', h('b', null, '"Ana Ekrana Ekle"'), ' seçeneğine dokun.'),
    h('button', { type: 'button', 'aria-label': 'Kapat', onclick: () => { store.setMeta('iosHintSeen', true); hint.remove(); } }, icon('x', 16)),
  );
  document.body.append(hint);
}

// ------------------------------------------------------------------ bağlama

function wire() {
  els.fabNew.addEventListener('click', () => createNote('text'));
  els.fabList.addEventListener('click', () => createNote('list'));
  els.settingsBtn.addEventListener('click', openSettings);
  els.syncBtn.addEventListener('click', manualSync);
  els.sheetClose.addEventListener('click', requestCloseSheet);
  els.sheetBackdrop.addEventListener('click', requestCloseSheet);
  els.edBack.addEventListener('click', requestCloseEditor);
  els.edBackdrop.addEventListener('click', requestCloseEditor);
  els.edPin.addEventListener('click', togglePinFromEditor);
  els.edType.addEventListener('click', convertType);
  els.edColor.addEventListener('click', () => openPopover('color'));
  els.edSize.addEventListener('click', () => openPopover('size'));
  els.edTrash.addEventListener('click', trashFromEditor);
  els.edCopy.addEventListener('click', copyCurrentNote);
  els.edShare.addEventListener('click', shareCurrentNote);
  els.edShare.hidden = !navigator.share;
  els.edDate.addEventListener('click', insertDate);

  els.edTitle.addEventListener('input', () => queueSave({ title: els.edTitle.value }));
  els.edTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const n = store.get(ed.id);
      if (n && n.type === 'list') { const ta = els.edList.querySelector('textarea'); if (ta) ta.focus(); }
      else els.edBody.focus();
    }
  });
  els.edBody.addEventListener('input', () => {
    autosize(els.edBody);
    queueSave({ body: els.edBody.value });
  });
  els.edScroll.addEventListener('pointerdown', (e) => { if (ed.pop && !els.pop.contains(e.target)) closePopover(); });
  document.addEventListener('pointerdown', (e) => {
    if (ed.pop && !els.pop.contains(e.target) && !e.target.closest('#edColor, #edSize')) closePopover();
  });

  // arama
  let qt = 0;
  els.q.addEventListener('input', () => {
    els.qClear.hidden = !els.q.value;
    clearTimeout(qt);
    qt = setTimeout(() => { ui.query = els.q.value; render(); }, 90);
  });
  els.qClear.addEventListener('click', () => {
    els.q.value = '';
    ui.query = '';
    els.qClear.hidden = true;
    render();
    els.q.focus();
  });
  els.searchToggle.addEventListener('click', () => {
    els.top.classList.add('searching');
    els.q.focus();
  });
  els.q.addEventListener('blur', () => {
    if (!els.q.value) els.top.classList.remove('searching');
  });

  // klavye kısayolları
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Escape') {
      if (ed.pop) { closePopover(); return; }
      if (ed.id) { requestCloseEditor(); return; }
      if (sheetOpen) { requestCloseSheet(); return; }
      if (document.activeElement === els.q) { els.q.value = ''; ui.query = ''; els.qClear.hidden = true; els.q.blur(); render(); }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || ed.id || sheetOpen || prefs.shortcuts === false) return;
    if (e.key === 'n') { e.preventDefault(); createNote('text'); }
    else if (e.key === 'l') { e.preventDefault(); createNote('list'); }
    else if (e.key === '/') { e.preventDefault(); els.top.classList.add('searching'); els.q.focus(); }
  });
  document.addEventListener('keydown', (e) => {
    if (ed.id && (e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); requestCloseEditor(); }
  });
  document.addEventListener('keydown', trapTab);

  window.addEventListener('popstate', () => {
    if (ed.id) closeEditorAnimated();
    else if (sheetOpen) closeSheetAnimated();
  });
  const vv = window.visualViewport;
  if (vv) { vv.addEventListener('resize', syncViewport); vv.addEventListener('scroll', syncViewport); }
  window.addEventListener('resize', syncViewport);

  const flush = () => { flushSave(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', flush);

  if ('ResizeObserver' in window) new ResizeObserver(() => { if (layoutGrid()) scheduleRender(); }).observe(els.board);
  else window.addEventListener('resize', () => { if (layoutGrid()) scheduleRender(); });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (prefs.scheme === 'auto') applyPrefs(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
  window.addEventListener('appinstalled', () => { installEvent = null; });
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had) return;
    toast('Yeni sürüm hazır.', { ms: 12000, action: { label: 'Yenile', fn: () => location.reload() } });
  });
}

// ------------------------------------------------------------------ başlat

/** Kısayollardan (?new=text|list) ve "Paylaş" hedefinden (?title&text&url) gelen istekler. */
function handleLaunchParams() {
  let q;
  try { q = new URLSearchParams(location.search); } catch { return; }
  const kind = q.get('new');
  const shared = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join('\n');
  if (!kind && !shared) return;
  try { history.replaceState(null, '', location.pathname); } catch {}
  if (shared) {
    const title = (q.get('title') || '').slice(0, 200);
    const body = [q.get('text'), q.get('url')].filter(Boolean).join('\n').slice(0, 20000);
    // Dışarıdan gelen içerik kendiliğinden not olmaz; kullanıcı onaylar.
    setTimeout(() => {
      toast('Paylaşılan içerik var: not olarak eklensin mi?', {
        ms: 15000,
        action: {
          label: 'Ekle',
          fn: () => {
            const n = store.create({ title, body, color: colorKey(store.getMeta('lastColor', 'yellow')) });
            ui.quiet.add(n.id);
            render();
          },
        },
      });
    }, 600);
  } else if (kind === 'text' || kind === 'list') {
    setTimeout(() => createNote(kind), 250);
  }
}

async function boot() {
  for (const id of ['top', 'boardWrap', 'fabs', 'edCopy', 'edShare', 'edDate', 'q', 'qClear', 'searchToggle', 'syncBtn', 'settingsBtn', 'chips', 'board', 'grid', 'empty', 'emptyTitle', 'emptyText',
    'fabNew', 'fabList', 'editor', 'edBackdrop', 'ed', 'edStuds', 'edBack', 'edPin', 'edType', 'edColor', 'edSize', 'edTrash', 'edPaper',
    'edScroll', 'edTitle', 'edBody', 'edList', 'edInfo', 'pop', 'sheet', 'sheetBackdrop', 'sheetPanel', 'sheetTitle', 'sheetClose', 'sheetBody', 'toasts']) {
    els[id] = $(id);
  }
  fillIcons();
  injectPaletteCss();

  const backend = await openBestBackend();
  store = await new Store(backend).open();
  prefs = { ...prefs, ...store.getMeta('prefs', {}) };
  applyPrefs();

  let lastPersistToast = 0;
  store.onPersistError = () => {
    if (Date.now() - lastPersistToast < 20000) return;
    lastPersistToast = Date.now();
    toast('Not bu cihaza kaydedilemedi. Depolama dolu ya da kapalı olabilir; yedek indirmeyi dene.', { ms: 9000 });
  };
  // Geliştirme: yalnızca yerel adreslerde sahte GitHub'a yönlendirme yapılabilir.
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  sync = new SyncEngine(store, { apiBase: (() => { try { return (localHost && localStorage.getItem('unb_api')) || undefined; } catch { return undefined; } })() });
  buildChips();
  wire();
  layoutGrid();
  render();
  store.on((ev) => {
    scheduleRender();
    if (ed.id && ev.origin === 'sync' && ev.ids.includes(ed.id)) refreshEditorFromStore();
    if (sheetOpen && ui.sheetKind === 'settings') renderSettings();
  });
  sync.onStatus(onSyncStatus);
  onSyncStatus(sync.status);
  try { history.replaceState(null, ''); } catch {}
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
  sync.start();
  registerSW();
  handleLaunchParams();
  setTimeout(() => { maybeFirstRun(); maybeIosHint(); }, 700);

  if (localHost) window.__unb = { store, sync, render, VERSION }; // hata ayıklama: yalnızca yerel geliştirmede
}

boot().catch((e) => {
  console.error(e);
  const p = document.createElement('p');
  p.style.cssText = 'padding:24px;font-family:sans-serif';
  p.textContent = 'Uygulama başlatılamadı: ' + (e && e.message ? e.message : e) + ' — sayfayı yenilemeyi dene.';
  document.body.prepend(p);
});
