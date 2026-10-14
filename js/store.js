// Yerel not deposu: bellekte önbellek (anlık okuma) + IndexedDB kalıcılığı (sıralı yazma).
// Tarayıcıya özel hiçbir şey import etmez; Node testlerinde MemoryBackend ile çalışır.

export const SIZES = ['2x2', '2x3', '4x2', '4x3'];
export const TRASH_DAYS = 30;

let _idCounter = 0;
export function newId() {
  _idCounter = (_idCounter + 1) % 1296;
  return 'n' + Date.now().toString(36) + _idCounter.toString(36).padStart(2, '0') +
    Math.random().toString(36).slice(2, 6);
}

export function newItemId() {
  return 'i' + Math.random().toString(36).slice(2, 8);
}

/** Boş (yeni) not. _ ile başlayan alanlar yalnızca bu cihazda tutulur, uzağa gitmez. */
export function makeNote(partial = {}) {
  const now = Date.now();
  return {
    id: newId(),
    type: 'text',            // 'text' | 'list'
    title: '',
    body: '',
    items: [],               // liste notları: [{id, t, d}]
    color: 'yellow',
    size: 'auto',            // 'auto' | '2x2' | '2x3' | '4x2' | '4x3'
    pinned: false,
    createdAt: now,
    updatedAt: now,
    trashedAt: null,
    _sha: null,              // uzaktaki dosyanın blob sha'sı
    _dirty: true,            // uzağa gönderilmeyi bekliyor
    _rev: 1,                 // her yerel düzenlemede artar
    _purge: false,           // kalıcı silinecek
    _syncedAt: 0,
    ...partial,
  };
}

/** Uzağa giden içerik (yalnızca not içeriği). */
export function toRemote(n) {
  return {
    v: 1,
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    items: n.items,
    color: n.color,
    size: n.size,
    pinned: !!n.pinned,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    trashedAt: n.trashedAt ?? null,
  };
}

/** Uzaktan gelen JSON'u güvenli bir nota çevirir. Geçersizse null. */
export function fromRemote(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.deleted === true) return null;
  const type = raw.type === 'list' ? 'list' : 'text';
  const items = Array.isArray(raw.items)
    ? raw.items
        .slice(0, 2000)
        .filter((i) => i && typeof i === 'object')
        .map((i) => ({ id: String(i.id || newItemId()).slice(0, 40), t: String(i.t ?? '').slice(0, 2000), d: !!i.d }))
    : [];
  const size = raw.size === 'auto' || SIZES.includes(raw.size) ? raw.size : 'auto';
  const num = (v, d) => (typeof v === 'number' && isFinite(v) && Math.abs(v) <= 8.64e15 ? v : d);
  return {
    id,
    type,
    title: String(raw.title ?? '').slice(0, 500),
    body: String(raw.body ?? '').slice(0, 300000),
    items,
    color: String(raw.color || 'yellow'),
    size,
    pinned: !!raw.pinned,
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
    trashedAt: raw.trashedAt == null ? null : num(raw.trashedAt, Date.now()),
  };
}

export function sameContent(a, b) {
  return (
    a.type === b.type &&
    a.title === b.title &&
    a.body === b.body &&
    a.color === b.color &&
    a.size === b.size &&
    !!a.pinned === !!b.pinned &&
    (a.trashedAt ?? null) === (b.trashedAt ?? null) &&
    JSON.stringify(a.items || []) === JSON.stringify(b.items || [])
  );
}

