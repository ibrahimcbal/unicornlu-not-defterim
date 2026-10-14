// Sync engine tests. Each "device" is its own Store + SyncEngine; devices meet only
// through one mock GitHub repo (tests/mock-github.mjs).
// Run from the project root: node --test tests/*.test.mjs
// (Node 24 rejects a bare directory argument to --test.)
// Tests named x1..x5 go beyond the requested scenarios. They target suspected bugs in
// js/sync.js and js/store.js and are expected to FAIL until those bugs are fixed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryBackend } from '../js/store.js';
import { SyncEngine } from '../js/sync.js';
import { createMockGitHub } from './mock-github.mjs';

const MIN = 60_000;
const COPY_SUFFIX = '(çakışma kopyası)';
const live = new Set();

afterEach(() => {
  // Clears debounce and retry timers so the test process can exit.
  for (const d of live) d.engine.disconnect();
  live.clear();
});

/**
 * One device. `skew.ms` moves this device's clock forward, which lets a test get past
 * the 90 s "recently written" guard in sync.js without waiting.
 */
async function makeDevice(mock) {
  const store = await new Store(new MemoryBackend()).open();
  const skew = { ms: 0 };
  const engine = new SyncEngine(store, {
    fetch: mock.fetch,
    debounceMs: 0,
    pollMs: 1e9,
    now: () => Date.now() + skew.ms,
  });
  const dev = { store, engine, skew };
  live.add(dev);
  await engine.connect({ token: 'test-token', repo: 'me/data' });
  return dev;
}

const remoteNote = (mock, id) => {
  const f = mock.files.get(`notes/${id}.json`);
  return f ? JSON.parse(f.content) : undefined;
};
const isTomb = (mock, id) => {
  const n = remoteNote(mock, id);
  return !!(n && n.deleted === true);
};
const remoteIds = (mock) =>
  [...mock.files.keys()]
    .map((p) => p.replace(/^notes\//, '').replace(/\.json$/, ''))
    .filter((id) => !isTomb(mock, id))
    .sort();
const localIds = (store) => store.all().map((n) => n.id).sort();
const localBodies = (store) => store.all().map((n) => n.body).sort();

// ---------------------------------------------------------------- requested scenarios

test('a: first sync into an empty repo uploads all local notes', async () => {
  const mock = createMockGitHub();
  const dev = await makeDevice(mock);
  const titles = ['Alfa', 'Beta', 'Gama'];
  const ids = titles.map((title, i) => dev.store.create({ title, body: `gövde ${i + 1}`, color: 'blue' }).id);

  await dev.engine.syncNow();

  assert.equal(mock.files.size, 3);
  assert.equal(mock.requestLog.filter((l) => l.startsWith('PUT ')).length, 3);
  titles.forEach((title, i) => {
    const remote = remoteNote(mock, ids[i]);
    assert.equal(remote.title, title);
    assert.equal(remote.body, `gövde ${i + 1}`);
    assert.deepEqual(Object.keys(remote).filter((k) => k.startsWith('_')), []);
    const local = dev.store.get(ids[i]);
    assert.equal(local._dirty, false);
    assert.equal(local._sha, mock.files.get(`notes/${ids[i]}.json`).sha);
  });
});

test('b: a fresh device pulls every note with identical title and body', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const samples = [
    { title: 'Çığlık şüphesiz İstanbul ğ ı İ ö', body: 'Merhaba dünya, öğrenci ağacı' },
    { title: 'Emoji 🦄🎉', body: 'Aile 👩🏽‍💻, kedi 🐈 ve tire — "tırnak" \'tek\'' },
    { title: 'Boş gövde', body: '' },
  ];
  const ids = samples.map((s) => a.store.create(s).id);
  await a.engine.syncNow();

  const b = await makeDevice(mock);

  assert.equal(b.store.all().length, 3);
  samples.forEach((s, i) => {
    const got = b.store.get(ids[i]);
    assert.ok(got, `note ${ids[i]} missing on device B`);
    assert.equal(got.title, s.title);
    assert.equal(got.body, s.body);
    assert.equal(got._dirty, false);
  });
});

test('c: an edit on A reaches B after one sync each', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const n = a.store.create({ title: 'Liste', body: 'ilk hali' });
  await a.engine.syncNow();
  const b = await makeDevice(mock);

  a.store.edit(n.id, { body: 'ikinci hali ✓' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  assert.equal(b.store.get(n.id).body, 'ikinci hali ✓');
  assert.equal(b.store.get(n.id)._dirty, false);
  assert.equal(b.store.all().length, 1);
});

test('d: concurrent edits of one note keep both versions as a conflict copy', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const note = a.store.create({ title: 'Ortak not', body: 'v0' });
  await a.engine.syncNow();
  const b = await makeDevice(mock);
  assert.equal(b.store.get(note.id).body, 'v0');

  a.store.edit(note.id, { body: 'A tarafında yazılan metin' });
  b.store.edit(note.id, { body: 'B tarafında yazılan metin' });
  await a.engine.syncNow();
  await b.engine.syncNow();

  const onB = b.store.all();
  assert.equal(onB.length, 2, 'B should hold the main note plus one conflict copy');
  const copy = onB.find((n) => n.id !== note.id);
  assert.ok(copy, 'conflict copy missing');
  assert.ok(copy.title.endsWith(COPY_SUFFIX), `unexpected copy title: ${copy.title}`);
  assert.deepEqual(localBodies(b.store), ['A tarafında yazılan metin', 'B tarafında yazılan metin']);
  assert.ok(b.store.get(note.id), 'main note id must survive');

  await a.engine.syncNow();
  assert.deepEqual(localIds(a.store), localIds(b.store));
  assert.deepEqual(localBodies(a.store), localBodies(b.store));
  assert.equal(mock.files.size, 2);
});

test('e: trash and purge on A reach B; purge leaves a deletion marker', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const doomed = a.store.create({ title: 'Silinecek', body: 'x' });
  const keeper = a.store.create({ title: 'Kalacak', body: 'y' });
  await a.engine.syncNow();
  const b = await makeDevice(mock);

  a.store.trash(doomed.id);
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.ok(b.store.get(doomed.id).trashedAt != null, 'trash did not reach B');

  a.store.purge(doomed.id);
  await a.engine.syncNow();
  assert.equal(isTomb(mock, doomed.id), true, 'remote file was not replaced by a deletion marker');
  assert.equal(a.store.get(doomed.id), undefined);

  // B's copy was written moments ago; let B's clock move past the 90 s guard.
  b.skew.ms = 10 * MIN;
  await b.engine.syncNow();
  assert.equal(b.store.get(doomed.id), undefined, 'B still has the purged note');
  assert.ok(b.store.get(keeper.id));
});

