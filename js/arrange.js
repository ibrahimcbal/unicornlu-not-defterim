// Tuğlaları sürükleyerek yeniden sıralama, klasöre bırakma ve köşeden boyutlandırma.
// Pointer Events kullanır: fare, dokunma ve kalem aynı yoldan çalışır.
//  - Fare: tuğlanın herhangi bir yerinden sürükle.
//  - Dokunma: uzun bas → düzenleme modu; sonra tutamaçtan (✥) sürükle, köşeden (⤡) boyutlandır.
import * as fx from './fx.js';

const MAX_H = 12;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function initArrange(o) {
  const { grid } = o;
  let drag = null;
  let press = null;
  let suppressUntil = 0;

  grid.addEventListener('pointerdown', onDown);
  grid.addEventListener('contextmenu', (e) => {
    if (e.target.closest && e.target.closest('.brick') && (o.arranging() || e.pointerType === 'touch')) e.preventDefault();
  });
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancelEvent);
  // Pencere odağını kaybederse ya da gizlenirse yarım kalan sürüklemeyi bırak.
  window.addEventListener('blur', () => cancel());
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });

  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest && e.target.closest('.brick');
    if (!card || !grid.contains(card) || !o.enabled()) return;
    const sizeH = e.target.closest('.h-size');
    const moveH = e.target.closest('.h-move');
    if (sizeH) { e.preventDefault(); beginResize(card, e); return; }
    if (moveH) { e.preventDefault(); beginMove(card, e); return; }
    if (e.target.closest('button, a, input, textarea')) return;
    if (e.pointerType === 'mouse') {
      press = { card, x: e.clientX, y: e.clientY, kind: 'mouse' };
    } else if (!o.arranging()) {
      press = {
        card, x: e.clientX, y: e.clientY, kind: 'touch',
        timer: setTimeout(() => {
          suppressUntil = performance.now() + 700;
          press = null;
          o.onLongPress(card);
        }, 480),
      };
    }
  }

  function onMove(e) {
    if (press) {
      const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      if (press.kind === 'mouse' && dist > 6) {
        const c = press.card;
        press = null;
        beginMove(c, e);
      } else if (press.kind === 'touch' && dist > 10) {
        clearTimeout(press.timer);
        press = null;
      }
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.kind === 'move') {
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      drag.ghost.style.left = e.clientX - drag.ox + 'px';
      drag.ghost.style.top = e.clientY - drag.oy + 'px';
      hitTest();
    } else resizeDrag(e);
  }

  function beginMove(card, e) {
    if (drag) cancel(); // ikinci parmak/ikinci sürükleme: öncekini temiz bırak
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.removeAttribute('data-id');
    ghost.removeAttribute('tabindex');
    ghost.querySelectorAll('.h-move, .h-size, .quick').forEach((n) => n.remove());
    Object.assign(ghost.style, {
      position: 'fixed', left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px',
      margin: '0', zIndex: '90', pointerEvents: 'none',
    });
    document.body.append(ghost);
    card.classList.add('drag-src');
    document.body.classList.add('dragging');
    try { e.target.setPointerCapture(e.pointerId); } catch {}
    drag = {
      kind: 'move', card, ghost, pointerId: e.pointerId,
      ox: e.clientX - rect.left, oy: e.clientY - rect.top,
      startIndex: [...grid.children].indexOf(card),
      lastTarget: null, into: null, lastX: e.clientX, lastY: e.clientY, raf: 0,
    };
    if (o.onDragStart) o.onDragStart();
    fx.buzz(10);
    loop();
  }

  function clearHighlights() {
    document.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
  }

  /** İşaretçinin altındaki hedefe göre: klasöre bırak / sıra değiştir. */
  function hitTest() {
    const d = drag;
    if (!d || d.kind !== 'move') return;
    const stack = document.elementsFromPoint(d.lastX, d.lastY);
    clearHighlights();
    const crumb = stack.find((n) => n.classList && n.classList.contains('crumb') && n.dataset.drop !== undefined);
    if (crumb) {
      d.into = { folder: crumb.dataset.drop || null };
      crumb.classList.add('drop-target');
      return;
    }
    const target = stack.find((n) => n.classList && n.classList.contains('brick') && n !== d.card && n !== d.ghost && grid.contains(n));
    if (target && o.isFolderCard(target)) {
      const r = target.getBoundingClientRect();
      const inner =
        d.lastX > r.left + r.width * 0.2 && d.lastX < r.right - r.width * 0.2 &&
        d.lastY > r.top + r.height * 0.2 && d.lastY < r.bottom - r.height * 0.2;
      if (inner) {
        d.into = { folder: target.dataset.id };
        target.classList.add('drop-target');
        return;
      }
    }
    d.into = null;
    if (!target) { d.lastTarget = null; return; }
    if (target === d.lastTarget) return;
    d.lastTarget = target;
    const kids = [...grid.children];
    const si = kids.indexOf(d.card);
    const ti = kids.indexOf(target);
    const first = new Map();
    if (kids.length < 160) for (const k of kids) first.set(k, k.getBoundingClientRect());
    if (si < ti) target.after(d.card);
    else target.before(d.card);
    fx.flip(first);
  }

  function beginResize(card, e) {
    if (drag) cancel();
    const dims = o.getDims(card);
    drag = { kind: 'size', card, pointerId: e.pointerId, w: dims.w, h: dims.h, startW: dims.w, startH: dims.h };
    card.classList.add('resizing');
    document.body.classList.add('dragging');
    try { e.target.setPointerCapture(e.pointerId); } catch {}
    if (o.onDragStart) o.onDragStart();
  }

  function resizeDrag(e) {
    const d = drag;
    const { cols, cell } = o.info();
    const cs = getComputedStyle(d.card);
    const mx = parseFloat(cs.marginLeft) + parseFloat(cs.marginRight);
    const my = parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
    const r = d.card.getBoundingClientRect();
    const nw = clamp(Math.round((e.clientX - r.left + mx) / cell), 1, cols);
    const nh = clamp(Math.round((e.clientY - r.top + my) / cell), 1, MAX_H);
    if (nw !== d.w || nh !== d.h) {
      d.w = nw;
      d.h = nh;
      o.setDims(d.card, nw, nh);
      fx.buzz(6);
    }
  }

  function loop() {
    if (!drag || drag.kind !== 'move') return;
    const y = drag.lastY;
    const vh = window.innerHeight;
    let dy = 0;
    if (y < 90) dy = -Math.ceil((90 - y) / 5);
    else if (y > vh - 90) dy = Math.ceil((y - (vh - 90)) / 5);
    if (dy) {
      window.scrollBy(0, dy);
      hitTest(); // sayfa kayınca imlecin altındaki hedef değişir
    }
    drag.raf = requestAnimationFrame(loop);
  }

  function finish() {
    const d = drag;
    drag = null;
    if (!d) return null;
    cancelAnimationFrame(d.raf);
    if (d.ghost) d.ghost.remove();
    d.card.classList.remove('drag-src', 'resizing');
    document.body.classList.remove('dragging');
    clearHighlights();
    suppressUntil = performance.now() + 450;
    if (o.onDragEnd) o.onDragEnd();
    return d;
  }

  function cancel() {
    if (!drag) return;
    const d = finish();
    if (d && d.kind === 'size') o.setDims(d.card, d.startW, d.startH);
    if (o.onCancel) o.onCancel();
  }

  function onUp(e) {
    if (press) {
      clearTimeout(press.timer);
      press = null;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = finish();
    const id = d.card.dataset.id;
    if (d.kind === 'size') {
      if (d.w !== d.startW || d.h !== d.startH) o.onResize(id, d.w, d.h);
      return;
    }
    if (d.into) {
      o.onDropInto(id, d.into.folder);
      return;
    }
    // Yerinde bırakıldıysa hiçbir şey kaydetme.
    if ([...grid.children].indexOf(d.card) === d.startIndex) {
      if (o.onCancel) o.onCancel();
      return;
    }
    const prev = d.card.previousElementSibling;
    const next = d.card.nextElementSibling;
    o.onReorder(id, prev ? prev.dataset.id : null, next ? next.dataset.id : null);
  }

  function onCancelEvent(e) {
    if (press) {
      clearTimeout(press.timer);
      press = null;
    }
    if (!drag || e.pointerId !== drag.pointerId) return;
    cancel();
  }

  return {
    /** Az önce sürükleme/uzun basma olduysa true: ardından gelen "click" yok sayılmalı. */
    justActed: () => performance.now() < suppressUntil,
    isDragging: () => !!drag,
    cancel,
  };
}
