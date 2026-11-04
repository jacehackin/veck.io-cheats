// ==UserScript==
// @name         Veck.io Auto-Trainer v9
// @namespace    venice.ai
// @version      9.3.0
// @description  ESP + aimbot + ammo freeze + fly for veck.io. Cold boot — everything off. Alt+F fly, Alt+X pause, Alt+G auto-win, Alt+D diag, Alt+C arm.
// @author       Venice
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__vck) return;
  window.__vck = 1;

  const ERR = (window.__vckErr = []);
  const pushErr = m => { ERR.push(String(m)); if (ERR.length > 200) ERR.shift(); };
  const safeLog = (t, e) => { try { console.log('%c[veck]', 'color:#0fa', t, (e && e.message) || e || ''); } catch (_) {} };
  const log = (t, e) => safeLog(t, e);
  const safe = (f, t) => {
    try { return f(); }
    catch (e) { pushErr(t + ': ' + ((e && e.message) || e)); safeLog(t, e); }
  };

  let ui = null;
  const say = t => { if (ui) ui.status(t); };

  safe(() => addEventListener('error', ev => pushErr('win: ' + ((ev.message) || 'err'))), 'onerr');
  safe(() => addEventListener('unhandledrejection', ev => pushErr('rej: ' + ((ev.reason && ev.reason.message) || ev.reason))), 'onrej');

  /* ------------------------------------------------------------------ */
  /* DEFAULTS — every gameplay feature is OFF. Nothing auto-arms.       */
  /* ------------------------------------------------------------------ */
  const D = {
    /* master + modes — all false on cold boot */
    master: false, autoWin: false, paused: false,
    esp: false, aimbot: false, ammo: false, autoAmmo: false,
    aimOnlyFiring: true,          /* if aim is enabled, only hands-on */
    plates: true, bodies: true,   /* sub-detectors — gated by esp anyway */
    anyColor: false,              /* most false-positive prone — off */
    hudSuppress: true, matchOnly: true,
    fly: false, flyMode: 'hop', flySpeed: 0.35,
    /* tuning */
    fov: 420, smooth: 2.5, sens: 1, gate: 26, stick: 130, maxStep: 70,
    tol: 60, minBlob: 4, fps: 24, renderFps: 60, readCap: 1000,
    colors: ['#ff0044', '#00e5ff'], colorsOn: [true, true],
    lockColors: true,             /* true = don't auto-learn; user clicks "+" or "Auto colors" */
    ignoreHud: true,
    capMode: 'auto', aimEvent: 'both', invX: 1, invY: 1,
    showPreview: false, showDiag: false
  };
  let CFG = Object.assign({}, D, { colors: D.colors.slice(), colorsOn: D.colorsOn.slice() });
  safe(() => {
    const s = JSON.parse(localStorage.getItem('veck_v9') || '{}');
    for (const k in s) {
      if (!(k in D)) continue;
      const dv = D[k], sv = s[k];
      if (Array.isArray(dv)) { if (Array.isArray(sv)) CFG[k] = dv.map((x, i) => (typeof sv[i] === typeof x ? sv[i] : x)); }
      else if (typeof dv === 'number') { if (typeof sv === 'number' && isFinite(sv)) CFG[k] = sv; }
      else if (typeof dv === 'boolean') { if (typeof sv === 'boolean') CFG[k] = sv; }
      else if (typeof dv === 'string') { if (typeof sv === 'string') CFG[k] = sv; }
    }
  });
  /* NO forced overrides. No CFG.master = true. No CFG.autoWin = true. */
  CFG.fps = Math.max(1, Math.min(120, CFG.fps || 24));
  CFG.readCap = Math.max(320, Math.min(2400, CFG.readCap || 1000));
  const save = () => safe(() => localStorage.setItem('veck_v9', JSON.stringify(CFG)));

  const CAP_W = 288;
  let CAP_H = 162;
  let reg = { fx: 0, fy: 0, fw: 1, fh: 1 };

  /* ---------- activation ---------- */
  const KNOWN = ['veck.io','veckio.io','veckio.com','veckio.net','crazygames.com','poki.com','poki.ink','poki-gdn.com','igre.games','hotgames.io','kizgame.com','zapgames.io','ozogames.com','miniplay.com','y8.com','gamedistribution.com'];
  const hostHit = KNOWN.some(k => location.hostname.endsWith(k));
  const deadline = Date.now() + (hostHit || /veck/i.test(location.hostname) ? 1e7 : 6e4);

  let BOOTED = false, booted = false, detectTimer = null;
  const rootEl = () => document.documentElement || document.body;

  function pickCanvas() {
    const u = document.querySelector('#unity-canvas');
    if (u && u.isConnected) return u;
    const m = window.unityInstance && (window.unityInstance.Module || window.unityInstance.module);
    if (m && m.canvas && m.canvas.isConnected) return m.canvas;
    let best = null, area = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const a = (c.clientWidth || 0) * (c.clientHeight || 0);
      if (a > area) { area = a; best = c; }
    }
    return area > 6000 ? best : null;
  }
  function startDetect() {
    if (detectTimer) clearInterval(detectTimer);
    detectTimer = setInterval(() => {
      if (BOOTED || Date.now() > deadline) { clearInterval(detectTimer); return; }
      tryActivate();
    }, 300);
  }
  function tryActivate() {
    if (BOOTED) return;
    const c = pickCanvas();
    if (!c) return;
    if ((c.clientWidth || 0) < 60 || (c.clientHeight || 0) < 40) return;
    if (!rootEl()) return;
    BOOTED = true;
    try { boot(); log('booted-cold'); }
    catch (e) { BOOTED = false; booted = false; pushErr('boot: ' + ((e && e.message) || e)); log('boot-fail', e); startDetect(); }
  }
  startDetect();
  safe(() => document.addEventListener('DOMContentLoaded', tryActivate), 'dcl');
  safe(() => addEventListener('load', tryActivate), 'load');

  /* ---------- hooks ---------- */
  let gameCanvas = null, gl = null, ctxLost = false;
  let hooked = false, hookFrame = null, hookT = 0, lastCaptureAt = 0, lastPostRaf = performance.now();
  const CTX = new WeakMap();

  safe(() => {
    const raf = window.requestAnimationFrame;
    if (!raf) return;
    window.requestAnimationFrame = function (cb) {
      if (typeof cb !== 'function') return raf.call(window, cb);
      return raf.call(window, function (t) {
        try { return cb(t); }
        finally { lastPostRaf = performance.now(); safe(onFrameEnd, 'postraf'); }
      });
    };
  }, 'rafhook');

  safe(() => {
    const g = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (t, ...r) {
      const ctx = g.call(this, t, ...r);
      try {
        if (ctx && /webgl/i.test(t)) {
          const isUnity = this.id === 'unity-canvas';
          const area = (this.clientWidth || 0) * (this.clientHeight || 0);
          const gArea = gameCanvas ? (gameCanvas.clientWidth || 0) * (gameCanvas.clientHeight || 0) : 0;
          if (!gameCanvas || isUnity || area > gArea) {
            if (this !== gameCanvas) { hooked = false; hookFrame = null; }
            gameCanvas = this; gl = ctx;
            this.addEventListener('webglcontextlost', () => { ctxLost = true; });
            this.addEventListener('webglcontextrestored', () => { ctxLost = false; hooked = false; hookFrame = null; });
            setTimeout(tryActivate, 0);
          }
          if (!ctx.__vck) {
            ctx.__vck = 1;
            const st = { fb: true };
            CTX.set(ctx, st);
            const bf = ctx.bindFramebuffer;
            if (bf) ctx.bindFramebuffer = function (tgt, fb) {
              try {
                const F = this.FRAMEBUFFER, RF = this.READ_FRAMEBUFFER, DF = this.DRAW_FRAMEBUFFER;
                if (tgt === F || tgt === DF || tgt === RF) st.fb = (fb == null);
              } catch (e) {}
              return bf.apply(this, arguments);
            };
            const cl = ctx.clear;
            if (cl) ctx.clear = function (...a) {
              try { if (this === gl && CTX.get(this) && CTX.get(this).fb) onFrameEnd(); } catch (e) {}
              return cl.apply(this, a);
            };
          }
        }
      } catch (e) {}
      return ctx;
    };
  }, 'getContext');

  /* ---------- heap ---------- */
  const MEM = { src: null, buf: null, i32: null, f32: null, hits: [], val: 0, frozen: false };
  function setMem(m) { try { if (m && m.buffer && m.buffer.byteLength > 4e6) { MEM.src = m; MEM.buf = m.buffer; } } catch (e) {} }
  function refreshMem() {
    try {
      if (MEM.src && MEM.src.memory && MEM.src.memory.buffer) return (MEM.buf = MEM.src.memory.buffer);
      if (MEM.src && MEM.src.buffer) return (MEM.buf = MEM.src.buffer);
    } catch (e) {}
    return MEM.buf;
  }
  function heap() {
    const b = refreshMem();
    if (!b || b.byteLength < 4e6) return null;
    if (!MEM.i32 || MEM.i32.buffer !== b) { try { MEM.i32 = new Int32Array(b); } catch (e) { return null; } }
    return MEM.i32;
  }
  function heapF() {
    const b = refreshMem();
    if (!b || b.byteLength < 4e6) return null;
    if (!MEM.f32 || MEM.f32.buffer !== b) { try { MEM.f32 = new Float32Array(b); } catch (e) { return null; } }
    return MEM.f32;
  }
  safe(() => {
    for (const n of ['instantiate', 'instantiateStreaming']) {
      const o = WebAssembly[n]; if (!o) continue;
      WebAssembly[n] = function (...a) {
        const r = o.apply(this, a);
        if (r && r.then) return r.then(x => { setMem(x && x.instance && x.instance.exports.memory); return x; });
        setMem(r && r.instance && r.instance.exports.memory);
        return r;
      };
    }
    const I = WebAssembly.Instance;
    WebAssembly.Instance = function (m, i) { const x = new I(m, i); setMem(x.exports && x.exports.memory); return x; };
    WebAssembly.Instance.prototype = I.prototype;
  }, 'wasm');
  safe(() => {
    let cui;
    Object.defineProperty(window, 'createUnityInstance', {
      configurable: true, get: () => cui,
      set(v) {
        cui = function (...a) {
          try {
            const c = a[1] || {};
            if (/veck/i.test((c.productName || '') + (c.dataUrl || '')) || location.hostname.endsWith('veck.io')) setTimeout(tryActivate, 0);
          } catch (e) {}
          return v.apply(this, a);
        };
      }
    });
  }, 'cui');
  const memProbe = setInterval(() => {
    safe(() => {
      const u = window.unityInstance, m = u && (u.Module || u.module);
      if (m) {
        setMem(m.HEAPU8 ? { get buffer() { return m.HEAPU8.buffer; } } : m);
        if (m.canvas && m.canvas.isConnected && m.canvas !== gameCanvas) { gameCanvas = m.canvas; setTimeout(tryActivate, 0); }
      }
    }, 'memprobe');
    if (MEM.src && booted) clearInterval(memProbe);
  }, 1000);

  /* ---------- state ---------- */
  let overlay, oCtx, cap, capCtx, pixBuf, pixImg, prev, prevS, lastGood = null;
  let blobs = [], targetKey = null, tRaw = 1e9, tSince = 0, tLast = 0, lastSide = 0, gain = 1, lastGap = 1e9, probe = 0;
  let realFire = false, autoFireOn = false, entered = false, holdCount = 0;
  let pickArmed = false, pickIdx = 0, lastHop = 0, upHeld = false, downHeld = false;
  let lastCap = 0, fpsAcc = 0, fpsN = 0, rc = null, diagT = 0, lastPrev = 0, lastRender = 0;
  let virtX = innerWidth / 2, virtY = innerHeight / 2;
  const SCORE = { raf: 1, pixels: 1, hook: 1 };
  const HIST = new Float32Array(24), STATIC = new Float32Array(24);
  let lastCal = 0, moved = 0, lastMove = 0, lastSrc = '-';
  let frameCanvas = null, fctx = null, pvCtx = null;
  let sGrid = null, sW = 0, sH = 0, sMotion = 0;

  const hex2rgb = h => { const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h || ''); return m ? [+('0x' + m[1]), +('0x' + m[2]), +('0x' + m[3])] : [255, 255, 255]; };
  function hsvHex(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, k = Math.floor(h / 60) % 6;
    let r, g, b;
    if (k === 0) { r = c; g = x; b = 0; } else if (k === 1) { r = x; g = c; b = 0; }
    else if (k === 2) { r = 0; g = c; b = x; } else if (k === 3) { r = 0; g = x; b = c; }
    else if (k === 4) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
    const f = n => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return '#' + f(r) + f(g) + f(b);
  }

  /* ---------- buffers ---------- */
  function initBuffers() {
    if (!cap) {
      cap = document.createElement('canvas');
      capCtx = cap.getContext('2d', { willReadFrequently: true });
    }
    cap.width = CAP_W; cap.height = CAP_H;
    if (!overlay) {
      overlay = document.createElement('canvas');
      Object.assign(overlay.style, { position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 2147482900 });
      addEventListener('resize', resize);
      new MutationObserver(() => { if (overlay && !overlay.isConnected && rootEl()) rootEl().appendChild(overlay); })
        .observe(document, { childList: true, subtree: false });
    }
    if (!oCtx) oCtx = overlay.getContext('2d');
    if (overlay.parentNode !== rootEl()) rootEl().appendChild(overlay);
    resize();
  }
  function resize() {
    if (!overlay) return;
    overlay.width = Math.max(1, innerWidth); overlay.height = Math.max(1, innerHeight);
    CAP_H = Math.max(54, Math.round(CAP_W * (innerHeight / Math.max(1, innerWidth))));
    if (cap) cap.height = CAP_H;
    prev = null; prevS = null; sGrid = null; sMotion = 0; rc = null;
    frameCanvas = null; fctx = null; pixImg = null; pvCtx = null;
    recenterCursor();
    if (ui) { const pv = ui.$('prev'); if (pv) { pv.width = CAP_W; pv.height = CAP_H; } }
  }
  function recenterCursor() {
    const c = gameCanvas;
    if (c) {
      const r = c.getBoundingClientRect();
      virtX = r.left + r.width / 2; virtY = r.top + r.height / 2;
    } else { virtX = innerWidth / 2; virtY = innerHeight / 2; }
  }
  function liveCanvas() {
    const u = document.querySelector('#unity-canvas');
    if (u && u.isConnected && u !== gameCanvas) {
      gameCanvas = u; hooked = false; hookFrame = null;
      gl = null;
      safe(() => { gl = u.getContext('webgl2') || u.getContext('webgl'); });
    }
    if (gameCanvas && gameCanvas.isConnected) return gameCanvas;
    const c = pickCanvas();
    if (c) {
      gameCanvas = c; hooked = false; hookFrame = null; gl = null;
      safe(() => { gl = c.getContext('webgl2') || c.getContext('webgl'); });
      recenterCursor();
    }
    return gameCanvas;
  }

  /* ---------- capture ---------- */
  const bright = d => { let s = 0, n = 0; for (let i = 0; i < d.length; i += 4 * 53) { s += d[i] + d[i + 1] + d[i + 2]; n++; } return n ? s / n : 0; };
  const DARK = 22;
  function bump(k, b) { SCORE[k] = SCORE[k] * 0.7 + b * 0.3; for (const o in SCORE) if (o !== k) SCORE[o] *= 0.93; }

  function readPixelsInto() {
    if (!gl || !gameCanvas || !capCtx) return null;
    const dw = gl.drawingBufferWidth, dh = gl.drawingBufferHeight;
    if (!dw || !dh) return null;
    const cw = gameCanvas.clientWidth || dw;
    const scale = dw / Math.max(1, cw);
    const minDim = Math.min(dw, dh);
    const want = Math.max(64, Math.min(minDim, CFG.readCap, Math.max(CFG.fov * scale, minDim * 0.55)));
    const half = want / 2;
    const rw = Math.max(8, Math.floor(Math.min(half * 2, dw)));
    const rh = Math.max(8, Math.floor(Math.min(half * 2, dh)));
    const px = Math.max(0, Math.floor((dw - rw) / 2));
    const py = Math.max(0, Math.floor((dh - rh) / 2));

    if (!pixBuf || pixBuf.length !== rw * rh * 4) pixBuf = new Uint8Array(rw * rh * 4);
    gl.readPixels(px, py, rw, rh, gl.RGBA, gl.UNSIGNED_BYTE, pixBuf);

    if (!pixImg || pixImg.width !== CAP_W || pixImg.height !== CAP_H) pixImg = capCtx.createImageData(CAP_W, CAP_H);
    const img = pixImg, data = img.data;
    const sx = rw / CAP_W, sy = rh / CAP_H;
    for (let y = 0; y < CAP_H; y++) {
      const row = (rh - 1 - Math.min(rh - 1, (y * sy) | 0)) * rw * 4;
      for (let x = 0; x < CAP_W; x++) {
        const s = row + Math.min(rw - 1, (x * sx) | 0) * 4, d = (y * CAP_W + x) * 4;
        data[d] = pixBuf[s]; data[d + 1] = pixBuf[s + 1]; data[d + 2] = pixBuf[s + 2]; data[d + 3] = 255;
      }
    }
    reg = { fx: px / dw, fy: (dh - py - rh) / dh, fw: rw / dw, fh: rh / dh };
    return img;
  }
  function onFrameEnd() {
    const now = performance.now();
    if (now - lastCaptureAt < 1000 / CFG.fps) return;
    if (!gl || !gameCanvas) return;
    const st = CTX.get(gl);
    if (st && !st.fb) return;
    lastCaptureAt = now;
    const img = safe(readPixelsInto, 'rpf');
    if (!img) return;
    const b = bright(img.data);
    if (b > DARK) { hookFrame = img; hookT = now; hooked = true; bump('hook', b); }
    else SCORE.hook *= 0.9;
  }
  function tryRaf() {
    const c = liveCanvas(); if (!c || !capCtx) return null;
    const i = safe(() => { capCtx.drawImage(c, 0, 0, CAP_W, CAP_H); return capCtx.getImageData(0, 0, CAP_W, CAP_H); }, 'raf');
    if (!i) return null;
    const b = bright(i.data);
    if (b <= DARK) return null;
    reg = { fx: 0, fy: 0, fw: 1, fh: 1 };
    bump('raf', b); return i;
  }
  function tryPx() {
    if (!gl) return null;
    const st = CTX.get(gl);
    if (st && !st.fb) return null;
    const p = safe(readPixelsInto, 'px');
    if (!p) return null;
    const b = bright(p.data);
    if (b <= DARK) return null;
    bump('pixels', b); return p;
  }
  function grab() {
    if (!liveCanvas() || ctxLost) return lastGood;
    if (CFG.capMode !== 'raf' && hooked && hookFrame && performance.now() - hookT < 250) {
      lastSrc = 'hook'; lastGood = hookFrame; return hookFrame;
    }
    let r = null, tag = '';
    if (CFG.capMode === 'pixels') { r = tryPx(); tag = 'px'; }
    else if (CFG.capMode === 'raf') { r = tryRaf(); tag = 'raf'; }
    else if (SCORE.raf >= SCORE.pixels) { r = tryRaf() || tryPx(); tag = r ? 'raf' : 'px'; }
    else { r = tryPx() || tryRaf(); tag = r ? 'px' : 'raf'; }
    if (r) { lastSrc = tag; lastGood = r; return r; }
    lastSrc = 'stale';
    return lastGood;
  }

  /* ---------- static map ---------- */
  function updateStatic(img) {
    const d = img.data, w = img.width, h = img.height;
    const gw = Math.ceil(w / 2), gh = Math.ceil(h / 2);
    if (!sGrid || sW !== gw || sH !== gh) { sGrid = new Uint8Array(gw * gh); sW = gw; sH = gh; prevS = null; sMotion = 0; }
    if (!prevS || prevS.length !== d.length) { prevS = new Uint8ClampedArray(d.length); prevS.set(d); return; }
    let mot = 0;
    for (let y = 0; y < h; y += 2) {
      const row = (y / 2) | 0;
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) << 2;
        const dl = Math.abs(d[i] - prevS[i]) + Math.abs(d[i + 1] - prevS[i + 1]) + Math.abs(d[i + 2] - prevS[i + 2]);
        const c = row * gw + ((x / 2) | 0);
        if (dl < 10) { if (sGrid[c] < 255) sGrid[c]++; } else { sGrid[c] = 0; mot++; }
      }
    }
    sMotion = mot;
    prevS.set(d);
  }

  /* ---------- colour learning (only runs when lockColors is false) ---------- */
  function calibrate(img) {
    const d = img.data;
    if (!prev || prev.length !== d.length) { prev = new Uint8ClampedArray(d.length); prev.set(d); return; }
    moved = 0;
    for (let i = 0; i < d.length; i += 8) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const dl0 = Math.abs(r - prev[i]) + Math.abs(g - prev[i + 1]) + Math.abs(b - prev[i + 2]);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx - mn;
      if (sat > 48 && mx > 105) {
        let h = mx === r ? ((g - b) / sat) % 6 : mx === g ? (b - r) / sat + 2 : (r - g) / sat + 4;
        h *= 60; if (h < 0) h += 360;
        const bin = (h / 15) | 0;
        if (dl0 > 74) { HIST[bin] += 1; moved++; } else if ((i >> 2) % 7 === 0) STATIC[bin] += 0.35;
      }
    }
    prev.set(d);
    if (moved > 8) lastMove = performance.now();
    const now = performance.now();
    if (now - lastCal < 1400) return;
    lastCal = now;
    for (let i = 0; i < 24; i++) { HIST[i] *= 0.82; STATIC[i] *= 0.9; }
    const src = (now - lastMove > 4000) ? STATIC : HIST;
    const idx = [...src.keys()].sort((a, b) => src[b] - src[a]);
    let slot = 0;
    for (let k = 0; k < idx.length && slot < 2; k++) {
      if (src[idx[k]] < 5) break;
      if (slot === 1 && Math.abs(idx[k] - idx[0]) <= 1) continue;
      CFG.colors[slot] = hsvHex(idx[k] * 15 + 7.5, 0.88, 1);
      slot++;
    }
    if (slot && ui) ui.sync();
  }

  /* ---------- detection ---------- */
  const CELL = 4, PC = 2;

  function cluster(occ, gw, gh, test) {
    const out = [], seen = new Uint8Array(gw * gh), st = [];
    for (let i = 0; i < occ.length; i++) {
      if (!occ[i] || seen[i]) continue;
      st.length = 0; st.push(i); seen[i] = 1;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
      while (st.length) {
        const c = st.pop(), cx = c % gw, cy = (c / gw) | 0; n++;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const ni = ny * gw + nx;
          if (occ[ni] && !seen[ni]) { seen[ni] = 1; st.push(ni); }
        }
      }
      const b = { x0, y0, x1, y1, n };
      if (test(b)) out.push(b);
      if (out.length > 40) break;
    }
    return out;
  }

  function staticFrac(x0, y0, x1, y1) {
    if (!sGrid || !CFG.hudSuppress || sMotion < 150) return 0;
    let st = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= sW || y >= sH) continue;
      n++; if (sGrid[y * sW + x] > 22) st++;
    }
    return n ? st / n : 0;
  }

  function plates(img) {
    const w = img.width, h = img.height, d = img.data;
    const gw = Math.ceil(w / PC), gh = Math.ceil(h / PC);
    const occ = new Uint8Array(gw * gh);
    const y0 = Math.floor(h * 0.06), y1 = Math.floor(h * (CFG.ignoreHud ? 0.9 : 0.99));
    for (let y = y0; y < y1; y++) {
      const row = (y / PC) | 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) << 2, r = d[i], g = d[i + 1], b = d[i + 2];
        const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
        if (mn > 145 && mx - mn < 50) occ[row * gw + ((x / PC) | 0)] = 1;
      }
    }
    return cluster(occ, gw, gh, b => {
      const bw = (b.x1 - b.x0 + 1) * PC, bh = (b.y1 - b.y0 + 1) * PC;
      if (bh > 20 || bh < 2 || bw < 8 || bw > 150) return false;
      if (b.n * PC * PC / Math.max(1, bw * bh) <= 0.18) return false;
      if (staticFrac(b.x0, b.y0, b.x1, b.y1) > 0.7) return false;
      return true;
    }).map(b => ({ x: b.x0 * PC, y: b.y0 * PC, w: (b.x1 - b.x0 + 1) * PC, h: (b.y1 - b.y0 + 1) * PC, n: b.n, kind: 'plate' }));
  }

  function bodies(img) {
    const w = img.width, h = img.height, d = img.data;
    const gw = Math.ceil(w / CELL), gh = Math.ceil(h / CELL);
    const occ = new Uint8Array(gw * gh);
    const tg = [];
    for (let i = 0; i < 2; i++) if (CFG.colorsOn[i]) tg.push(hex2rgb(CFG.colors[i]));
    if (!tg.length) return [];
    const tol2 = CFG.tol * CFG.tol, yCut = CFG.ignoreHud ? (h * 0.9) | 0 : h;
    for (let y = 0; y < yCut; y++) {
      const row = (y / CELL) | 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) << 2, r = d[i], g = d[i + 1], b = d[i + 2];
        if (r + g + b < 80) continue;
        for (let k = 0; k < tg.length; k++) {
          const t = tg[k], dr = r - t[0], dg = g - t[1], db = b - t[2];
          if (dr * dr + dg * dg + db * db <= tol2) { occ[row * gw + ((x / CELL) | 0)] = 1; break; }
        }
      }
    }
    return cluster(occ, gw, gh, b => {
      const bw = (b.x1 - b.x0 + 1) * CELL, bh = (b.y1 - b.y0 + 1) * CELL;
      if (b.n < CFG.minBlob || bw > w * 0.55 || bh < CELL * 2 || bh < bw * 0.5) return false;
      return b.n * CELL * CELL / Math.max(1, bw * bh) > 0.1;
    }).map(b => ({ x: b.x0 * CELL, y: b.y0 * CELL, w: (b.x1 - b.x0 + 1) * CELL, h: (b.y1 - b.y0 + 1) * CELL, n: b.n, kind: 'body' }));
  }

  function anyColor(img) {
    const w = img.width, h = img.height, d = img.data;
    const gw = Math.ceil(w / CELL), gh = Math.ceil(h / CELL);
    const occ = new Uint8Array(gw * gh);
    const yCut = CFG.ignoreHud ? (h * 0.9) | 0 : h;
    for (let y = 0; y < yCut; y++) {
      const row = (y / CELL) | 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) << 2, r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx < 118 || mx - mn < 68) continue;
        occ[row * gw + ((x / CELL) | 0)] = 1;
      }
    }
    return cluster(occ, gw, gh, b => {
      const bw = (b.x1 - b.x0 + 1) * CELL, bh = (b.y1 - b.y0 + 1) * CELL;
      if (b.n < CFG.minBlob * 3 || bw > w * 0.6 || bh < CELL * 2 || bh < bw * 0.4) return false;
      return b.n * CELL * CELL / Math.max(1, bw * bh) > 0.12;
    }).map(b => ({ x: b.x0 * CELL, y: b.y0 * CELL, w: (b.x1 - b.x0 + 1) * CELL, h: (b.y1 - b.y0 + 1) * CELL, n: b.n, kind: 'hot' }));
  }

  const keyOf = b => b.kind[0] + ((b.x + b.w / 2) / 12 | 0) + ':' + ((b.y + b.h / 2) / 12 | 0) + ':' + (b.w / 12 | 0);

  function detect(img) {
    const out = [];
    if (CFG.plates) out.push(...plates(img));
    if (CFG.bodies) out.push(...bodies(img));
    if (CFG.anyColor) out.push(...anyColor(img));
    for (const b of out) b.key = keyOf(b);
    const rank = k => (k === 'plate' ? 0 : k === 'hot' ? 1 : 2);
    out.sort((a, b) => rank(a.kind) - rank(b.kind));
    return out.slice(0, 14);
  }

  /* ---------- projection ---------- */
  function rect() {
    if (!rc || rc.t !== lastCap) {
      const r = gameCanvas ? gameCanvas.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      const l = r.left + r.width * reg.fx, t = r.top + r.height * reg.fy;
      rc = { t: lastCap, sx: (r.width * reg.fw) / CAP_W, sy: (r.height * reg.fh) / CAP_H, left: l, top: t };
    }
    return rc;
  }
  const proj = b => { const r = rect(); return { x: r.left + b.x * r.sx, y: r.top + b.y * r.sy, w: b.w * r.sx, h: b.h * r.sy }; };

  /* ---------- render ---------- */
  function render() {
    if (!oCtx) return;
    oCtx.clearRect(0, 0, overlay.width, overlay.height);
    if (!CFG.master) return;
    const cx = innerWidth / 2, cy = innerHeight / 2;

    if (CFG.aimbot && !pickArmed) {
      oCtx.strokeStyle = CFG.paused ? 'rgba(255,204,0,.3)' : 'rgba(0,255,170,.22)';
      oCtx.lineWidth = 1.2;
      oCtx.beginPath(); oCtx.arc(cx, cy, CFG.fov / 2, 0, 6.2832); oCtx.stroke();
    }
    oCtx.fillStyle = 'rgba(0,255,170,.8)';
    oCtx.fillRect(cx - 1, cy - 1, 2, 2);

    if (!lastGood || lastSrc === 'stale') {
      oCtx.fillStyle = 'rgba(255,80,80,.9)';
      oCtx.font = '12px monospace';
      oCtx.fillText('NO FRAME', cx + 14, cy - 14);
    }
    if (CFG.fly && CFG.flyMode === 'hover') {
      oCtx.fillStyle = 'rgba(120,180,255,.9)';
      oCtx.font = '11px monospace';
      oCtx.fillText('FLY', cx + 10, cy - 26);
    }
    if (!CFG.esp) return;

    for (const b of blobs) {
      const s = proj(b), on = b.key === targetKey;
      oCtx.strokeStyle = on ? '#ff006e' : (b.kind === 'plate' ? 'rgba(120,255,220,.85)' : b.kind === 'hot' ? 'rgba(255,214,64,.8)' : 'rgba(255,47,47,.8)');
      oCtx.lineWidth = on ? 2.2 : 1.2;
      if (b.kind === 'plate') {
        const e = 4;
        oCtx.beginPath();
        oCtx.moveTo(s.x - 3, s.y + e); oCtx.lineTo(s.x - 3, s.y - 3); oCtx.lineTo(s.x + e, s.y - 3);
        oCtx.moveTo(s.x + s.w + 3 - e, s.y - 3); oCtx.lineTo(s.x + s.w + 3, s.y - 3); oCtx.lineTo(s.x + s.w + 3, s.y + e);
        oCtx.moveTo(s.x - 3, s.y + s.h + 3 - e); oCtx.lineTo(s.x - 3, s.y + s.h + 3); oCtx.lineTo(s.x + e, s.y + s.h + 3);
        oCtx.moveTo(s.x + s.w + 3 - e, s.y + s.h + 3); oCtx.lineTo(s.x + s.w + 3, s.y + s.h + 3); oCtx.lineTo(s.x + s.w + 3, s.y + s.h + 3 - e);
        oCtx.stroke();
      } else oCtx.strokeRect(s.x - 2, s.y - 2, s.w + 4, s.h + 4);
      oCtx.fillStyle = on ? '#ff006e' : 'rgba(0,255,170,.9)';
      oCtx.fillRect(s.x + s.w / 2 - 2, s.y + (b.kind === 'plate' ? s.h + 5 : s.h * 0.28) - 2, 4, 4);
    }
  }

  /* ---------- input ---------- */
  const tag = ev => { try { ev.__vck = 1; } catch (e) {} return ev; };
  const inputTarget = () => document.pointerLockElement || gameCanvas || document;

  function sendMove(dx, dy) {
    if (!dx && !dy) return;
    const t = inputTarget();
    if (!t) return;
    const r = gameCanvas && gameCanvas.getBoundingClientRect();
    if (r && r.width > 4 && r.height > 4) {
      virtX = Math.min(r.right - 2, Math.max(r.left + 2, virtX + dx));
      virtY = Math.min(r.bottom - 2, Math.max(r.top + 2, virtY + dy));
    } else { virtX += dx; virtY += dy; }
    const mk = T => tag(new MouseEvent(T, {
      bubbles: true, cancelable: true, view: window,
      clientX: virtX, clientY: virtY, screenX: virtX, screenY: virtY,
      movementX: dx, movementY: dy
    }));
    if (CFG.aimEvent !== 'pointer') safe(() => t.dispatchEvent(mk('mousemove')), 'mm');
    if (CFG.aimEvent !== 'mouse') safe(() => t.dispatchEvent(mk('pointermove')), 'pm');
  }
  function sendBtn(d) {
    const t = inputTarget();
    if (!t) return;
    safe(() => t.dispatchEvent(tag(new MouseEvent(d ? 'mousedown' : 'mouseup', { bubbles: true, cancelable: true, view: window, button: 0, buttons: d ? 1 : 0, clientX: virtX, clientY: virtY }))), 'btn');
  }
  function sendKeyEvent(ty, code, key) {
    const t = inputTarget();
    if (!t) return;
    safe(() => t.dispatchEvent(tag(new KeyboardEvent(ty, { bubbles: true, cancelable: true, view: window, code, key }))), 'key');
  }
  function sendKey(code, key) { sendKeyEvent('keydown', code, key); sendKeyEvent('keyup', code, key); }
  function tapKey(code, key) {
    sendKeyEvent('keydown', code, key);
    setTimeout(() => sendKeyEvent('keyup', code, key), 45);
  }

  /* ---------- aim (only runs when master + aimbot are both on) ---------- */
  function aim() {
    const heldKey = targetKey;
    targetKey = null; tRaw = 1e9;
    if (!CFG.master || !CFG.aimbot || CFG.paused || pickArmed) return;
    if (CFG.aimOnlyFiring && !CFG.autoWin && !realFire) return;
    if (!gameCanvas || gameCanvas.clientWidth < 40) return;

    const cx = innerWidth / 2, cy = innerHeight / 2, maxR = CFG.fov / 2;
    let best = null, bestScore = Infinity;
    for (const b of blobs) {
      const s = proj(b);
      const ax = s.x + s.w / 2, ay = s.y + (b.kind === 'plate' ? s.h + 8 : s.h * 0.28);
      const raw = Math.hypot(ax - cx, ay - cy);
      if (raw > maxR) continue;
      let sc = raw;
      if (b.kind === 'plate') { sc *= 0.7; if (s.w > 80) sc *= 1.4; }
      if (b.kind === 'hot') sc *= 1.25;
      if (b.key === heldKey) sc *= 0.55;
      if (sc < bestScore) { bestScore = sc; best = { b, ax, ay, raw }; }
    }
    if (!best) { lastSide = 0; lastGap = 1e9; return; }

    const now = performance.now();
    const side = Math.sign(best.ax - cx) || 1;
    if (lastSide && side !== lastSide && now - tSince < 320) gain = Math.max(0.12, gain * 0.55);
    else gain = Math.min(3.2, gain * 1.04);
    if (!isFinite(gain)) gain = 1;
    lastSide = side;
    if (best.b.key !== heldKey) { tSince = now; recenterCursor(); }
    targetKey = best.b.key; tRaw = best.raw; tLast = now;

    if (tRaw > lastGap - 0.5 && tRaw > 30) {
      probe++;
      if (probe === 8) CFG.aimEvent = CFG.aimEvent === 'mouse' ? 'pointer' : CFG.aimEvent === 'pointer' ? 'both' : 'mouse';
      if (probe === 16) { CFG.invY = -CFG.invY; probe = 0; }
    } else if (tRaw < lastGap) probe = 0;
    lastGap = tRaw;

    let dx = (best.ax - cx) / Math.max(1, CFG.smooth) * CFG.sens * gain * CFG.invX;
    let dy = (best.ay - cy) / Math.max(1, CFG.smooth) * CFG.sens * gain * CFG.invY;
    const m = Math.hypot(dx, dy);
    if (m > CFG.maxStep) { dx = dx / m * CFG.maxStep; dy = dy / m * CFG.maxStep; }
    if (m >= 0.3) sendMove(dx, dy);
  }

  /* ---------- auto fire (only with autoWin; requires match context) ---------- */
  let lastReload = 0;
  function autoFireTick() {
    if (!CFG.autoWin || !CFG.master || CFG.paused) { if (autoFireOn) { autoFireOn = false; sendBtn(false); } return; }

    const h = heap();
    if (h && MEM.hits.length && !autoFireOn && performance.now() - lastReload > 900) {
      const c = h[MEM.hits[0]];
      if (c >= 0 && c < 4) { lastReload = performance.now(); sendKey('KeyR', 'r'); }
    }

    const inMatch = !CFG.matchOnly || entered || !!document.pointerLockElement;
    const ok = inMatch && !!targetKey && tRaw <= CFG.gate && !realFire;
    holdCount = ok ? holdCount + 1 : 0;
    const want = ok && holdCount >= 2;
    if (want === autoFireOn) return;
    autoFireOn = want;
    sendBtn(want);
    if (want) ammoOnFire();
  }

  /* ---------- fly (only escalates when master + fly are on AND in-match) ---------- */
  const FLY = { addr: -1, y: 0, phase: 'idle', t0: 0, n: 0, A: null, B: null, P: null, L: null };

  function flyClear() { FLY.addr = -1; FLY.phase = 'idle'; FLY.A = FLY.B = FLY.P = FLY.L = null; FLY.n = 0; }

  function inMatchNow() { return entered || !!document.pointerLockElement; }

  function flyCalibrate() {
    if (CFG.matchOnly && !inMatchNow()) return say('Refused — click the game first (join a match)');
    const f = heapF();
    if (!f) return say('No heap — join a match first');
    say('Calibrating — now JUMP once, then stand still');
    FLY.A = null; FLY.n = 0;
    const capN = 60000;
    const A = new Int32Array(capN), B = new Float32Array(capN), P = new Float32Array(capN), L = new Float32Array(capN);
    let n = 0;
    for (let i = 0; i < f.length && n < capN; i++) {
      const v = f[i];
      if (!(v > -80 && v < 600) || Math.abs(v) < 0.25) continue;
      A[n] = i; B[n] = v; P[n] = v; L[n] = v; n++;
    }
    if (n < 20) { flyClear(); return say('Too few floats — retry in-match'); }
    FLY.A = A; FLY.B = B; FLY.P = P;FLY.L = L; FLY.n = n;
    FLY.phase = 'sampling'; FLY.t0 = performance.now();
  }

  function flySample() {
    if (FLY.phase !== 'sampling') return;
    const f = heapF();
    if (!f) return;
    for (let i = 0; i < FLY.n; i++) {
      const idx = FLY.A[i];
      if (idx >= f.length) continue;
      const v = f[idx];
      if (typeof v !== 'number' || !isFinite(v)) continue;
      if (v > FLY.P[i]) FLY.P[i] = v;
      FLY.L[i] = v;
    }
    if (performance.now() - FLY.t0 < 2600) return;

    let best = -1, bestScore = 0;
    for (let i = 0; i < FLY.n; i++) {
      const rise = FLY.P[i] - FLY.B[i];
      if (!isFinite(rise) || rise < 0.3 || rise > 40) continue;
      const err = Math.abs(FLY.L[i] - FLY.B[i]);
      if (!isFinite(err) || err > 1.5) continue;
      const score = rise - err * 1.4;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    FLY.phase = 'idle';
    if (best < 0) { flyClear(); return say('No Y found — jump higher, retry'); }
    FLY.addr = FLY.A[best] * 4;
    FLY.y = isFinite(FLY.L[best]) ? FLY.L[best] : 0;
    say(`Fly ready (score ${bestScore.toFixed(2)})`);
    if (ui) ui.sync();
  }

  function flyTick() {
    if (!CFG.master || !CFG.fly || CFG.paused) return;
    if (CFG.matchOnly && !inMatchNow()) return;
    if (CFG.flyMode === 'hop') {
      const now = performance.now();
      if (now - lastHop > 70) { lastHop = now; tapKey('Space', ' '); }
      return;
    }
    if (FLY.addr < 0) return;
    const f = heapF();
    if (!f) return;
    const i = FLY.addr >> 2;
    if (i < 0 || i >= f.length) return;
    if (!isFinite(FLY.y)) FLY.y = 0;
    if (upHeld) FLY.y += CFG.flySpeed;
    if (downHeld) FLY.y -= CFG.flySpeed;
    f[i] = FLY.y;
  }

  /* ---------- ammo (gated by master + autoAmmo; primary trigger is real click) ---------- */
  const AM = { phase: 'idle', cand: [], fires: 0, cool: 0, done: false };
  const AMMO_SCAN_LIMIT = 4000000;
  const AMMO_CAND_LIMIT = 60000;

  function ammoOnFire() {
    if (!CFG.master || !CFG.autoAmmo || AM.done) return;
    const now = performance.now();
    if (now < AM.cool) return;
    AM.cool = now + 130;
    const h = heap();
    if (!h) return;

    if (AM.phase === 'idle') {
      AM.cand = [];
      const lim = Math.min(h.length, AMMO_SCAN_LIMIT);
      for (let i = 0; i < lim; i++) {
        const v = h[i];
        if (v > 0 && v < 200) { AM.cand.push(i, v); if (AM.cand.length >= AMMO_CAND_LIMIT) break; }
      }
      AM.phase = 'armed'; AM.fires = 0;
      say(`Ammo armed (${AM.cand.length / 2}) — fire`);
      return;
    }
    if (AM.phase !== 'armed') return;

    const keep = []; let maxV = 0;
    for (let i = 0; i < AM.cand.length; i += 2) {
      const a = AM.cand[i], v = AM.cand[i + 1], cur = h[a];
      if (typeof cur === 'number' && cur >= 0 && cur < v) { keep.push(a, cur); if (cur > maxV) maxV = cur; }
    }
    AM.cand = keep; AM.fires++;
    say(`Ammo: ${keep.length / 2} (shot ${AM.fires})`);
    if (keep.length / 2 <= 8 || AM.fires >= 6) {
      MEM.hits = [];
      for (let i = 0; i < keep.length && MEM.hits.length < 96; i += 2) MEM.hits.push(keep[i]);
      if (!MEM.hits.length) { AM.phase = 'idle'; say('Ammo scan failed — retry'); return; }
      MEM.val = Math.max(12, maxV + 1);
      MEM.frozen = true; AM.done = true; CFG.ammo = true;
      say(`Ammo locked at ${MEM.val}`);
      if (ui) ui.sync();
    }
  }

  setInterval(() => {
    if (!MEM.frozen || !MEM.hits.length || !CFG.ammo || !CFG.master) return;
    const h = heap(); if (!h) return;
    const lim = Math.min(MEM.hits.length, 96);
    for (let i = 0; i < lim; i++) { const a = MEM.hits[i]; if (a < h.length) h[a] = MEM.val; }
    if (h[MEM.hits[0]] > MEM.val + 3) { MEM.frozen = false; AM.done = false; AM.phase = 'idle'; }
  }, 40);

  /* ---------- ui ---------- */
  function buildUI() {
    const host = document.createElement('div');
    host.id = 'vck-host';
    Object.assign(host.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483000, pointerEvents: 'none' });
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        :host{all:initial}
        .panel{position:fixed;top:40px;left:40px;width:274px;pointer-events:auto;font:12px/1.4 ui-monospace,Menlo,monospace;
          color:#d8e2e8;background:rgba(12,15,18,.96);border:1px solid #1e2a33;border-radius:10px;
          box-shadow:0 12px 40px rgba(0,0,0,.7);user-select:none;overflow:hidden;max-height:92vh;overflow-y:auto}
        .bar{display:flex;gap:8px;align-items:center;padding:8px 10px;background:#131a20;border-bottom:1px solid #1e2a33;cursor:move;position:sticky;top:0;z-index:2}
        .dot{width:8px;height:8px;border-radius:50%;background:#5a6b78;flex:none}
        .dot.on{background:#00ffaa;box-shadow:0 0 8px #00ffaa}
        .dot.rage{background:#ff006e;box-shadow:0 0 8px #ff006e}
        .dot.pause{background:#ffcc00;box-shadow:0 0 8px #ffcc00}
        .title{flex:1;font-weight:600;font-size:11px;color:#9fb3c0;letter-spacing:.4px}
        .fps{font-size:10px;color:#5d7484}
        .body{padding:10px}
        .row{display:flex;align-items:center;justify-content:space-between;margin:6px 0;gap:8px}
        .row label{color:#9fb3c0}
        input[type=range]{width:84px;accent-color:#00ffaa}
        input[type=checkbox]{accent-color:#00ffaa;width:14px;height:14px;flex:none}
        input[type=color]{width:24px;height:19px;padding:0;border:1px solid #223039;border-radius:4px;background:#0b0f12}
        select{background:#0b0f12;color:#d8e2e8;border:1px solid #223039;border-radius:4px;font:inherit;padding:2px}
        .sw{display:flex;gap:4px;align-items:center}
        button{background:#16202a;color:#cfe0ea;border:1px solid #223039;border-radius:5px;font:inherit;padding:4px 7px;cursor:pointer}
        button:hover{background:#1d2a36}
        button.act{background:#00ffaa;color:#04120c;border-color:#00ffaa;font-weight:700}
        button.rage{background:#ff006e;color:#fff;border-color:#ff006e;font-weight:700}
        button.pause{background:#ffcc00;color:#201800;border-color:#ffcc00;font-weight:700}
        hr{border:0;border-top:1px solid #1a242c;margin:8px 0}
        .status{font-size:10.5px;color:#7d94a3;min-height:13px}
        .status.err{color:#ff6b6b}
        .diag{font-size:9.5px;color:#6a8494;white-space:pre;background:#0a0e11;border-radius:5px;padding:5px;margin-top:4px;line-height:1.35;overflow-x:auto;cursor:pointer}
        .err{font-size:10px;color:#ff6b6b;background:#1a0c0c;border:1px solid #43181a;border-radius:5px;padding:4px 6px;margin-top:6px;word-break:break-all}
        .foot{padding:6px 10px;background:#0d1216;border-top:1px solid #1a242c;font-size:10px;color:#5d7484;display:flex;justify-content:space-between;gap:6px}
        kbd{background:#1a242c;border-radius:3px;padding:1px 4px;color:#9fb3c0}
        .hidden{display:none!important}
        .panel.collapsed{width:auto}
        .panel.collapsed .body,.panel.collapsed .foot,.panel.collapsed .fps{display:none}
        .panel.collapsed .bar{border-bottom:0}
        .hint{font-size:9.5px;color:#6a8494;white-space:nowrap}
        .banner{position:fixed;top:10px;left:50%;transform:translateX(-50%);font:700 12px/1 ui-monospace,monospace;
          letter-spacing:3px;color:#ff006e;background:rgba(20,0,10,.85);border:1px solid #ff006e;
          border-radius:6px;padding:6px 14px;pointer-events:none;text-shadow:0 0 10px #ff006e}
        .cold{position:fixed;top:10px;left:50%;transform:translateX(-50%);font:700 12px/1 ui-monospace,monospace;
          letter-spacing:3px;color:#5d7484;background:rgba(10,14,17,.85);border:1px solid #2a3844;
          border-radius:6px;padding:6px 14px;pointer-events:none}
        #prev{width:100%;height:70px;border-radius:5px;background:#000;border:1px solid #1e2a33;display:block}
      </style>
      <div class="banner hidden" id="banner">AUTO-WIN</div>
      <div class="cold" id="cold">COLD</div>
      <div class="panel" id="panel">
        <div class="bar" id="bar"><div class="dot" id="dot"></div><div class="title">VECK v9</div><div class="fps" id="fps"></div></div>
        <div class="body" id="body">
          <div class="row"><label><b>Arm</b></label><button id="b-arm">Alt+C</button></div>
          <div class="row"><label>Pause input</label><button id="b-pause">Alt+X</button></div>
          <hr>
          <div class="row"><label>ESP</label><input type="checkbox" id="c-esp"></div>
          <div class="row"><label>Nameplates</label><input type="checkbox" id="c-plate"></div>
          <div class="row"><label>Bodies</label><input type="checkbox" id="c-body"></div>
          <div class="row"><label>Any color</label><input type="checkbox" id="c-any"></div>
          <div class="row"><label>Aimbot</label><input type="checkbox" id="c-aim"></div>
          <div class="row"><label>FOV</label><input type="range" id="r-fov" min="80" max="1600" step="10"></div>
          <div class="row"><label>Fire gate</label><input type="range" id="r-gate" min="6" max="120" step="2"></div>
          <div class="row"><label>Smoothing</label><input type="range" id="r-sm" min="1" max="10" step="0.5"></div>
          <div class="row"><label>Sensitivity</label><input type="range" id="r-sn" min="0.2" max="3" step="0.05"></div>
          <div class="row"><label>Only while firing</label><input type="checkbox" id="c-fire"></div>
          <div class="row"><label>Match only</label><input type="checkbox" id="c-match"></div>
          <hr>
          <div class="row"><label><b>Fly</b></label><input type="checkbox" id="c-fly"></div>
          <div class="row"><label>Mode</label><span class="sw">
            <select id="sel-fly"><option value="hop">hop</option><option value="hover">hover</option></select></span></div>
          <div class="row"><label>Climb speed</label><input type="range" id="r-fly" min="0.05" max="2" step="0.05"></div>
          <div class="row"><span class="sw" style="gap:4px">
            <button id="b-flycal">Calibrate</button><button id="b-flyclear">Clear</button></span>
            <span class="hint">Space up / Ctrl down</span></div>
          <hr>
          <div class="row"><label>Preview</label><input type="checkbox" id="c-prev"></div>
          <canvas id="prev" width="288" height="162" class="hidden"></canvas>
          <hr>
          <div class="row"><label>Auto colors</label><input type="checkbox" id="c-auto"></div>
          <div class="row"><label>Colors</label><span class="sw">
            <input type="checkbox" id="on0"><input type="color" id="p0">
            <input type="checkbox" id="on1"><input type="color" id="p1"><button id="pick">+</button></span></div>
          <div class="row"><label>Tolerance</label><input type="range" id="r-tol" min="12" max="140" step="2"></div>
          <div class="row"><label>Min blob</label><input type="range" id="r-mb" min="2" max="30" step="1"></div>
          <div class="row"><label>Ignore HUD</label><input type="checkbox" id="c-hud"></div>
          <div class="row"><label>HUD suppress</label><input type="checkbox" id="c-supp"></div>
          <div class="row"><label>Capture</label><span class="sw">
            <select id="sel-cap"><option value="auto">auto</option><option value="raf">raf</option><option value="pixels">readPixels</option></select></span></div>
          <hr>
          <div class="row"><label>Auto ammo</label><input type="checkbox" id="c-autoammo"></div>
          <div class="row"><label>Ammo freeze</label><input type="checkbox" id="c-ammo"></div>
          <div class="row"><button id="b-freeze">Freeze</button><button id="b-reset">Re-scan</button></div>
          <div class="status" id="status"></div>
          <div class="err hidden" id="err"></div>
          <div class="diag hidden" id="diag"></div>
          <hr>
          <div class="row"><label><b>Auto-win</b></label><button id="b-rage">Alt+G</button></div>
        </div>
        <div class="foot"><span><kbd>Alt</kbd>+<kbd>C</kbd> arm</span><span><kbd>Alt</kbd>+<kbd>W</kbd> hide</span><span><kbd>Alt</kbd>+<kbd>D</kbd> diag</span></div>
      </div>`;
    rootEl().appendChild(host);
    const $ = id => sh.getElementById(id);
    const panel = $('panel');
    const status = (t, e) => { const el = $('status'); if (!el) return; el.textContent = t || ''; el.classList.toggle('err', !!e); };
    const showErr = () => {
      const el = $('err'); if (!el) return;
      const e = ERR[ERR.length - 1];
      el.textContent = e ? 'ERR ' + e : '';
      el.classList.toggle('hidden', !e);
    };

    const sync = () => {
      $('c-esp').checked = CFG.esp; $('c-aim').checked = CFG.aimbot; $('c-ammo').checked = CFG.ammo;
      $('c-plate').checked = CFG.plates; $('c-body').checked = CFG.bodies; $('c-any').checked = CFG.anyColor;
      $('c-match').checked = CFG.matchOnly;
      $('c-fire').checked = !!CFG.aimOnlyFiring; $('c-hud').checked = CFG.ignoreHud; $('c-supp').checked = CFG.hudSuppress;
      $('c-auto').checked = !CFG.lockColors; $('c-autoammo').checked = CFG.autoAmmo;
      $('c-prev').checked = CFG.showPreview; $('c-fly').checked = CFG.fly;
      $('sel-fly').value = CFG.flyMode;
      $('r-fly').value = CFG.flySpeed;
      $('r-fov').value = CFG.fov; $('r-gate').value = CFG.gate; $('r-sm').value = CFG.smooth;
      $('r-sn').value = CFG.sens; $('r-tol').value = CFG.tol; $('r-mb').value = CFG.minBlob;
      $('p0').value = CFG.colors[0]; $('p1').value = CFG.colors[1];
      $('on0').checked = CFG.colorsOn[0]; $('on1').checked = CFG.colorsOn[1];
      $('sel-cap').value = CFG.capMode;
      $('dot').classList.toggle('pause', CFG.paused);
      $('dot').classList.toggle('on', !CFG.paused && CFG.master && !CFG.autoWin);
      $('dot').classList.toggle('rage', !CFG.paused && CFG.master && CFG.autoWin);
      $('b-arm').classList.toggle('act', CFG.master);
      $('b-arm').textContent = CFG.master ? 'ARMED' : 'Alt+C';
      $('b-freeze').classList.toggle('act', MEM.frozen);
      $('b-freeze').textContent = MEM.frozen ? 'Unfreeze' : 'Freeze';
      $('b-rage').classList.toggle('rage', CFG.autoWin);
      $('b-pause').classList.toggle('pause', CFG.paused);
      const armed = CFG.master && !CFG.paused;
      $('banner').classList.toggle('hidden', !(armed && CFG.autoWin));
      $('cold').classList.toggle('hidden', armed);
      $('prev').classList.toggle('hidden', !CFG.showPreview);
      $('diag').classList.toggle('hidden', !CFG.showDiag);
      showErr();
    };
    const bind = (id, k, num) => { const el = $(id); if (!el) return; el.oninput = el.onchange = () => { CFG[k] = num ? +el.value : (el.type === 'checkbox' ? el.checked : el.value); save(); }; };
    [['c-esp','esp'],['c-aim','aimbot'],['c-ammo','ammo'],['c-fire','aimOnlyFiring'],['c-hud','ignoreHud'],
     ['c-autoammo','autoAmmo'],['c-prev','showPreview'],['c-plate','plates'],['c-body','bodies'],['c-any','anyColor'],
     ['c-match','matchOnly'],['c-supp','hudSuppress'],['c-fly','fly']].forEach(([i,k]) => bind(i,k,false));
    [['r-fov','fov'],['r-gate','gate'],['r-sm','smooth'],['r-sn','sens'],['r-tol','tol'],['r-mb','minBlob'],['r-fly','flySpeed']].forEach(([i,k]) => bind(i,k,true));
    $('c-auto').onchange = e => { CFG.lockColors = !e.target.checked; save(); };
    $('p0').oninput = e => { CFG.colors[0] = e.target.value; CFG.lockColors = true; save(); sync(); };
    $('p1').oninput = e => { CFG.colors[1] = e.target.value; CFG.lockColors = true; save(); sync(); };
    $('on0').onchange = e => { CFG.colorsOn[0] = e.target.checked; save(); };
    $('on1').onchange = e => { CFG.colorsOn[1] = e.target.checked; save(); };
    $('sel-cap').onchange = e => { CFG.capMode = e.target.value; save(); };
    $('sel-fly').onchange = e => { CFG.flyMode = e.target.value; save(); };
    $('pick').onclick = () => { pickArmed = !pickArmed; $('pick').classList.toggle('act', pickArmed); status(pickArmed ? 'Click an enemy (Esc first)' : ''); };
    $('b-arm').onclick = () => toggleMaster();
    $('b-freeze').onclick = () => { MEM.frozen = !MEM.frozen; AM.done = true; sync(); };
    $('b-reset').onclick = () => { AM.phase = 'idle'; AM.done = false; AM.cand = []; MEM.hits = []; MEM.frozen = false; status('Re-scan armed'); sync(); };
    $('b-flycal').onclick = () => safe(flyCalibrate, 'flycal');
    $('b-flyclear').onclick = () => { flyClear(); status('Fly cleared'); sync(); };
    $('b-rage').onclick = () => rage();
    $('b-pause').onclick = () => togglePause();
    $('diag').onclick = () => { CFG.showDiag = !CFG.showDiag; save(); sync(); };

    let drag = null;
    $('bar').addEventListener('mousedown', e => { drag = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop }; e.preventDefault(); });
    addEventListener('mousemove', e => { if (drag) { panel.style.left = Math.max(0, e.clientX - drag.x) + 'px'; panel.style.top = Math.max(0, e.clientY - drag.y) + 'px'; } });
    addEventListener('mouseup', () => { drag = null; });

    return {
      sync, status, $, showErr,
      setFps: v => { const el = $('fps'); if (el) el.textContent = v; },
      toggle() {
        panel.classList.toggle('collapsed');
        status(panel.classList.contains('collapsed') ? 'Alt+W to reopen' : '');
      }
    };
  }

  /* ---------- modes ---------- */
  const bak = { fov: null, gate: null, aimOnly: null, armed: false };

  function toggleMaster() {
    CFG.master = !CFG.master;
    if (!CFG.master) {
      blobs = []; targetKey = null;
      if (autoFireOn) { sendBtn(false); autoFireOn = false; }
      if (oCtx && overlay) oCtx.clearRect(0, 0, overlay.width, overlay.height);
      CFG.autoWin = false; bak.armed = false;
      CFG.esp = false; CFG.aimbot = false; CFG.ammo = false; CFG.autoAmmo = false; CFG.fly = false;
    }
    save();
    if (ui) { ui.sync(); ui.status(CFG.master ? 'ARMED — features ready but still off' : 'Disarmed'); }
  }

  function rage() {
    if (!CFG.master) { say('Arm first (Alt+C)'); return; }
    CFG.autoWin = !CFG.autoWin;
    if (CFG.autoWin) {
      if (!bak.armed) {
        bak.fov = CFG.fov; bak.gate = CFG.gate; bak.aimOnly = CFG.aimOnlyFiring;
        bak.armed = true;
      }
      CFG.esp = true; CFG.aimbot = true; CFG.ammo = true; CFG.autoAmmo = true;
      CFG.aimOnlyFiring = false; CFG.fov = 1500; CFG.gate = 44;
      say('AUTO-WIN ON');
    } else {
      if (bak.armed) {
        CFG.fov = bak.fov != null ? bak.fov : 420;
        CFG.gate = bak.gate != null ? bak.gate : 26;
        CFG.aimOnlyFiring = bak.aimOnly != null ? bak.aimOnly : true;
      }
      bak.armed = false;
      if (autoFireOn) { sendBtn(false); autoFireOn = false; }
      say('Auto-win off');
    }
    save(); if (ui) ui.sync();
  }

  function togglePause() {
    CFG.paused = !CFG.paused;
    if (CFG.paused && autoFireOn) { sendBtn(false); autoFireOn = false; }
    say(CFG.paused ? 'INPUT PAUSED — menus are yours' : 'Input resumed');
    save(); if (ui) ui.sync();
  }

  /* ---------- events ---------- */
  const fromPanel = e => {
    try {
      const p = typeof e.composedPath === 'function' ? e.composedPath() : [];
      for (const n of p) { if (n && n.id === 'vck-host') return true; }
    } catch (_) {}
    return false;
  };

  safe(() => addEventListener('keydown', e => {
    if (e.__vck || fromPanel(e)) return;
    if (e.code === 'Space') upHeld = true;
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') downHeld = true;
    if (!e.altKey) return;
    if (e.code === 'KeyC') { e.preventDefault(); toggleMaster(); }
    if (e.code === 'KeyW') { e.preventDefault(); ui ? ui.toggle() : tryActivate(); }
    if (e.code === 'KeyG') { e.preventDefault(); if (ui) rage(); else say('UI not ready'); }
    if (e.code === 'KeyX') { e.preventDefault(); if (ui) togglePause(); else say('UI not ready'); }
    if (e.code === 'KeyF') {
      e.preventDefault();
      if (!CFG.master) { say('Arm first (Alt+C)'); return; }
      CFG.fly = !CFG.fly;
      if (!CFG.fly) { upHeld = false; downHeld = false; }
      say(CFG.fly ? `FLY ${CFG.flyMode}` : 'Fly off');
      save(); if (ui) ui.sync();
    }
    if (e.code === 'KeyD') { e.preventDefault(); CFG.showDiag = !CFG.showDiag; save(); if (ui) ui.sync(); }
    if (e.code === 'KeyV') { e.preventDefault(); tryActivate(); }
  }, true), 'keys');

  safe(() => addEventListener('keyup', e => {
    if (e.code === 'Space') upHeld = false;
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') downHeld = false;
  }, true), 'kup');

  safe(() => addEventListener('blur', () => { realFire = false; upHeld = false; downHeld = false; }), 'blur');

  safe(() => addEventListener('mousedown', e => {
    if (e.__vck || fromPanel(e)) return;
    realFire = true;
    if (!CFG.master) return;
    const onCanvas = gameCanvas && gameCanvas.contains(e.target);
    if (onCanvas) { entered = true; recenterCursor(); }
    if (onCanvas || document.pointerLockElement) safe(ammoOnFire, 'ammofire');
    if (!pickArmed) return;
    pickArmed = false;
    if (ui) { const b = ui.$('pick'); if (b) b.classList.remove('act'); }
    if (!ui) return;
    const img = lastGood;
    if (img && gameCanvas) {
      const r = gameCanvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / Math.max(1, r.width);
      const fy = (e.clientY - r.top) / Math.max(1, r.height);
      const px = Math.max(0, Math.min(img.width - 1, Math.round(((fx - reg.fx) / reg.fw) * img.width)));
      const py = Math.max(0, Math.min(img.height - 1, Math.round(((fy - reg.fy) / reg.fh) * img.height)));
      const i = ((py * img.width) + px) << 2;
      const hex = '#' + [img.data[i], img.data[i + 1], img.data[i + 2]].map(v => (v || 0).toString(16).padStart(2, '0')).join('');
      CFG.colors[pickIdx] = hex; CFG.colorsOn[pickIdx] = true; CFG.lockColors = true;
      pickIdx = pickIdx ? 0 : 1; save(); ui.status('Picked ' + hex);
    } else ui.status('No frame to sample');
    ui.sync();
  }, true), 'mdown');

  safe(() => addEventListener('mouseup', e => { if (e.__vck || fromPanel(e)) return; realFire = false; }, true), 'mup');

  safe(() => document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) { entered = true; recenterCursor(); }
    else { realFire = false; if (autoFireOn) { sendBtn(false); autoFireOn = false; } }
  }), 'plc');

  /* ---------- loops ---------- */
  function diag() {
    if (!ui) return;
    const el = ui.$('diag'); if (!el) return;
    const f = FLY.addr < 0 ? null : heapF();
    const c = gameCanvas;
    el.textContent =
      `cold ${!CFG.master ? 1 : 0} armed ${CFG.master ? 1 : 0} rage ${CFG.autoWin ? 1 : 0} pause ${CFG.paused ? 1 : 0}\n` +
      `canvas ${c ? (c.id || c.tagName) + ' ' + (c.clientWidth | 0) + 'x' + (c.clientHeight | 0) : 'none'} gl ${gl ? 1 : 0} fb ${gl && CTX.get(gl) ? (CTX.get(gl).fb ? 1 : 0) : '-'}\n` +
      `src ${lastSrc} hook ${hooked ? 1 : 0} postraf ${Math.round(performance.now() - lastPostRaf)}ms\n` +
      `blobs ${blobs.length} plate ${blobs.filter(b => b.kind === 'plate').length} hot ${blobs.filter(b => b.kind === 'hot').length} dist ${Math.round(tRaw)} age ${Math.round(performance.now() - tLast)}\n` +
      `gain ${gain.toFixed(2)} ev ${CFG.aimEvent} inv ${CFG.invX}/${CFG.invY} lock ${document.pointerLockElement ? 1 : 0} in ${entered ? 1 : 0}\n` +
      `heap ${MEM.buf ? (MEM.buf.byteLength / 1048576).toFixed(0) + 'MB' : 'no'} ammo ${AM.phase}${MEM.frozen ? ' FROZEN' : ''}\n` +
      `fly ${CFG.fly ? CFG.flyMode : 'off'} addr ${FLY.addr} y ${f && FLY.addr >= 0 ? (f[FLY.addr >> 2] || 0).toFixed(2) : '-'} mot ${sMotion}\n` +
      `col ${CFG.colors[0]} ${CFG.colors[1]} read ${CFG.readCap}\n` +
      `err ${ERR[ERR.length - 1] || '-'}`;
    ui.showErr();
  }

  function preview() {
    if (!ui || !CFG.showPreview || !lastGood) return;
    const now = performance.now();
    if (now - lastPrev < 260) return;
    lastPrev = now;
    if (!frameCanvas || frameCanvas.width !== lastGood.width || frameCanvas.height !== lastGood.height) {
      frameCanvas = document.createElement('canvas');
      frameCanvas.width = lastGood.width; frameCanvas.height = lastGood.height;
      fctx = frameCanvas.getContext('2d');
    }
    fctx.putImageData(lastGood, 0, 0);
    const pv = ui.$('prev');
    if (!pv) return;
    if (pv.width !== frameCanvas.width || pv.height !== frameCanvas.height) { pv.width = frameCanvas.width; pv.height = frameCanvas.height; pvCtx = null; }
    if (!pvCtx) pvCtx = pv.getContext('2d');
    pvCtx.drawImage(frameCanvas, 0, 0, pv.width, pv.height);
  }

  /* capture loop: keep RAF alive but do the least work possible when cold */
  function captureLoop(t) {
    requestAnimationFrame(captureLoop);
    try {
      const now = t || performance.now();
      if (now - lastCap < 1000 / CFG.fps) return;
      const dt = now - lastCap;
      lastCap = now;

      const needFrame = CFG.master || CFG.showPreview;
      let img = null;
      if (needFrame) {
        img = grab();
        if (img) lastGood = img;
      }

      if (CFG.master) {
        flySample();
        if (img && lastSrc !== 'stale') {
          updateStatic(img);
          if (!CFG.lockColors) calibrate(img);
          if (CFG.esp || CFG.aimbot || CFG.autoWin) blobs = detect(img);
          else blobs = [];
        }
        aim();
        autoFireTick();
        flyTick();
      } else if (CFG.showPreview && img) {
        /* preview-only path: allow sampling the frame without arming */
        lastGood = img;
      }

      preview();
      if (CFG.showDiag && now - diagT > 400) { diagT = now; diag(); }
      if (dt > 0 && ui) { fpsAcc += 1000 / dt; if (++fpsN >= 12) { ui.setFps(Math.round(fpsAcc / fpsN) + 'fps'); fpsAcc = 0; fpsN = 0; } }
    } catch (e) { pushErr('cap: ' + ((e && e.message) || e)); }
  }

  function renderLoop(t) {
    requestAnimationFrame(renderLoop);
    try {
      const now = t || performance.now();
      if (now - lastRender < 1000 / CFG.renderFps) return;
      lastRender = now;
      render();
    } catch (e) { pushErr('ren: ' + ((e && e.message) || e)); }
  }

  /* ---------- boot: does NOT enable anything ---------- */
  function boot() {
    if (booted) return;
    booted = true;
    initBuffers();
    recenterCursor();
    if (!ui) ui = buildUI();
    ui.sync();
    ui.status('COLD — Alt+C to arm');
    requestAnimationFrame(captureLoop);
    requestAnimationFrame(renderLoop);
    setTimeout(() => { if (ui && !CFG.master) ui.status('COLD — Alt+C to arm'); }, 2600);
  }
})();