test('f: offline edits stay dirty and intact, then upload once back online', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const n1 = a.store.create({ title: 'Bir', body: 'ilk' });
  const n2 = a.store.create({ title: 'İki', body: 'ikinci' });
  await a.engine.syncNow();

  mock.offline = true;
  a.store.edit(n1.id, { body: 'çevrimdışı düzenleme' });
  const n3 = a.store.create({ title: 'Yeni', body: 'çevrimdışı not' });
  await a.engine.syncNow();

  assert.equal(a.engine.status.state, 'offline');
  assert.equal(a.store.get(n1.id)._dirty, true);
  assert.equal(a.store.get(n1.id).body, 'çevrimdışı düzenleme');
  assert.equal(a.store.get(n3.id)._dirty, true);
  assert.equal(a.store.get(n2.id)._dirty, false);
  assert.equal(a.store.all().length, 3);

  mock.offline = false;
  await a.engine.syncNow();

  assert.equal(a.engine.status.state, 'ok');
  assert.equal(a.store.all().some((n) => n._dirty), false);
  assert.equal(remoteNote(mock, n1.id).body, 'çevrimdışı düzenleme');
  assert.equal(mock.files.size, 3);
});

test('g: 401 from GitHub sets state auth and leaves local notes untouched', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const n = a.store.create({ title: 'Yerel', body: 'dokunulmamalı' });

  mock.failNext(401, 'Bad credentials');
  await a.engine.syncNow();

  assert.equal(a.engine.status.state, 'auth');
  const got = a.store.get(n.id);
  assert.equal(got.title, 'Yerel');
  assert.equal(got.body, 'dokunulmamalı');
  assert.equal(got._dirty, true);
  assert.equal(got._sha, null);
  assert.equal(mock.files.size, 0);
});