/** Arama için: küçük harf + Türkçe karakterleri sadeleştir (ı→i, ş→s ...). */
export function fold(s) {
  return String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

export function noteSearchText(n) {
  const parts = [n.title, n.body];
  if (n.items) for (const i of n.items) parts.push(i.t);
  return fold(parts.join('\n'));
}

// ---------------------------------------------------------------- depolar

export class MemoryBackend {
  constructor() {
    this.notes = new Map();
    this.meta = new Map();
  }
  async load() {
    return { notes: [...this.notes.values()].map((n) => structuredClone(n)), meta: Object.fromEntries(this.meta) };
  }
  async putNote(n) { this.notes.set(n.id, structuredClone(n)); }
  async deleteNote(id) { this.notes.delete(id); }
  async setMeta(k, v) { this.meta.set(k, structuredClone(v)); }
  async getNote(id) { return this.notes.has(id) ? structuredClone(this.notes.get(id)) : undefined; }
  async getMeta(k) { return this.meta.has(k) ? structuredClone(this.meta.get(k)) : undefined; }
}

export class IdbBackend {
  constructor(name = 'unicornlu-notes') {
    this.name = name;
    this.db = null;
  }
  async _open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB açılamadı'));
      req.onblocked = () => reject(new Error('IndexedDB engellendi'));
    });
    this.db.onversionchange = () => { try { this.db.close(); } catch {} this.db = null; };
    return this.db;
  }
  _tx(storeName, mode, fn) {
    return this._open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          const st = tx.objectStore(storeName);
          let result;
          try { result = fn(st); } catch (e) { reject(e); return; }
          tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('IndexedDB işlemi iptal edildi'));
        }),
    );
  }
  async load() {
    const db = await this._open();
    const readAll = (storeName) =>
      new Promise((resolve, reject) => {
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const [notes, metaRows] = await Promise.all([readAll('notes'), readAll('meta')]);
    const meta = {};
    for (const r of metaRows) meta[r.k] = r.v;
    return { notes, meta };
  }
  putNote(n) { return this._tx('notes', 'readwrite', (st) => st.put(n)); }
  deleteNote(id) { return this._tx('notes', 'readwrite', (st) => st.delete(id)); }
  setMeta(k, v) { return this._tx('meta', 'readwrite', (st) => st.put({ k, v })); }
  async getNote(id) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('notes', 'readonly').objectStore('notes').get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async getMeta(k) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('meta', 'readonly').objectStore('meta').get(k);
      req.onsuccess = () => resolve(req.result ? req.result.v : undefined);
      req.onerror = () => reject(req.error);
    });
  }
}

/** IndexedDB kullanılamazsa (nadiren) yedek: localStorage. */
export class LocalStorageBackend {
  constructor(prefix = 'unb:') { this.p = prefix; }
  async load() {
    const notes = [];
    const meta = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(this.p)) continue;
      try {
        const val = JSON.parse(localStorage.getItem(key));
        if (key.startsWith(this.p + 'n:')) notes.push(val);
        else if (key.startsWith(this.p + 'm:')) meta[key.slice(this.p.length + 2)] = val;
      } catch {}
    }
    return { notes, meta };
  }
  async putNote(n) { localStorage.setItem(this.p + 'n:' + n.id, JSON.stringify(n)); }
  async deleteNote(id) { localStorage.removeItem(this.p + 'n:' + id); }
  async setMeta(k, v) { localStorage.setItem(this.p + 'm:' + k, JSON.stringify(v)); }
  async getNote(id) {
    try { return JSON.parse(localStorage.getItem(this.p + 'n:' + id)) || undefined; } catch { return undefined; }
  }
  async getMeta(k) {
    try { const v = localStorage.getItem(this.p + 'm:' + k); return v === null ? undefined : JSON.parse(v); } catch { return undefined; }
  }
}

export async function openBestBackend() {
  try {
    if (typeof indexedDB !== 'undefined') {
      const b = new IdbBackend();
      await b._open();
      return b;
    }
  } catch {}
  try {
    localStorage.setItem('unb:probe', '1');
    localStorage.removeItem('unb:probe');
    return new LocalStorageBackend();
  } catch {}
  return new MemoryBackend();
}

// ---------------------------------------------------------------- store

export class Store {
  constructor(backend, { channel = true } = {}) {
    this.backend = backend;
    this.notes = new Map();
    this.meta = {};
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.persistError = null;
    this.tabId = Math.random().toString(36).slice(2);
    this.bc = null;
    // Aynı cihazda birden çok sekme/pencere açıksa birbirlerinin yazdığını görsünler.
    if (channel && typeof BroadcastChannel !== 'undefined') {
      try {
        this.bc = new BroadcastChannel('unicornlu-notes');
        this.bc.onmessage = (e) => this._onTabMessage(e.data);
        if (typeof this.bc.unref === 'function') this.bc.unref(); // Node: süreci açık tutma
      } catch { this.bc = null; }
    }
  }

