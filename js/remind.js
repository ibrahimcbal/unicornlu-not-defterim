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

/**
 * Tekrarlı hatırlatıcının, now'dan sonraki ilk zamanı. `ts` asıl (çapa) zamandır:
 * her seferinde çapadan hesaplanır, bu yüzden aylık tekrar kaymaz (31'i → ayın son günü).
 */
export function nextOccurrence(ts, repeat, now = Date.now()) {
  if (!['daily', 'weekly', 'monthly'].includes(repeat) || !Number.isFinite(ts)) return null;
  if (ts > now) return ts;
  const a = new Date(ts);
  if (repeat === 'daily' || repeat === 'weekly') {
    const step = repeat === 'daily' ? 1 : 7;
    const d = new Date(a);
    d.setDate(d.getDate() + Math.floor((now - ts) / 86_400_000 / step) * step);
    for (let i = 0; i < 20 && d.getTime() <= now; i++) d.setDate(d.getDate() + step);
    return d.getTime() > now ? d.getTime() : null;
  }
  const n = new Date(now);
  let k = Math.max(0, (n.getFullYear() - a.getFullYear()) * 12 + n.getMonth() - a.getMonth() - 1);
  for (let i = 0; i < 40; i++, k++) {
    const dim = new Date(a.getFullYear(), a.getMonth() + k + 1, 0).getDate();
    const c = new Date(a.getFullYear(), a.getMonth() + k, Math.min(a.getDate(), dim), a.getHours(), a.getMinutes(), 0, 0);
    if (c.getTime() > now) return c.getTime();
  }
  return null;
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

/**
 * Yapıştırılan çok satırlı metni liste maddelerine ayırır.
 * Madde işaretleri temizlenir; [x] / ☑ / ✓ işaretliler tamamlanmış sayılır;
 * "1." numaraları yalnızca bütün satırlarda varsa silinir ("1990. yılında…" bozulmasın).
 */
export function parsePastedItems(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const allNumbered = lines.length > 0 && lines.every((l) => /^\d+[.)]\s+\S/.test(l));
  return lines.map((raw) => {
    let l = raw;
    let d = false;
    if (allNumbered) l = l.replace(/^\d+[.)]\s+/, '');
    const m = /^(?:[-*•▪◦]\s+)?(?:\[([ xX]?)\]|([☐☑✓]))\s+/.exec(l);
    if (m) {
      d = (m[1] || '').toLowerCase() === 'x' || m[2] === '☑' || m[2] === '✓';
      l = l.slice(m[0].length);
    } else {
      l = l.replace(/^[-*•▪◦]\s+/, '');
    }
    return { t: l.trim(), d };
  }).filter((i) => i.t);
}

export function splitPastedLines(text) {
  return parsePastedItems(text).map((i) => i.t);
}