test('h: an unchanged repo costs exactly one request, answered 304', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  a.store.create({ title: 'Bir', body: '1' });
  a.store.create({ title: 'İki', body: '2' });
  await a.engine.syncNow(); // uploads; the stored tree ETag predates the upload
  await a.engine.syncNow(); // full tree answer (200); stores the current ETag

  const statuses = [];
  const realFetch = a.engine.fetch;
  a.engine.fetch = async (url, init) => {
    const r = await realFetch(url, init);
    statuses.push(r.status);
    return r;
  };
  const before = mock.requestLog.length;
  await a.engine.syncNow();

  assert.equal(mock.requestLog.length - before, 1);
  assert.match(mock.requestLog[before], /^GET \/repos\/me\/data\/git\/trees\/main/);
  assert.deepEqual(statuses, [304]);
  assert.equal(a.engine.status.state, 'ok');
});

test('i: a remote wipe (repo reset) does not delete local notes; they are re-uploaded', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const ids = [1, 2, 3, 4, 5].map((i) => a.store.create({ title: `Not ${i}`, body: `içerik ${i}` }).id);
  await a.engine.syncNow();
  assert.equal(mock.files.size, 5);

  for (const id of ids) a.store.mutate(id, (n) => ({ ...n, _syncedAt: 0 }), { origin: 'sync' });
  mock.resetRepo();
  await a.engine.syncNow();

  assert.equal(a.store.all().length, 5, 'local notes were deleted');
  assert.equal(mock.files.size, 5, 'notes were not re-uploaded');
  for (const id of ids) {
    assert.equal(a.store.get(id)._dirty, false);
    assert.ok(remoteNote(mock, id), `${id} missing remotely`);
  }
});

test('j: a note purged on A and untouched on B disappears on B', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const x = a.store.create({ title: 'X', body: 'silinecek' });
  const y = a.store.create({ title: 'Y', body: 'kalacak' });
  await a.engine.syncNow();
  const b = await makeDevice(mock);

  a.store.purge(x.id);
  await a.engine.syncNow();
  b.skew.ms = 10 * MIN;
  await b.engine.syncNow();

  assert.equal(b.store.get(x.id), undefined);
  assert.equal(b.store.get(y.id).body, 'kalacak');
  assert.equal(isTomb(mock, x.id), true);
});

test('j: a note purged on A but edited on B is resurrected by B (no silent loss)', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const x = a.store.create({ title: 'X', body: 'eski' });
  await a.engine.syncNow();
  const b = await makeDevice(mock);

  b.store.edit(x.id, { body: 'B tarafında yeni metin' }); // dirty on B, not yet synced
  a.store.purge(x.id);
  await a.engine.syncNow();
  assert.equal(isTomb(mock, x.id), true);

  b.skew.ms = 10 * MIN;
  await b.engine.syncNow();

  assert.equal(b.store.get(x.id).body, 'B tarafında yeni metin');
  assert.equal(remoteNote(mock, x.id).body, 'B tarafında yeni metin');
});

test('k: invalid JSON and non-array scalar JSON files do not stop the sync', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const n1 = a.store.create({ title: 'Sağlam 1', body: 'a' });
  const n2 = a.store.create({ title: 'Sağlam 2', body: 'b' });
  await a.engine.syncNow();

  mock.setFile('notes/nbad.json', '{not json');
  mock.setFile('notes/nnum.json', '42');
  mock.setFile('notes/nnull.json', 'null');
  mock.setFile('notes/nstr.json', '"metin"');

  const b = await makeDevice(mock);
  assert.equal(b.engine.status.state, 'ok');
  assert.deepEqual(localIds(b.store), [n1.id, n2.id].sort());

  a.store.edit(n1.id, { body: 'sonra düzenlendi' });
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal(b.store.get(n1.id).body, 'sonra düzenlendi');
  assert.equal(b.engine.status.state, 'ok');
});

test('l: a 200 KB note body round-trips intact', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const unit = 'Çığlık şüphesiz İstanbul 🦄 ';
  const body = unit.repeat(Math.ceil((200 * 1024) / Buffer.byteLength(unit, 'utf8')));
  assert.ok(Buffer.byteLength(body, 'utf8') >= 200 * 1024);
  const n = a.store.create({ title: 'Büyük', body });
  await a.engine.syncNow();

  const b = await makeDevice(mock);
  const got = b.store.get(n.id);
  assert.equal(got.body.length, body.length);
  assert.ok(got.body === body, 'body differs after round trip');
  assert.equal(remoteNote(mock, n.id).body.length, body.length);
});

