// Tema, ilk boyamadan önce uygulanır (beyaz parlama olmasın). Harici dosya: CSP için.
try {
  var p = JSON.parse(localStorage.getItem('unb:prefs') || '{}');
  var d = document.documentElement;
  var s = p.scheme || 'auto';
  if (s === 'auto') s = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  d.dataset.scheme = s;
  d.dataset.plate = p.plate || 'gray';
  d.dataset.text = p.textSize || 'm';
  d.dataset.font = p.font || 'round';
} catch (e) {}

// Başka bir sitenin çerçevesine gömülürse görünmez ol (clickjacking). Başlık (frame-ancestors) Pages'te eklenemez.
try {
  if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    try { window.top.location.href = window.self.location.href; } catch (e) {}
  }
} catch (e) {
  document.documentElement.style.display = 'none';
}
