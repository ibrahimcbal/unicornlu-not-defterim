// GitHub tabanlı eşitleme motoru.
// Her not, özel veri deposunda notes/<id>.json dosyasıdır. Hiçbir not sessizce ezilmez:
// iki cihaz aynı notu aynı anda değiştirirse ikisi de saklanır ("çakışma kopyası").
// Tarayıcıya özel API'ler yalnızca start() içinde kullanılır; Node testlerinde çalışır.

import { makeNote, newId, toRemote, fromRemote, sameContent, sameLayout, snapshot, LAYOUT_KEYS } from './store.js';

const NOTE_RE = /^notes\/([A-Za-z0-9_-]+)\.json$/;
const RECENT_MS = 90_000;      // yeni yazılan notun "uzakta yok" sanılmasını önler
const REQUEST_TIMEOUT = 25_000;

export class SyncError extends Error {
  constructor(kind, message, status = 0, extra = {}) {
    super(message);
    this.kind = kind; // network | auth | forbidden | ratelimit | notfound | empty | conflict | server | error
    this.status = status;
    Object.assign(this, extra);
  }
}

export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Diğer cihazlara taşımak için tek parça kurulum kodu. */
export function encodeSetup({ repo, token }) {
  return 'UNB1.' + b64encode(JSON.stringify({ r: repo, t: token })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSetup(text) {
  const m = /UNB1\.([A-Za-z0-9_-]+)/.exec(String(text || ''));
  if (!m) return null;
  try {
    let s = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const o = JSON.parse(b64decode(s));
    if (o && typeof o.r === 'string' && typeof o.t === 'string') return { repo: o.r, token: o.t };
  } catch {}
  return null;
}

export function cleanRepo(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(s) ? s : '';
}

// Commit mesajlarına not başlığı yazılmaz: depo geçmişinde içerik ipucu kalmasın.
const MAX_BLOB = 2_000_000;

export class SyncEngine {
  constructor(store, opts = {}) {
    this.store = store;
    this.fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    this.apiBase = opts.apiBase || 'https://api.github.com';
    this.now = opts.now || (() => Date.now());
    this.debounceMs = opts.debounceMs ?? 2500;
    this.maxWaitMs = opts.maxWaitMs ?? 15000;
    this.pollMs = opts.pollMs ?? 30000;
    this.concurrency = opts.concurrency ?? 6;
    this.listeners = new Set();
    this.status = { state: 'off', message: '', lastSyncAt: this.store.getMeta('lastSyncAt', 0), pending: false };
    this._running = null;
    this._again = false;
    this._timer = null;
    this._retryTimer = null;
    this._firstPending = 0;
    this._failures = 0;
    this._started = false;
    this._unsub = this.store.on((ev) => {
      if (ev.origin === 'local' && this.isConfigured()) this.schedule();
    });
    if (!this.isConfigured()) this._set({ state: 'off' });
    else this._set({ state: 'idle' });
  }

  // ---- durum

  onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _set(patch) {
    this.status = { ...this.status, ...patch };
    for (const fn of this.listeners) { try { fn(this.status); } catch (e) { console.error(e); } }
  }
  get config() { return this.store.getMeta('sync', null); }
  isConfigured() { const c = this.config; return !!(c && c.token && c.repo); }
  pendingCount() { return this.store.all().filter((n) => n._dirty || n._purge).length; }

  // ---- kurulum

  /** Bağlantıyı doğrular (kaydetmez). Sorun varsa SyncError fırlatır. */
  async verify({ token, repo }) {
    const cfg = { token: String(token || '').trim(), repo: cleanRepo(repo) };
    if (!cfg.token) throw new SyncError('error', 'Anahtar boş görünüyor.');
    if (!cfg.repo) throw new SyncError('error', 'Depo adı "kullanici/depo" biçiminde olmalı.');
    let r;
    try {
      r = await this._gh(cfg, `/repos/${cfg.repo}`);
    } catch (e) {
      if (e.kind === 'notfound') throw new SyncError('notfound', 'Depo bulunamadı ya da bu anahtarın o depoya erişimi yok. Anahtarı oluştururken doğru depoyu seçtiğinden emin ol.', 404);
      throw e;
    }
    const d = r.data || {};
    if (d.permissions && d.permissions.push === false) {
      throw new SyncError('forbidden', 'Anahtar bu depoyu okuyabiliyor ama yazamıyor. "Contents: Read and write" iznini ver.', 403);
    }
    return { repo: d.full_name || cfg.repo, branch: d.default_branch || 'main', private: !!d.private };
  }

  async connect({ token, repo }) {
    const info = await this.verify({ token, repo });
    const prev = this.config;
    const next = { token: String(token).trim(), repo: info.repo, branch: info.branch };
    if (prev && prev.repo && prev.repo.toLowerCase() !== next.repo.toLowerCase()) {
      // Farklı depoya geçiş: her şeyi yeni depoya yükle.
      for (const n of this.store.all()) {
        this.store.mutate(n.id, (c) => (c ? { ...c, _sha: null, _dirty: !c._purge, _syncedAt: 0 } : undefined), { origin: 'sync' });
      }
      this.store.setMeta('treeEtag', null);
    }
    this.store.setMeta('sync', next);
    this._failures = 0;
    this._set({ state: 'idle', message: '' });
    return this.syncNow('connect');
  }

  disconnect() {
    clearTimeout(this._timer);
    clearTimeout(this._retryTimer);
    const c = this.config;
    if (c) this.store.setMeta('sync', { ...c, token: '' });
    this._set({ state: 'off', message: '', pending: false });
  }

  // ---- zamanlama

  start() {
    if (this._started || typeof document === 'undefined') return;
    this._started = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.syncNow('visible');
      else if (this.pendingCount()) this.syncNow('hidden');
    });
    window.addEventListener('online', () => this.syncNow('online'));
    window.addEventListener('pagehide', () => { if (this.pendingCount()) this.syncNow('pagehide'); });
    this._poll = setInterval(() => {
      if (!document.hidden && navigator.onLine !== false) this.syncNow('poll');
    }, this.pollMs);
    if (this.isConfigured()) this.syncNow('start');
  }

  /** Yerel değişiklikten sonra: kısa bekle, ama en fazla maxWaitMs ertele. */
  schedule(delay = this.debounceMs) {
    if (!this.isConfigured()) return;
    const t = this.now();
    if (!this._firstPending) this._firstPending = t;
    clearTimeout(this._timer);
    const d = Math.max(0, Math.min(delay, this.maxWaitMs - (t - this._firstPending)));
    this._timer = setTimeout(() => {
      this._firstPending = 0;
      this.syncNow('edit');
    }, d);
    if (!this.status.pending) this._set({ pending: true });
  }

  syncNow(reason = 'manual') {
    if (!this.isConfigured()) { this._set({ state: 'off' }); return Promise.resolve(); }
    if (this._running) { this._again = true; return this._running; }
    this._running = (async () => {
      try {
        let rounds = 0;
        do {
          this._again = false;
          await this._cycleSafe(reason);
          rounds++;
        } while (this._again && rounds < 3);
      } finally {
        this._running = null;
      }
    })();
    return this._running;
  }

  async _cycleSafe(reason) {
    clearTimeout(this._retryTimer);
    this._set({ state: 'syncing', message: '' });
    try {
      await this._cycle(reason);
      this._failures = 0;
      const t = this.now();
      this.store.setMeta('lastSyncAt', t);
      this._set({ state: 'ok', message: '', lastSyncAt: t, pending: this.pendingCount() > 0 });
    } catch (e) {
      const err = e instanceof SyncError ? e : new SyncError('error', String(e && e.message ? e.message : e));
      if (!(e instanceof SyncError)) console.error(e);
      this._failures++;
      const pending = this.pendingCount() > 0;
      if (err.kind === 'network') {
        this._set({ state: 'offline', message: err.message, pending });
        this._retry(Math.min(60_000, 4000 * 2 ** Math.min(this._failures, 4)));
      } else if (err.kind === 'ratelimit') {
        const wait = Math.max(30_000, (err.retryAt || 0) - this.now());
        this._set({ state: 'error', message: 'GitHub kısa süre bekletiyor, birazdan otomatik denenecek.', pending });
        this._retry(Math.min(wait, 15 * 60_000));
      } else if (err.kind === 'auth' || err.kind === 'forbidden') {
        this._set({ state: 'auth', message: err.message, pending });
      } else if (err.kind === 'server') {
        this._set({ state: 'error', message: 'GitHub şu an yanıt vermiyor, tekrar denenecek.', pending });
        this._retry(Math.min(120_000, 8000 * 2 ** Math.min(this._failures, 4)));
      } else {
        this._set({ state: 'error', message: err.message, pending });
        this._retry(Math.min(300_000, 15_000 * 2 ** Math.min(this._failures, 4)));
      }
    }
  }

  _retry(ms) {
    clearTimeout(this._retryTimer);
    if (typeof setTimeout === 'undefined') return;
    this._retryTimer = setTimeout(() => this.syncNow('retry'), ms);
  }

  // ---- ana döngü

  async _cycle() {
    const cfg = this.config;
    if (!cfg || !cfg.token || !cfg.repo) return;
    const repo = `/repos/${cfg.repo}`;

    if (!cfg.branch) {
      const info = await this._gh(cfg, repo);
      cfg.branch = (info.data && info.data.default_branch) || 'main';
      this.store.setMeta('sync', { ...cfg });
    }

    // 1) Uzaktaki dosya listesi (tek istek; değişmediyse 304)
    const etagInfo = this.store.getMeta('treeEtag', null);
    const prevEtag = etagInfo && etagInfo.repo === cfg.repo && etagInfo.branch === cfg.branch ? etagInfo.etag : null;
    let tree = null;
    try {
      const r = await this._gh(cfg, `${repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`, { etag: prevEtag });
      if (r.status !== 304) tree = r;
    } catch (e) {
      if (e.kind === 'empty') {
        tree = { data: { tree: [], truncated: false }, etag: null }; // henüz hiç commit yok
      } else if (e.kind === 'notfound') {
        const info = await this._gh(cfg, repo); // depo erişilemezse burada hata fırlar
        const def = info.data && info.data.default_branch;
        if (def && def !== cfg.branch) {
          this.store.setMeta('sync', { ...cfg, branch: def });
          this._again = true;
          return;
        }
        throw new SyncError('error', `"${cfg.branch}" dalı depoda bulunamadı.`, 404);
      } else {
        throw e;
      }
    }

    // 2) Uzaktan çek
    if (tree) {
      const remote = new Map();
      for (const it of (tree.data && tree.data.tree) || []) {
        if (it.type !== 'blob') continue;
        const m = NOTE_RE.exec(it.path);
        if (m) remote.set(m[1], it.sha);
      }
      const deferred = await this._pull(cfg, remote, !!(tree.data && tree.data.truncated));
      // Bir şey ertelendiyse etag kaydetme: bir sonraki tur listeyi yeniden okusun.
      this.store.setMeta('treeEtag', tree.etag && !deferred ? { repo: cfg.repo, branch: cfg.branch, etag: tree.etag } : null);
    }

    // 3) Yerel değişiklikleri gönder
    await this._push(cfg);

    // 4) Süresi dolan çöp notları temizle (bir sonraki turda gönderilir)
    this.store.purgeExpired();
  }

  /** Dönüş: bir şey sonraya ertelendi mi (true ise etag saklanmaz). */
  async _pull(cfg, remote, truncated) {
    const repo = `/repos/${cfg.repo}`;
    const tombs = this.store.getMeta('tombs', {});
    const toFetch = [];
    for (const [id, sha] of remote) {
      const l = this.store.get(id);
      if (l && l._sha === sha) continue;
      if (!l && tombs[id] === sha) continue; // bilinen silinmiş not
      toFetch.push({ id, sha });
    }

    await this._pool(toFetch, this.concurrency, async ({ id, sha }) => {
      const r = await this._gh(cfg, `${repo}/git/blobs/${sha}`);
      if (r.data && r.data.size > MAX_BLOB) return; // aşırı büyük dosyayı atla
      let data = null;
      try { data = JSON.parse(b64decode(r.data.content)); } catch {}
      this._applyBlob(id, sha, data);
    });

    if (truncated) return false; // liste eksik olabilir: kayıp tespiti yapma

    // Daha önce eşitlenmiş ama uzakta görünmeyen notlar. Silmeler "silindi işareti"
    // (tombstone) ile yapıldığı için dosyanın kaybolması normal değildir: yerelden geri yükle.
    const t = this.now();
    let deferred = false;
    for (const n of this.store.all()) {
      if (!n._sha || remote.has(n.id)) continue;
      if (n._purge) { this.store.mutate(n.id, () => null, { origin: 'sync' }); continue; }
      if (t - (n._syncedAt || 0) < RECENT_MS) { deferred = true; continue; }
      this.store.mutate(n.id, (c) => (c ? { ...c, _sha: null, _dirty: true } : undefined), { origin: 'sync' });
    }
    return deferred;
  }

  _markTomb(id, sha) {
    const tombs = { ...this.store.getMeta('tombs', {}) };
    if (tombs[id] === sha) return;
    tombs[id] = sha;
    this.store.setMeta('tombs', tombs);
  }

  /** Uzaktan gelen bir dosyayı (not ya da silindi işareti) yerel duruma uygular. */
  _applyBlob(id, sha, data) {
    if (data && typeof data === 'object' && !Array.isArray(data) && data.deleted === true) {
      const cur = this.store.get(id);
      if (cur && cur._dirty && !cur._purge && !cur.trashedAt) {
        // Bu cihazda henüz gönderilmemiş bir düzenleme var: sessizce kaybetme, notu geri getir
        // (silindi işaretinin üstüne yaz). Çöpteki not ise zaten silinmek isteniyordur.
        this.store.mutate(id, (c) => (c ? { ...c, _sha: sha } : undefined), { origin: 'sync' });
        return;
      }
      if (cur) this.store.mutate(id, () => null, { origin: 'sync' });
      this._markTomb(id, sha);
      return;
    }
    this._applyRemote(id, sha, data);
  }

  /** Uzaktan gelen sürümü yerel notla birleştirir; veri kaybetmez. */
  _applyRemote(id, sha, data) {
    const incoming = fromRemote(data, id);
    if (!incoming) {
      // Uzaktaki dosya bozuk: yerel kopya varsa onunla onarılır (üzerine yazılır).
      this.store.mutate(
        id,
        (c) => (c ? (c._purge ? { ...c, _sha: sha } : { ...c, _sha: sha, _dirty: true }) : undefined),
        { origin: 'sync' },
      );
      return;
    }
    const t = this.now();
    let copy = null;
    this.store.mutate(
      id,
      (cur) => {
        const snap = snapshot(incoming);
        if (!cur) return { ...makeNote(), ...incoming, _sha: sha, _dirty: false, _rev: 0, _purge: false, _syncedAt: t, _base: snap };
        if (cur._purge) {
          // Başka cihaz notu geri yüklemiş/düzenlemiş (çöpte değil): silmeyi bırak, sessizce ezme.
          if (!incoming.trashedAt) return { ...cur, ...incoming, _purge: false, _sha: sha, _dirty: false, _syncedAt: t, _base: snap };
          return { ...cur, _sha: sha };
        }
        if (!cur._dirty) return { ...cur, ...incoming, _sha: sha, _dirty: false, _syncedAt: t, _base: snap };

        // Bu cihazda gönderilmemiş değişiklik var: üç yönlü birleştir (temel = son eşitlenen sürüm).
        const base = cur._base;
        const localContentChanged = !base || !sameContent(cur, base);
        const remoteContentChanged = !base || !sameContent(incoming, base);
        const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const RK = ['remindAt', 'remindFired', 'remindRepeat', 'remindBase'];
        const mergeLayout = () => {
          const out = {};
          for (const k of LAYOUT_KEYS) {
            if (RK.includes(k)) continue;
            const localChanged = base ? !eq(cur[k], base[k]) : true;
            out[k] = localChanged ? cur[k] : incoming[k];
          }
          // Hatırlatıcı alanları tek bütündür: parça parça birleştirilmez.
          const lc = base ? RK.some((k) => !eq(cur[k], base[k])) : true;
          const rc = base ? RK.some((k) => !eq(incoming[k], base[k])) : false;
          let src = incoming;
          if (lc && !rc) src = cur;
          else if (lc && rc) src = cur.remindFired && !incoming.remindFired ? incoming : cur; // kurulu olan kazanır
          for (const k of RK) out[k] = src[k];
          return out;
        };
        const finish = (content, updatedAt) => {
          const merged = { ...cur, ...content, ...mergeLayout(), updatedAt, _sha: sha, _base: snap, _syncedAt: t };
          // Uzaktakiyle birebir aynıysa temiz, değilse bu cihazdaki fark gönderilecek.
          merged._dirty = !(sameContent(merged, incoming) && sameLayout(merged, incoming));
          return merged;
        };
        if (sameContent(cur, incoming) || (base && !remoteContentChanged)) {
          // İçerik uzakta değişmemiş (ya da aynı): yerel içerik kalır, düzen alan alan birleşir.
          const same = sameContent(cur, incoming);
          return finish({}, same ? Math.max(cur.updatedAt || 0, incoming.updatedAt || 0) : cur.updatedAt || 0);
        }
        if (base && !localContentChanged) {
          // İçerik yalnızca uzakta değişmiş: uzak içeriği al, yerel düzen değişiklikleri korunur.
          const content = {};
          for (const k of ['type', 'title', 'body', 'items', 'trashedAt']) content[k] = incoming[k];
          return finish(content, Math.max(cur.updatedAt || 0, incoming.updatedAt || 0));
        }
        // Gerçek çakışma: yeni olan asıl not kalır, diğeri kopya olarak saklanır; düzen alanları yine birleşir.
        const lay = mergeLayout();
        if ((cur.updatedAt || 0) >= (incoming.updatedAt || 0)) {
          copy = this._conflictCopy(incoming);
          return { ...cur, ...lay, _sha: sha };
        }
        copy = this._conflictCopy(cur);
        const m = { ...cur, ...incoming, ...lay, _sha: sha, _syncedAt: t, _base: snap };
        m._dirty = !sameLayout(m, incoming);
        return m;
      },
      { origin: 'sync' },
    );
    if (copy) this.store.mutate(copy.id, () => copy, { origin: 'local' });
  }

  _conflictCopy(src) {
    const t = this.now();
    return makeNote({
      type: src.type,
      title: (src.title || 'Adsız not') + ' (çakışma kopyası)',
      body: src.body,
      items: (src.items || []).map((i) => ({ ...i })),
      color: src.color,
      size: src.size,
      pinned: false,
      folderId: src.folderId || null,
      order: null,
      remindAt: null,
      remindFired: false,
      remindRepeat: 'none',
      remindBase: null,
      createdAt: t,
      updatedAt: t,
      trashedAt: src.trashedAt ?? null,
      id: newId(),
    });
  }

  async _push(cfg) {
    const dirty = this.store
      .all()
      .filter((n) => n._dirty || n._purge)
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    let firstErr = null;
    for (const n of dirty) {
      try {
        await this._pushOne(cfg, n.id, 0);
      } catch (e) {
        // Tek notun sorunu diğerlerini engellemesin.
        if (e instanceof SyncError && (e.kind === 'conflict' || e.kind === 'error')) { firstErr = firstErr || e; continue; }
        throw e;
      }
    }
    if (firstErr) throw firstErr;
  }

  async _pushOne(cfg, id, attempt) {
    const n = this.store.get(id);
    if (!n || !(n._dirty || n._purge)) return;
    const url = `/repos/${cfg.repo}/contents/notes/${id}.json`;

    if (n._purge) {
      // Silme: dosyayı kaldırmak yerine "silindi" işareti yazılır; diğer cihazlar bunu görünce notu siler.
      if (!n._sha) { this.store.mutate(id, () => null, { origin: 'sync' }); return; }
      const tomb = { v: 1, id, deleted: true, deletedAt: this.now() };
      try {
        const res = await this._gh(cfg, url, {
          method: 'PUT',
          body: { message: 'Not silindi', content: b64encode(JSON.stringify(tomb)), sha: n._sha },
        });
        const sha = res.data && res.data.content && res.data.content.sha;
        if (sha) this._markTomb(id, sha);
        this.store.mutate(id, () => null, { origin: 'sync' });
      } catch (e) {
        if ((e.kind === 'conflict' || e.kind === 'notfound') && attempt < 2) {
          const f = await this._getRemoteFile(cfg, id);
          if (!f) { this.store.mutate(id, () => null, { origin: 'sync' }); return; } // dosya zaten yok
          const live = f.data && typeof f.data === 'object' && f.data.deleted !== true ? fromRemote(f.data, id) : null;
          if (live && !live.trashedAt) {
            // Başka cihaz notu geri yüklemiş/düzenlemiş: silme, sessizce ezme.
            this.store.mutate(id, (c) => (c ? { ...c, _purge: false } : undefined), { origin: 'sync' });
            this._applyBlob(id, f.sha, f.data);
            return;
          }
          this.store.mutate(id, (c) => (c ? { ...c, _sha: f.sha } : undefined), { origin: 'sync' });
          return this._pushOne(cfg, id, attempt + 1);
        }
        throw e;
      }
      return;
    }

    const rev = n._rev;
    const body = {
      message: n.trashedAt ? 'Not çöpe taşındı' : 'Not güncellendi',
      content: b64encode(JSON.stringify(toRemote(n), null, 2)),
    };
    if (n._sha) body.sha = n._sha;
    let res;
    try {
      res = await this._gh(cfg, url, { method: 'PUT', body });
    } catch (e) {
      if (e.kind === 'conflict' && attempt < 3) {
        const f = await this._getRemoteFile(cfg, id);
        if (f && f.sha === n._sha) {
          // Dosya değişmemiş: iki cihaz aynı anda yazınca dalın ucu yarışmış (409). Kısa bekleyip yeniden dene.
          await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
          return this._pushOne(cfg, id, attempt + 1);
        }
        if (!f) this.store.mutate(id, (c) => (c ? { ...c, _sha: null } : undefined), { origin: 'sync' });
        else this._applyBlob(id, f.sha, f.data);
        // Uzak dosya yok / bozuk / güncel sha alındı: yeniden dene.
        if (!this.store.get(id)) return;
        return this._pushOne(cfg, id, attempt + 1);
      }
      throw e;
    }
    const sha = res.data && res.data.content && res.data.content.sha;
    const t = this.now();
    this.store.mutate(
      id,
      (cur) => {
        if (!cur) return undefined;
        const next = { ...cur, _sha: sha || cur._sha, _syncedAt: t, _base: snapshot(n) };
        if (cur._rev === rev) next._dirty = false;
        return next;
      },
      { origin: 'sync' },
    );
  }

  async _getRemoteFile(cfg, id) {
    try {
      const r = await this._gh(cfg, `/repos/${cfg.repo}/contents/notes/${id}.json?ref=${encodeURIComponent(cfg.branch)}`);
      let data = null;
      try { data = JSON.parse(b64decode(r.data.content)); } catch {}
      return { sha: r.data.sha, data };
    } catch (e) {
      if (e.kind === 'notfound') return null;
      throw e;
    }
  }

  // ---- HTTP

  async _pool(items, size, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await worker(item);
      }
    });
    await Promise.all(runners);
  }

  async _gh(cfg, path, o = {}) {
    const headers = {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (o.body) headers['Content-Type'] = 'application/json';
    if (o.etag) headers['If-None-Match'] = o.etag;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT) : null;
    let res;
    try {
      res = await this.fetch(this.apiBase + path, {
        method: o.method || 'GET',
        headers,
        body: o.body ? JSON.stringify(o.body) : undefined,
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch {
      throw new SyncError('network', 'İnternet bağlantısı yok ya da GitHub\'a ulaşılamıyor.');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 304) return { status: 304, etag: o.etag, data: null };
    let data = null;
    let text = '';
    try { text = await res.text(); } catch {}
    if (text) { try { data = JSON.parse(text); } catch {} }
    if (res.ok) return { status: res.status, data, etag: res.headers.get('etag') };

    const msg = (data && data.message) || res.statusText || `HTTP ${res.status}`;
    const s = res.status;
    if (s === 401) throw new SyncError('auth', 'GitHub anahtarı geçersiz ya da süresi dolmuş. Ayarlar\'dan yeniden bağla.', s);
    if (s === 403 || s === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = res.headers.get('retry-after');
      const reset = res.headers.get('x-ratelimit-reset');
      if (remaining === '0' || retryAfter || s === 429 || /rate limit|abuse|secondary/i.test(msg)) {
        const retryAt = retryAfter ? this.now() + Number(retryAfter) * 1000 : reset ? Number(reset) * 1000 : this.now() + 60_000;
        throw new SyncError('ratelimit', msg, s, { retryAt });
      }
      throw new SyncError('forbidden', 'Bu anahtarın depoya yazma izni yok. "Contents: Read and write" iznini kontrol et.', s);
    }
    if (s === 404) throw new SyncError('notfound', msg, s);
    if (s === 409 && /empty/i.test(msg)) throw new SyncError('empty', msg, s);
    if (s === 409 || s === 422) throw new SyncError('conflict', msg, s);
    if (s >= 500) throw new SyncError('server', msg, s);
    throw new SyncError('error', `GitHub: ${msg}`, s);
  }
}
