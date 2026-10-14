// Efektler: tuk sesi, konfeti, parçalanma, FLIP geçişleri. Hepsi isteğe bağlı süs; hata verirse sessizce geçer.

const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const motionOK = () => !reduceMotion();

let soundOn = false;
export function setSound(v) { soundOn = !!v; }

let ctx = null;
function audio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

/** Lego "tuk" sesi: kısa, tok bir tık. */
export function snap(strength = 1) {
  if (!soundOn) return;
  const ac = audio();
  if (!ac) return;
  try {
    if (ac.state === 'suspended') ac.resume();
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(900 * (0.9 + 0.2 * Math.random()), t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.06);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18 * strength, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.09);
  } catch {}
}

export function buzz(ms = 8) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch {}
}

const CONFETTI = ['#FFC914', '#E5453D', '#2D6BE4', '#18A058', '#FF8A1F', '#7B5BD6', '#FF8FB8'];

/** Küçük renkli tuğla parçaları saçar. origin: {x, y} (viewport koordinatı). */
export function confetti(origin, count = 18) {
  if (reduceMotion()) return;
  const layer = document.createElement('div');
  layer.className = 'fx-layer';
  document.body.append(layer);
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.className = 'fx-bit';
    const size = 6 + Math.random() * 8;
    p.style.cssText = `left:${origin.x}px;top:${origin.y}px;width:${size}px;height:${size * (Math.random() > 0.5 ? 1 : 0.6)}px;background:${CONFETTI[i % CONFETTI.length]}`;
    layer.append(p);
    const ang = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 120;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist - 60;
    p.animate(
      [
        { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${Math.random() * 540 - 270}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx * 1.1}px), calc(-50% + ${dy + 140}px)) rotate(${Math.random() * 720 - 360}deg)`, opacity: 0 },
      ],
      { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' },
    );
  }
  setTimeout(() => layer.remove(), 1700);
}

/** Bir elemanı tuğla gibi "yerine oturtur": hafif sıkışma + esneme. */
export function land(el) {
  if (!el || reduceMotion() || !el.animate) return;
  el.animate(
    [
      { transform: 'translateY(-14px) scale(1.03,0.97)' },
      { transform: 'translateY(0) scale(0.98,1.04)', offset: 0.55 },
      { transform: 'translateY(0) scale(1.01,0.99)', offset: 0.8 },
      { transform: 'none' },
    ],
    { duration: 380, easing: 'cubic-bezier(.3,.8,.4,1)' },
  );
}

/** Eski konumdan yeni konuma kayma (FLIP). first: Map(el -> DOMRect) */
export function flip(first) {
  if (reduceMotion()) return;
  for (const [el, a] of first) {
    if (!el.isConnected || !el.animate) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], {
      duration: 420,
      easing: 'cubic-bezier(.2,.9,.3,1.15)',
    });
  }
}

/** Kart → editör gibi bir dikdörtgenden diğerine büyüme/küçülme. */
export function morph(el, fromRect, { reverse = false, duration = 440 } = {}) {
  if (!el || !el.animate) return null;
  const fill = reverse ? 'forwards' : 'backwards';
  if (reduceMotion() || !fromRect) {
    return el.animate([{ opacity: reverse ? 1 : 0 }, { opacity: reverse ? 0 : 1 }], { duration: 180, fill });
  }
  const to = el.getBoundingClientRect();
  const dx = fromRect.left - to.left;
  const dy = fromRect.top - to.top;
  const sx = Math.max(0.05, fromRect.width / to.width);
  const sy = Math.max(0.05, fromRect.height / to.height);
  const small = `translate(${dx}px,${dy}px) scale(${sx},${sy})`;
  const frames = reverse
    ? [{ transform: 'none', opacity: 1 }, { transform: small, opacity: 0.15 }]
    : [{ transform: small, opacity: 0.25 }, { transform: 'none', opacity: 1 }];
  return el.animate(frames, {
    duration,
    easing: reverse ? 'cubic-bezier(.5,0,.75,.2)' : 'cubic-bezier(.2,.85,.25,1.04)',
    fill,
  });
}

/** Animasyon bitince çöz; takılırsa (arka plan, sekme gizli) ms sonra yine de çöz. */
export function done(anim, ms = 800) {
  if (!anim || !anim.finished) return Promise.resolve();
  return Promise.race([anim.finished.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

/** Çöpe atılırken: eğilip düşerek kaybolur. */
export function crumble(el) {
  if (!el || !el.animate || reduceMotion()) return Promise.resolve();
  const anim = el.animate(
    [
      { transform: 'none', opacity: 1 },
      { transform: 'translateY(8px) rotate(-3deg)', opacity: 1, offset: 0.25 },
      { transform: 'translateY(90px) rotate(14deg) scale(.8)', opacity: 0 },
    ],
    { duration: 420, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' },
  );
  return done(anim, 700);
}
