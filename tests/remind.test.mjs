import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, nextOccurrence, presets, findLinks, parsePastedItems, toLocalInput, fromLocalInput, dueReminders } from '../js/remind.js';
import { parseSize } from '../js/store.js';

test('ics: valid structure, UTC start, alarm and escaping', () => {
  const ics = buildIcs({ id: 'n1', title: 'Doktor; randevu, yarın', body: 'Satır 1\nSatır 2', remindAt: Date.UTC(2030, 4, 6, 7, 30, 0), remindRepeat: 'weekly' }, Date.UTC(2030, 0, 1));
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.includes('DTSTART:20300506T073000Z'));
  assert.ok(ics.includes('BEGIN:VALARM'));
  assert.ok(ics.includes('RRULE:FREQ=WEEKLY'));
  assert.ok(ics.includes(String.raw`SUMMARY:Doktor\; randevu\, yarın`));
  assert.ok(ics.includes(String.raw`DESCRIPTION:Satır 1\nSatır 2`));
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, 'line too long: ' + line);
});

test('ics: very long title is folded under 75 octets per line', () => {
  const ics = buildIcs({ id: 'n2', title: 'Çok uzun başlık '.repeat(20), body: '', remindAt: Date.UTC(2030, 0, 1) });
  assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
});

test('nextOccurrence advances daily/weekly/monthly past now', () => {
  const now = Date.UTC(2030, 5, 10, 12, 0, 0);
  const d = nextOccurrence(Date.UTC(2030, 5, 8, 9, 0, 0), 'daily', now);
  assert.ok(d > now && d - now <= 86_400_000);
  const w = nextOccurrence(Date.UTC(2030, 4, 1, 9, 0, 0), 'weekly', now);
  assert.ok(w > now && w - now <= 7 * 86_400_000);
  const m = nextOccurrence(Date.UTC(2030, 0, 15, 9, 0, 0), 'monthly', now);
  assert.ok(m > now);
  assert.equal(nextOccurrence(now - 1000, 'none', now), null);
});

test('presets are all in the future', () => {
  const now = Date.now();
  for (const p of presets(now)) assert.ok(p.ts > now, p.label);
});

test('datetime-local helpers round-trip', () => {
  const t = Date.UTC(2030, 0, 2, 9, 30);
  const local = toLocalInput(t);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local));
  assert.equal(fromLocalInput(local), Math.floor(t / 60000) * 60000);
  assert.equal(fromLocalInput('nonsense'), null);
});

test('dueReminders ignores fired, trashed and future notes', () => {
  const now = 1000;
  const list = [
    { id: 'a', remindAt: 500, remindFired: false },
    { id: 'b', remindAt: 500, remindFired: true },
    { id: 'c', remindAt: 500, remindFired: false, trashedAt: 1 },
    { id: 'd', remindAt: 5000, remindFired: false },
    { id: 'e', remindAt: null },
  ];
  assert.deepEqual(dueReminders(list, now).map((n) => n.id), ['a']);
});

test('findLinks: http, www, trailing punctuation, dedupe, no javascript:', () => {
  const links = findLinks('Bak: https://example.com/a?b=1. Ayrıca (www.github.com/x), tekrar https://example.com/a?b=1 ve javascript:alert(1)');
  assert.deepEqual(links.map((l) => l.href), ['https://example.com/a?b=1', 'https://www.github.com/x']);
});

test('parsePastedItems: bullets, done markers, numbering only when every line has it', () => {
  const r = parsePastedItems('- süt\n* ekmek\n[ ] peynir\n[x] zeytin\n☑ domates\n\n  salatalık  ');
  assert.deepEqual(r.map((i) => i.t), ['süt', 'ekmek', 'peynir', 'zeytin', 'domates', 'salatalık']);
  assert.deepEqual(r.map((i) => i.d), [false, false, false, true, true, false]);
  assert.deepEqual(parsePastedItems('1. a\n2. b\n3) c').map((i) => i.t), ['a', 'b', 'c']);
  assert.deepEqual(parsePastedItems('1990. yılında kuruldu\nikinci satır').map((i) => i.t), ['1990. yılında kuruldu', 'ikinci satır']);
});

test('nextOccurrence: monthly keeps the anchor day, far-overdue daily still repeats', () => {
  const anchor = new Date(2030, 0, 31, 9, 0, 0).getTime(); // 31 Ocak 09:00
  const feb = nextOccurrence(anchor, 'monthly', new Date(2030, 0, 31, 10, 0, 0).getTime());
  const fd = new Date(feb);
  assert.equal(fd.getMonth(), 1);
  assert.equal(fd.getDate(), 28); // Şubat sonu
  const mar = nextOccurrence(anchor, 'monthly', new Date(2030, 1, 28, 10, 0, 0).getTime());
  assert.equal(new Date(mar).getDate(), 31); // Mart'ta yine 31
  const old = new Date(2020, 0, 1, 8, 0, 0).getTime();
  const now = new Date(2030, 5, 10, 12, 0, 0).getTime();
  const d = nextOccurrence(old, 'daily', now);
  assert.ok(d > now && d - now <= 86_400_000);
});

test('parseSize clamps and validates', () => {
  assert.deepEqual(parseSize('3x2'), { w: 3, h: 2 });
  assert.deepEqual(parseSize('99x0'), { w: 12, h: 1 });
  assert.equal(parseSize('auto'), null);
  assert.equal(parseSize('3x'), null);
});
