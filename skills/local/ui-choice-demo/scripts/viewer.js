/* Click-to-open image viewer that demo.py adds to every published page (inlined at publish time). */
(function () {
  if (window.__demoViewer) return;
  window.__demoViewer = true;

  var MIN_SHOWN = 40;        // images smaller than this on both sides are icons, not content
  var MOUSE_STEP = 1.2;      // zoom per mouse-wheel notch
  var PINCH_RATE = 0.01;     // trackpad pinch: scale = exp(-deltaY * PINCH_RATE), so it follows the fingers
  var TAP_SLOP = 6;          // px a pointer may move and still count as a tap
  var CSS =
    ':host{all:initial}' +
    '.root{outline:0;position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.96);overflow:hidden;' +
    'touch-action:none;overscroll-behavior:contain;-webkit-user-select:none;user-select:none;' +
    'font:18px/1 system-ui,-apple-system,sans-serif}' +
    '.stage{position:absolute;inset:0;cursor:grab}.stage.drag{cursor:grabbing}' +
    'img{position:absolute;left:0;top:0;max-width:none;max-height:none;margin:0;padding:0;border:0;' +
    'pointer-events:none;-webkit-user-drag:none}' +
    'button{position:absolute;width:48px;height:48px;border:1px solid rgba(255,255,255,.4);border-radius:50%;' +
    'background:rgba(30,30,30,.75);color:#fff;font:inherit;font-size:24px;cursor:pointer;padding:0;touch-action:manipulation}' +
    'button:hover{background:rgba(70,70,70,.9)}button:focus-visible{outline:3px solid #7aa2ff;outline-offset:2px}' +
    '.close{top:max(12px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right))}' +
    '.zin,.zout{bottom:max(16px,env(safe-area-inset-bottom))}' +
    '.zout{left:calc(50% - 56px)}.zin{left:calc(50% + 8px)}';

  var host, shadow, root, stage, pic, state = null, lastFocus = null, prevOverflow = '';
  var pointers = new Map(), pinch = null, drag = null, tapStart = null, lastTap = null;
  var padUntil = 0, gesture = null, closedAt = 0;

  function box() { return root.getBoundingClientRect(); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function size() { return { w: state.nw * state.s, h: state.nh * state.s }; }

  // Keep the picture on screen: centred when smaller than the window, edge-bound when larger.
  function place() {
    var b = box(), z = size();
    state.x = z.w <= b.width ? (b.width - z.w) / 2 : clamp(state.x, b.width - z.w, 0);
    state.y = z.h <= b.height ? (b.height - z.h) / 2 : clamp(state.y, b.height - z.h, 0);
    pic.style.width = z.w + 'px';
    pic.style.height = z.h + 'px';
    pic.style.left = state.x + 'px';
    pic.style.top = state.y + 'px';
  }

  function fitScale() {
    var b = box();
    return Math.min(b.width / state.nw, b.height / state.nh);
  }

  // Zoom to scale `s`, keeping the image point under (cx, cy) where it is.
  function zoomAt(s, cx, cy) {
    s = clamp(s, state.min, state.max);
    var k = s / state.s;
    state.x = cx - (cx - state.x) * k;
    state.y = cy - (cy - state.y) * k;
    state.s = s;
    place();
  }

  function centre() { var b = box(); return { x: b.width / 2, y: b.height / 2 }; }
  function reset() { state.s = state.min; place(); }

  function toggleZoom(cx, cy) {
    if (state.s > state.min * 1.05) reset();
    else zoomAt(Math.max(1, state.min * 2.5), cx, cy);
  }

  function build() {
    host = document.createElement('div');
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' + CSS + '</style>' +
      '<div class="root" tabindex="-1" role="dialog" aria-modal="true" aria-label="圖片檢視">' +
      '<div class="stage"><img alt=""></div>' +
      '<button class="close" type="button" aria-label="關閉">✕</button>' +
      '<button class="zout" type="button" aria-label="縮小">−</button>' +
      '<button class="zin" type="button" aria-label="放大">+</button></div>';
    root = shadow.querySelector('.root');
    stage = shadow.querySelector('.stage');
    pic = shadow.querySelector('img');
    shadow.querySelector('.close').onclick = close;
    shadow.querySelector('.zin').onclick = function () { var c = centre(); zoomAt(state.s * MOUSE_STEP, c.x, c.y); };
    shadow.querySelector('.zout').onclick = function () { var c = centre(); zoomAt(state.s / MOUSE_STEP, c.x, c.y); };
    root.addEventListener('wheel', onWheel, { passive: false });
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (n) {
      root.addEventListener(n, onGesture, { passive: false });
    });
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    root.addEventListener('keydown', onKey);
  }

  // A mouse wheel sends big whole-number steps; a trackpad two-finger swipe sends small or fractional
  // ones that arrive as a stream. Once a stream starts it stays a swipe until it pauses, so a fast
  // flick is never mistaken for a wheel notch.
  function isNotch(e) {
    if (e.deltaMode !== 0) return true;
    if (Date.now() < padUntil) return false;
    return e.deltaX === 0 && Math.abs(e.deltaY) >= 50;  // display scaling makes wheel steps fractional, e.g. 66.67
  }

  function onWheel(e) {
    e.preventDefault();
    if (!state) return;
    var notch = isNotch(e);
    if (!notch) padUntil = Date.now() + 250;
    if (e.ctrlKey || notch) {
      var f = notch ? Math.pow(MOUSE_STEP, e.deltaY < 0 ? 1 : -1) : Math.exp(-e.deltaY * PINCH_RATE);
      zoomAt(state.s * f, e.clientX, e.clientY);
      return;
    }
    state.x -= e.deltaX;
    state.y -= e.deltaY;
    place();
  }

  // Safari on Mac sends gesture events for a trackpad pinch and zooms the whole page unless stopped.
  // On touch screens the pointer code handles the pinch, so gestures only block the page zoom there.
  function onGesture(e) {
    e.preventDefault();
    if (!state) return;
    if (e.type === 'gesturestart') {
      var c = centre();
      gesture = { s: state.s, cx: isFinite(e.clientX) ? e.clientX : c.x, cy: isFinite(e.clientY) ? e.clientY : c.y };
    } else if (e.type === 'gesturechange' && gesture && pointers.size < 2) {
      zoomAt(gesture.s * e.scale, gesture.cx, gesture.cy);
    } else if (e.type === 'gestureend') {
      gesture = null;
    }
  }

  function rebase() {
    var pts = Array.from(pointers.values());
    pinch = drag = null;
    if (pts.length >= 2) {
      var a = pts[0], b = pts[1], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: state.s,
                ix: (mx - state.x) / state.s, iy: (my - state.y) / state.s };
    } else if (pts.length === 1) {
      drag = { px: pts[0].x, py: pts[0].y, x: state.x, y: state.y };
    }
  }

  function onPicture(x, y) {
    var r = pic.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function onDown(e) {
    if (!state || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) tapStart = { x: e.clientX, y: e.clientY, bg: !onPicture(e.clientX, e.clientY), moved: false };
    else if (tapStart) tapStart.moved = true;
    stage.classList.add('drag');
    rebase();
  }

  function onMove(e) {
    var p = pointers.get(e.pointerId);
    if (!p || !state) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (tapStart && Math.hypot(p.x - tapStart.x, p.y - tapStart.y) > TAP_SLOP) tapStart.moved = true;
    if (pinch && pointers.size >= 2) {
      var pts = Array.from(pointers.values()), a = pts[0], b = pts[1];
      var s = clamp(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, state.min, state.max);
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      state.s = s;
      state.x = mx - pinch.ix * s;
      state.y = my - pinch.iy * s;
      place();
    } else if (drag) {
      state.x = drag.x + (p.x - drag.px);
      state.y = drag.y + (p.y - drag.py);
      place();
    }
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    var p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    var wasTap = tapStart && !tapStart.moved && pointers.size === 0 && e.type === 'pointerup';
    if (pointers.size === 0) stage.classList.remove('drag');
    rebase();
    if (!wasTap) return;
    var bg = tapStart.bg;
    tapStart = null;
    if (bg) { close(); return; }
    var now = Date.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
      lastTap = null;
      toggleZoom(p.x, p.y);
    } else {
      lastTap = { t: now, x: p.x, y: p.y };
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === '+' || e.key === '=') { var c = centre(); zoomAt(state.s * MOUSE_STEP, c.x, c.y); }
    else if (e.key === '-' || e.key === '_') { var d = centre(); zoomAt(state.s / MOUSE_STEP, d.x, d.y); }
    else if (e.key === '0') reset();
    else if (e.key === 'Tab') {
      var btns = Array.from(shadow.querySelectorAll('button')), i = btns.indexOf(shadow.activeElement);
      e.preventDefault();
      btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
    }
  }

  function onResize() {
    if (!state) return;
    var wasFit = state.s <= state.min * 1.001;
    var fit = fitScale();
    state.min = Math.min(fit, state.base);
    state.max = Math.max(8, state.min * 8);
    if (wasFit) state.s = state.min;
    state.s = clamp(state.s, state.min, state.max);
    place();
  }

  function blockPageZoom(e) { e.preventDefault(); }

  function open(img) {
    var r = img.getBoundingClientRect();
    var nw = img.naturalWidth || r.width, nh = img.naturalHeight || r.height;
    if (!host) build();
    state = { nw: nw, nh: nh, s: 1, x: 0, y: 0, base: 1, min: 1, max: 8 };
    pic.src = img.currentSrc || img.src;
    document.documentElement.appendChild(host);
    ['gesturestart', 'gesturechange'].forEach(function (n) { document.addEventListener(n, blockPageZoom, { passive: false }); });
    var fit = fitScale();
    // Fit the whole picture, but never blow a small one up past the size it had on the page.
    state.base = Math.max(1, r.width / nw);
    state.min = Math.min(fit, state.base);
    state.max = Math.max(8, state.min * 8);
    state.s = state.min;
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    lastFocus = document.activeElement;
    place();
    root.focus();
  }

  function close() {
    if (!state) return;
    state = null; pointers.clear(); pinch = drag = tapStart = lastTap = gesture = null;
    host.remove();
    closedAt = Date.now();
    ['gesturestart', 'gesturechange'].forEach(function (n) { document.removeEventListener(n, blockPageZoom); });
    document.documentElement.style.overflow = prevOverflow;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  function eligible(img) {
    if (!img || img.tagName !== 'IMG' || !(img.currentSrc || img.src)) return false;
    if (img.closest('a[href],button,label,[data-no-zoom]')) return false;
    var r = img.getBoundingClientRect();
    if (r.width < MIN_SHOWN && r.height < MIN_SHOWN) return false;
    return img.complete ? img.naturalWidth > 0 || r.width > 0 : false;
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || state || Date.now() - closedAt < 400) return;  // the tap that closed must not hit the page below
    var t = e.target;
    if (eligible(t)) open(t);
  });
  addEventListener('resize', onResize);
})();