  async _onTabMessage(m) {
    if (!m || m.from === this.tabId) return;
    try {
      if (m.t === 'note') {
        const n = await this.backend.getNote(m.id);
        if (n) this.notes.set(m.id, { ...makeNote(), ...n, items: Array.isArray(n.items) ? n.items : [] });
        else this.notes.delete(m.id);
        this._emit({ ids: [m.id], origin: 'tab' });
      } else if (m.t === 'meta') {
        const v = await this.backend.getMeta(m.k);
        if (v === undefined) delete this.meta[m.k];
        else this.meta[m.k] = v;
        this._emit({ ids: [], origin: 'tab', meta: m.k });
      }
    } catch (e) { console.error(e); }
  }

  _announce(msg) {
    if (this.bc) { try { this.bc.postMessage({ ...msg, from: this.tabId }); } catch {} }
  }

  async open() {
    const { notes, meta } = await this.backend.load();
    this.notes = new Map();
    for (const n of notes) {
      if (n && n.id) this.notes.set(n.id, { ...makeNote(), ...n, items: Array.isArray(n.items) ? n.items : [] });
    }
    this.meta = meta || {};
    return this;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(ev) { for (const fn of this.listeners) { try { fn(ev); } catch (e) { console.error(e); } } }

  _persist(job, msg) {
    this.queue = this.queue
      .then(job)
      .then(() => { if (msg) this._announce(msg); })
      .catch((e) => {
        this.persistError = e;
        console.error('Kayıt hatası', e);
        if (typeof this.onPersistError === 'function') { try { this.onPersistError(e); } catch {} }
      });
  }
  flush() { return this.queue; }

  all() { return [...this.notes.values()]; }
  get(id) { return this.notes.get(id); }

  /**
   * Tek giriş noktası: fn(kopya) -> yeni not | null (sil) | undefined (değişiklik yok).
   * origin: 'local' (kullanıcı) | 'sync' (eşitleme motoru).
   */
  mutate(id, fn, { origin = 'local' } = {}) {
    const cur = this.notes.get(id);
    const copy = cur ? { ...cur, items: (cur.items || []).map((i) => ({ ...i })) } : undefined;
    const next = fn(copy);
    if (next === undefined) return cur;
    if (next === null) {
      if (!cur) return undefined;
      this.notes.delete(id);
      this._persist(() => this.backend.deleteNote(id), { t: 'note', id });
    } else {
      this.notes.set(id, next);
      this._persist(() => this.backend.putNote(next), { t: 'note', id });
    }
    this._emit({ ids: [id], origin });
    return next;
  }

  /** Kullanıcı düzenlemesi: alanları uygular, işaretler. Not yoksa oluşturmaz. */
  edit(id, patch) {
    return this.mutate(id, (n) => {
      if (!n) return undefined;
      const p = typeof patch === 'function' ? patch(n) : patch;
      return { ...n, ...p, updatedAt: Date.now(), _dirty: true, _rev: (n._rev || 0) + 1 };
    });
  }

  create(partial = {}) {
    const n = makeNote(partial);
    this.mutate(n.id, () => n);
    return n;
  }

  /** Çöpe at / çöpten çıkar. */
  trash(id) { return this.edit(id, { trashedAt: Date.now(), pinned: false }); }
  restore(id) { return this.edit(id, { trashedAt: null }); }

  /** Kalıcı sil: uzakta dosya varsa silinmek üzere işaretle, yoksa hemen kaldır. */
  purge(id) {
    return this.mutate(id, (n) => {
      if (!n) return undefined;
      if (!n._sha) return null;
      return { ...n, _purge: true, _dirty: true, _rev: (n._rev || 0) + 1 };
    });
  }

  purgeExpired(days = TRASH_DAYS) {
    const limit = Date.now() - days * 86400000;
    for (const n of this.all()) if (n.trashedAt && n.trashedAt < limit && !n._purge) this.purge(n.id);
  }

  getMeta(k, def) { return k in this.meta ? this.meta[k] : def; }
  setMeta(k, v) {
    this.meta[k] = v;
    this._persist(() => this.backend.setMeta(k, v), { t: 'meta', k });
  }
}
