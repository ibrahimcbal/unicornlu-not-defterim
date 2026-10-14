// Hatırlatıcı yardımcıları: zaman ön ayarları, tekrar, takvim (.ics) dosyası. Tarayıcıya bağımlı değildir.

const pad = (n) => String(n).padStart(2, '0');

/** Date -> <input type="datetime-local"> değeri (yerel saat). */
export function toLocalInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2026-10-14T18:30" -> ms (yerel saat). Geçersizse null. */
export function fromLocalInput(str) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(str || ''))) return null;
  const t = new Date(str).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Hızlı seçenekler: [{key, label, ts}] (yalnızca gelecekte olanlar). */
export function presets(now = Date.now()) {
  const d = new Date(now);
  const at = (days, h, m = 0) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h, m, 0, 0);
    return x.getTime();
  };
  const out = [];
  out.push({ key: '1h', label: '1 saat sonra', ts: now + 3_600_000 });
  const evening = at(0, 20);
  if (evening > now + 600_000) out.push({ key: 'evening', label: 'Bu akşam 20:00', ts: evening });
  out.push({ key: 'tomorrow', label: 'Yarın 09:00', ts: at(1, 9) });
  const dow = d.getDay(); // 0 Pazar
  const toMonday = ((8 - dow) % 7) || 7;
  out.push({ key: 'week', label: 'Haftaya Pazartesi 09:00', ts: at(toMonday, 9) });
  return out;
}

/** Tekrarlı hatırlatıcının bir sonraki zamanı (now'dan sonra olana kadar ilerler). */
export function nextOccurrence(ts, repeat, now = Date.now()) {
  if (!['daily', 'weekly', 'monthly'].includes(repeat)) return null;
  let t = ts;
  for (let i = 0; i < 1000 && t <= now; i++) {
    const d = new Date(t);
    if (repeat === 'daily') d.setDate(d.getDate() + 1);
    else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
    t = d.getTime();
  }
  return t > now ? t : null;
}

/** Çalması gereken (zamanı gelmiş, çalmamış, çöpte olmayan) notlar. */
export function dueReminders(notes, now = Date.now()) {
  return notes.filter((n) => n.remindAt && !n.remindFired && !n.trashedAt && !n._purge && n.remindAt <= now);
}

const icsDate = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** 75 bayt sınırına göre satır katlama (RFC 5545). */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 74) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > (out.length ? 73 : 74)) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** Tek not için takvim dosyası. Takvim uygulaması uygulama kapalıyken de alarm çalar. */
export function buildIcs({ id, title, body, remindAt, remindRepeat }, now = Date.now()) {
  const name = (title || '').trim() || 'Not Defterim hatırlatıcısı';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Unicornlu Not Defterim//TR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${id}@unicornlu-not-defterim`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(remindAt)}`,
    `DTEND:${icsDate(remindAt + 15 * 60_000)}`,
    `SUMMARY:${esc(name)}`,
  ];
  const desc = String(body || '').trim().slice(0, 500);
  if (desc) lines.push(`DESCRIPTION:${esc(desc)}`);
  const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' }[remindRepeat];
  if (freq) lines.push(`RRULE:FREQ=${freq}`);
  lines.push('BEGIN:VALARM', 'TRIGGER:PT0S', 'ACTION:DISPLAY', `DESCRIPTION:${esc(name)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Metindeki http(s) ve www bağlantıları (en çok max adet, tekrarsız). */
export function findLinks(text, max = 6) {
  const out = [];
  const seen = new Set();
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < max) {
    let u = m[0].replace(/[.,;:!?)\]}»”’]+$/u, '');
    if (!u) continue;
    const href = /^https?:\/\//i.test(u) ? u : 'https://' + u;
    try {
      const p = new URL(href);
      if (!/^https?:$/.test(p.protocol)) continue;
      if (seen.has(p.href)) continue;
      seen.add(p.href);
      out.push({ href: p.href, label: (p.host + (p.pathname === '/' ? '' : p.pathname)).replace(/^www\./, '').slice(0, 42) });
    } catch {}
  }
  return out;
}

/** Yapıştırılan çok satırlı metni liste maddelerine ayırır (madde işaretlerini temizler). */
export function splitPastedLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•▪◦]|\d+[.)]|\[[ xX]?\]|[☐☑✓])\s+/, '').trim())
    .filter(Boolean);
}