test('m: an edit made while a PUT is in flight stays dirty and uploads on the next sync', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const n = a.store.create({ title: 'Uçuşta', body: 'v1' });

  let wrapped = false;
  a.engine.fetch = (url, init) => {
    const pending = mock.fetch(url, init); // server applies the v1 PUT here
    if (init.method === 'PUT' && !wrapped) {
      wrapped = true;
      a.store.edit(n.id, { body: 'v2 uçuşta yazıldı' });
    }
    return pending;
  };
  await a.engine.syncNow();

  assert.equal(a.store.get(n.id).body, 'v2 uçuşta yazıldı');
  assert.equal(a.store.get(n.id)._dirty, true, 'in-flight edit was marked clean');
  assert.equal(remoteNote(mock, n.id).body, 'v1');

  await a.engine.syncNow();

  assert.equal(a.store.get(n.id)._dirty, false);
  assert.equal(remoteNote(mock, n.id).body, 'v2 uçuşta yazıldı');
  assert.equal(a.engine.status.state, 'ok');
});

// ---------------------------------------------------------------- suspected bugs (expected to fail)

test('x1: a purge made while B is online is applied on B at once', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const x = a.store.create({ title: 'Geçici', body: 'x' });
  await a.engine.syncNow();
  const b = await makeDevice(mock); // B pulls X now

  a.store.purge(x.id);
  await a.engine.syncNow();
  await b.engine.syncNow();
  assert.equal(b.store.get(x.id), undefined, 'purged note still on B');

  b.skew.ms = 10 * MIN;
  await b.engine.syncNow();
  assert.equal(b.store.get(x.id), undefined);
});

test('x2: notes trashed and auto-purged on A (4 of 5) do not come back as live notes on an offline device B', async () => {
  const DAY = 86_400_000;
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const notes = [1, 2, 3, 4, 5].map((i) => a.store.create({ title: `Not ${i}`, body: `${i}` }));
  await a.engine.syncNow();
  const b = await makeDevice(mock); // B has all 5 live notes, then stops syncing

  // A trashed 4 notes 31 days ago. The first sync pushes the trash state and purgeExpired
  // marks them; the second sync deletes them remotely.
  for (const n of notes.slice(0, 4)) a.store.edit(n.id, { trashedAt: Date.now() - 31 * DAY });
  await a.engine.syncNow();
  await a.engine.syncNow();
  assert.deepEqual(remoteIds(mock), [notes[4].id]);
  assert.equal(mock.files.size, 5);

  // B returns a month later with its stale, live copies.
  b.skew.ms = 40 * DAY;
  await b.engine.syncNow();

  assert.deepEqual(localIds(b.store), [notes[4].id], 'expired notes came back on B as live notes');
  assert.deepEqual(remoteIds(mock), [notes[4].id], 'expired notes were re-uploaded');
});

test('x3: a 404 for the configured branch does not delete local synced notes', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  a.store.create({ title: 'Bir', body: '1' });
  a.store.create({ title: 'İki', body: '2' });
  await a.engine.syncNow();

  // The branch this device points at no longer exists (for example, renamed on GitHub).
  a.store.setMeta('sync', { ...a.store.getMeta('sync'), branch: 'master' });
  a.skew.ms = 10 * MIN;
  await a.engine.syncNow();

  assert.equal(a.store.all().length, 2, 'local notes were deleted after a branch 404');
});

test('x4: a JSON array in notes/ is not a note and must not become a blank note', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  a.store.create({ title: 'Sağlam', body: 'a' });
  await a.engine.syncNow();
  mock.setFile('notes/narr.json', '[1,2,3]');

  const b = await makeDevice(mock);

  assert.equal(b.store.get('narr'), undefined, 'array payload was imported as a note');
});

test('x5: an unreadable remote file does not stop other dirty notes from uploading', async () => {
  const mock = createMockGitHub();
  const a = await makeDevice(mock);
  const p = a.store.create({ title: 'P', body: 'v1' });
  const q = a.store.create({ title: 'Q', body: 'v1' });
  await a.engine.syncNow();

  // Another client replaces P's file with something that is not JSON.
  mock.setFile(`notes/${p.id}.json`, '{garbage');
  a.store.edit(p.id, { body: 'v2' }); // P is pushed first (older updatedAt)
  a.store.edit(q.id, { body: 'v2' });
  await a.engine.syncNow();

  assert.equal(remoteNote(mock, q.id)?.body, 'v2', 'Q was never uploaded');
  assert.equal(remoteNote(mock, p.id)?.body, 'v2', 'P was never uploaded');
  assert.equal(a.engine.status.state, 'ok');
});
