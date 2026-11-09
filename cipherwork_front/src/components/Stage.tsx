import { useEffect, useRef, useState } from 'react';

export type StepState = 'idle' | 'active' | 'done' | 'failed' | 'skipped';
export type StepMap = Record<'draft' | 'quote' | 'fund' | 'preflight' | 'execute' | 'verify' | 'settle' | 'receipt', StepState>;
type CheckLite = { status: 'passed' | 'failed' | 'not_checked' };
type Outcome = 'settled' | 'rejected' | null;
type Phase = 'idle' | 'seal' | 'travel' | 'inside';

/* ------------------------------------------------------------------ palette: white jelly on black, light is the only colour */
const W = 720, H = 470, FLOOR = 392;
const BG = '#0a0a1a', SHADOW = '#1c1c3a', WALL = '#2c2c55', FG = '#eeeefc', INK = '#14142b', DIM = 'rgba(238,238,252,.42)';
const VIO2 = '#9a85ff';
const LIGHT = '#7b61ff', RED = '#ff5a4f', ROOM_OFF = '#121215';
const V = { x: 520, w: 180, roof: 176, wall: 14, gap: 296 };
const SAFE = { x: 134, y: 64, w: 108, h: 92 }; // wall-mounted escrow safe
const SAFE_C = { x: SAFE.x + SAFE.w / 2, y: SAFE.y + SAFE.h / 2 };
const MS = 1.6; // marketplace stall scale
const MARKET = { x: 286, y: FLOOR - 70 * MS + 9, w: 80 * MS, h: 48 * MS }; // a stall standing on the floor, with a seller inside
const ROUTER = { x: 300, y: 70, w: 120, h: 62 };
const A = { buyer: { x: 100, y: 300 }, rL: { x: 300, y: 100 }, rR: { x: 420, y: 100 }, ledger: { x: 188, y: 110 }, vault: { x: 610, y: 190 } };
const CHECKS = ['fresh nonce', 'hardware quote (TDX)', 'signing key bound', 'boot log replay', 'config hash', 'GPU evidence'];
let COMPACT = false;
const GLYPHS = '▲◆●✦◐◢◣◇▣▦▧▩01⌘∴≈';
const rndGlyphs = (n: number) => Array.from({ length: n }, () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]).join('');

/* ------------------------------------------------------------------ soft-body physics: edge springs + internal gas pressure */
type Pt = { x: number; y: number; px: number; py: number };
type Kind = 'hero' | 'friend' | 'inspector' | 'provider';
type Blob = { kind: Kind; R: number; pts: Pt[]; rest: { x: number; y: number }[]; edge: number; A0: number; homeX: number; hopT: number; blink: number; look: number; joy: number; ph: number; face: Face };
type Coin = { x: number; y: number; vx: number; vy: number; wait?: number; hidden?: boolean; store?: boolean; rise?: boolean; aim?: { tx: number; ty: number; T: number }; to?: 'provider' | 'hero'; dead?: boolean; stored?: boolean };
type Rect = { x: number; y: number; w: number; h: number };
const N = 26;
const GRAV = 0.5;

/** Face proportions as fractions of the body: how high the eyes sit, how far apart, how big, where the mouth is. */
type Face = { eyeY: number; gap: number; eye: number; mouthY: number; mouth: number };
const FACES: Record<string, Face> = {
  hero: { eyeY: 0.36, gap: 0.30, eye: 1.0, mouthY: 0.62, mouth: 1.0 },
  inspector: { eyeY: 0.30, gap: 0.24, eye: 1.25, mouthY: 0.60, mouth: 0.8 },
  provider: { eyeY: 0.40, gap: 0.34, eye: 1.0, mouthY: 0.66, mouth: 1.1 },
  wide: { eyeY: 0.46, gap: 0.38, eye: 0.9, mouthY: 0.74, mouth: 1.25 },
  close: { eyeY: 0.33, gap: 0.20, eye: 1.2, mouthY: 0.62, mouth: 0.7 },
  huge: { eyeY: 0.42, gap: 0.30, eye: 1.4, mouthY: 0.78, mouth: 0.9 },
};
function makeBlob(kind: Kind, x: number, R: number, face: keyof typeof FACES = kind): Blob {
  const rest = Array.from({ length: N }, (_, i) => ({ x: Math.cos((i / N) * Math.PI * 2) * R, y: Math.sin((i / N) * Math.PI * 2) * R }));
  const y = FLOOR - R - (kind === 'inspector' ? 34 : 2);
  return { kind, R, rest, edge: 2 * R * Math.sin(Math.PI / N), A0: Math.PI * R * R, pts: rest.map((r) => ({ x: x + r.x, y: y + r.y, px: x + r.x, py: y + r.y })), homeX: x, hopT: 120 + Math.random() * 400, blink: Math.random() * 200, look: 0, joy: 0, ph: Math.random() * 6, face: FACES[face] ?? FACES.hero };
}
const centre = (b: Blob) => { let x = 0, y = 0; for (const p of b.pts) { x += p.x; y += p.y; } return { x: x / N, y: y / N }; };
const area = (b: Blob) => { let a = 0; for (let i = 0; i < N; i++) { const p = b.pts[i], q = b.pts[(i + 1) % N]; a += p.x * q.y - q.x * p.y; } return Math.abs(a) / 2; };
const bbox = (b: Blob) => { let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const p of b.pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; } return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 }; };
function pushOut(p: Pt, r: Rect) {
  if (p.x < r.x || p.x > r.x + r.w || p.y < r.y || p.y > r.y + r.h) return;
  const dl = p.x - r.x, dr = r.x + r.w - p.x, dt = p.y - r.y, db = r.y + r.h - p.y;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) { p.x = r.x; p.px = p.x; } else if (m === dr) { p.x = r.x + r.w; p.px = p.x; } else if (m === dt) { p.y = r.y; p.py = p.y; } else { p.y = r.y + r.h; p.py = p.y; }
}

function integrate(b: Blob, t: number, dragged = false) {
  const Ar = area(b), c = centre(b);
  const breathe = 1 + Math.sin(t / 55 + b.ph) * 0.012;
  const ghost = b.kind === 'inspector';
  const meanVy = b.pts.reduce((sum, p) => sum + p.y - p.py, 0) / N;
  // the ghost floats up and over the marketplace stall as it passes
  const over = ghost ? Math.max(0, Math.min(1, (c.x - (MARKET.x - 34)) / 30)) * (1 - Math.max(0, Math.min(1, (c.x - (MARKET.x + MARKET.w + 6)) / 30))) : 0;
  const hoverY = FLOOR - b.R - 34 - over * 96 + Math.sin(t / 48 + b.ph) * 5;
  // A damped lift force acts on the actual particles, so dragging and collisions still deform the ghost.
  const verticalForce = ghost ? (dragged ? 0 : Math.max(-0.65, Math.min(0.65, (hoverY - c.y) * 0.012 - meanVy * 0.09))) : GRAV;
  const pa = Math.max(-0.5, Math.min(2.6, 3.2 * ((b.A0 * breathe) / Math.max(Ar, 1) - 1)));
  let sa = 0, sb = 0;
  for (let i = 0; i < N; i++) { const dx = b.pts[i].x - c.x, dy = b.pts[i].y - c.y; sa += b.rest[i].x * dy - b.rest[i].y * dx; sb += b.rest[i].x * dx + b.rest[i].y * dy; }
  const th = Math.atan2(sa, sb), cs = Math.cos(th), sn = Math.sin(th);
  const ax: number[] = [], ay: number[] = [];
  for (let i = 0; i < N; i++) {
    const p = b.pts[(i + N - 1) % N], q = b.pts[(i + 1) % N];
    const tx = q.x - p.x, ty = q.y - p.y, l = Math.hypot(tx, ty) || 1;
    ax.push((ty / l) * pa); ay.push((-tx / l) * pa);
    const gx = c.x + b.rest[i].x * cs - b.rest[i].y * sn, gy = c.y + b.rest[i].x * sn + b.rest[i].y * cs;
    ax[i] += (gx - b.pts[i].x) * 0.05; ay[i] += (gy - b.pts[i].y) * 0.05;
  }
  for (let i = 0; i < N; i++) {
    const p = b.pts[i];
    const vx = (p.x - p.px) * 0.988, vy = (p.y - p.py) * 0.988;
    p.px = p.x; p.py = p.y; p.x += vx + ax[i]; p.y += vy + ay[i] + verticalForce;
  }
}
function relax(b: Blob, solids: Rect[]) {
  for (let i = 0; i < N; i++) {
    const p = b.pts[i], q = b.pts[(i + 1) % N];
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, k = ((d - b.edge) / d) * 0.5;
    p.x += dx * k; p.y += dy * k; q.x -= dx * k; q.y -= dy * k;
  }
  for (const p of b.pts) {
    if (p.y > FLOOR) { const vy = p.y - p.py; p.y = FLOOR; p.py = p.y + Math.min(vy, 12) * 0.12; p.px += (p.x - p.px) * 0.3; }
    if (p.x < 6) { p.x = 6; p.px = p.x; } if (p.x > W - 6) { p.x = W - 6; p.px = p.x; }
    for (const r of solids) pushOut(p, r);
  }
}
function inside(b: Blob, x: number, y: number) {
  let c = false;
  for (let i = 0, j = N - 1; i < N; j = i++) { const a = b.pts[i], d = b.pts[j]; if ((a.y > y) !== (d.y > y) && x < ((d.x - a.x) * (y - a.y)) / (d.y - a.y) + a.x) c = !c; }
  return c;
}
function collide(a: Blob, b: Blob) {
  const ca = centre(a), cb = centre(b);
  if (Math.hypot(ca.x - cb.x, ca.y - cb.y) > (a.R + b.R) * 1.5) return;
  for (const [s, o] of [[a, b], [b, a]] as [Blob, Blob][]) {
    for (const p of s.pts) {
      if (!inside(o, p.x, p.y)) continue;
      let best = 1e9, bx = 0, by = 0, bi = 0;
      for (let i = 0; i < N; i++) {
        const u = o.pts[i], v = o.pts[(i + 1) % N], ex = v.x - u.x, ey = v.y - u.y, l2 = ex * ex + ey * ey || 1;
        const t = Math.max(0, Math.min(1, ((p.x - u.x) * ex + (p.y - u.y) * ey) / l2)), qx = u.x + ex * t, qy = u.y + ey * t, d = Math.hypot(p.x - qx, p.y - qy);
        if (d < best) { best = d; bx = qx; by = qy; bi = i; }
      }
      const dx = bx - p.x, dy = by - p.y;
      p.x += dx * 0.5; p.y += dy * 0.5; const u = o.pts[bi], v = o.pts[(bi + 1) % N];
      u.x -= dx * 0.25; u.y -= dy * 0.25; v.x -= dx * 0.25; v.y -= dy * 0.25;
    }
  }
}

/* ------------------------------------------------------------------ the world */
type Forger = { x: number; y: number; vx: number; vy: number; a: number; va: number };
type Chip = { text: string; from: { x: number; y: number }; to: { x: number; y: number }; delay: number; t: number; dur: number };
type World = { blobs: Blob[]; coins: Coin[]; chips: Chip[]; forger?: Forger; drag?: { b: Blob; i: number; x: number; y: number }; t: number; motes: { x: number; y: number; s: number }[]; spawnedCoins: boolean; released: boolean; prev: Partial<StepMap>; stamp: number; door: number; safeFlash?: number; priv?: number };
function createWorld(): World {
  const blobs = [makeBlob('hero', 100, 36), makeBlob('inspector', 158, 22), makeBlob('friend', 36, 14, 'wide'), makeBlob('friend', 150, 15, 'close'), makeBlob('friend', 60, 11, 'huge'), makeBlob('provider', 440, 24)];
  return { blobs, coins: [], chips: [], t: 0, motes: Array.from({ length: 14 }, () => ({ x: Math.random() * W, y: Math.random() * 420, s: 0.2 + Math.random() * 0.4 })), spawnedCoins: false, released: false, prev: {}, stamp: 0, door: 0 };
}
type Ctl = { steps: StepMap; checks: CheckLite[]; outcome: Outcome; phase: Phase; sharedFloor?: boolean };
const chip = (w: World, text: string, from: Chip['from'], to: Chip['to'], delay = 0, dur = 80) => w.chips.push({ text, from, to, delay, t: 0, dur });

function update(w: World, c: Ctl) {
  w.t++;
  const { steps, outcome, phase } = c;
  const failedPre = steps.preflight === 'failed', preActive = steps.preflight === 'active', preDone = steps.preflight === 'done';
  const answered = steps.execute === 'done';
  const settled = steps.settle === 'done' && outcome === 'settled', refunded = steps.settle === 'done' && outcome === 'rejected';
  const open = preDone || steps.execute === 'active' || answered;
  const hero = w.blobs[0];

  // public data chips: spawned on step transitions (this is what the marketplace API is allowed to see)
  const was = (k: keyof StepMap) => w.prev[k];
  if (steps.quote === 'active' && was('quote') !== 'active') { chip(w, 'quote?', A.buyer, { x: MARKET.x + 40 * MS, y: FLOOR - 40 * MS }, 0, 70); chip(w, 'price 0.02 N', { x: MARKET.x + 40 * MS, y: FLOOR - 40 * MS }, A.buyer, 85, 70); }
  if (steps.fund === 'active' && was('fund') !== 'active') { chip(w, 'order #17', A.buyer, { x: 188, y: 110 }, 0, 70); chip(w, 'lock 0.02 N', A.buyer, A.ledger, 25, 90); }
  if (steps.verify === 'done' && was('verify') !== 'done') chip(w, 'public proof', A.buyer, A.rL, 0, 80);
  if (failedPre && was('preflight') !== 'failed') chip(w, 'failed evidence', A.buyer, A.rL, 0, 80);
  if (steps.settle === 'active' && was('settle') !== 'active') { chip(w, failedPre ? 'verdict: reject' : 'verdict: signed', A.rR, A.ledger, 0, 90); chip(w, 'receipt', A.ledger, A.buyer, 100, 80); }
  if (steps.settle === 'done' && was('settle') !== 'done') w.stamp = 90;
  w.prev = { ...steps };
  w.chips = w.chips.filter((k) => k.t < k.dur + 30 + k.delay);
  for (const k of w.chips) k.t++;
  if (w.stamp > 0) w.stamp--;
  if (w.safeFlash && w.safeFlash > 0) w.safeFlash--;

  // Coins are launched on exact ballistic arcs so they always land where they are meant to:
  // x(n) = x0 + n*vx, y(n) = y0 + n*vy0 + g*n*(n+1)/2  (matches the integrator below).
  const aimCoin = (k: Coin, tx: number, ty: number, T: number) => { k.vx = (tx - k.x) / T; k.vy = (ty - k.y - (GRAV * T * (T + 1)) / 2) / T; };
  const hc0 = centre(hero), prov = w.blobs.find((b) => b.kind === 'provider')!;
  if (steps.fund === 'active' && !w.spawnedCoins) {
    w.spawnedCoins = true;
    for (let i = 0; i < 4; i++) {
      const k: Coin = { x: hc0.x + (i - 1.5) * 5, y: hc0.y - hero.R * 0.6, vx: 0, vy: 0, wait: 1 + i * 9, hidden: true, aim: { tx: SAFE.x + 14, ty: SAFE.y + SAFE.h * 0.62, T: 46 + i * 3 }, store: true };
      w.coins.push(k);
    }
  }
  if (steps.fund === 'idle' && steps.draft === 'idle') { w.spawnedCoins = false; w.coins = []; w.forger = undefined; w.released = false; }
  if ((settled || refunded) && !w.released) {
    w.released = true;
    w.coins.forEach((k, i) => {
      const tgt = settled ? prov : hero, tc = centre(tgt);
      k.to = settled ? 'provider' : 'hero'; k.wait = 1 + i * 8; k.hidden = true; k.rise = false; k.store = false; k.stored = false; k.x = SAFE.x + SAFE.w - 20; k.y = SAFE.y + SAFE.h + 4; k.vx = 0; k.vy = 0;
      k.aim = { tx: tc.x + (i - 1.5) * 4, ty: tc.y - tgt.R * 0.4, T: (settled ? 44 : 34) + i * 2 };
    });
  }
  if (!settled && !refunded) w.released = false;
  for (const k of w.coins) {
    if (k.wait !== undefined && k.wait > 0) { k.wait--; if (k.wait === 0) { k.hidden = false; if (k.aim) { aimCoin(k, k.aim.tx, k.aim.ty, k.aim.T); k.aim = undefined; } } continue; }
    if (k.stored) continue;
    k.vy += GRAV; k.x += k.vx; k.y += k.vy;
    const flying = k.y < FLOOR - 9;
    if (!flying) k.vx *= 0.9;
    if (k.y > FLOOR - 7) { k.y = FLOOR - 7; k.vy *= -0.3; if (Math.abs(k.vy) < 1) k.vy = 0; }
    if (k.store && Math.hypot(k.x - (SAFE.x + 14), k.y - (SAFE.y + SAFE.h * 0.62)) < 9) { k.stored = true; k.hidden = true; w.safeFlash = 14; continue; }
    if (k.x < 8) { k.x = 8; k.vx *= -0.4; } if (k.x > V.x - 10) { k.x = V.x - 10; k.vx *= -0.4; }
    if (k.to) { const tgt = k.to === 'provider' ? prov : hero, tc = centre(tgt); if (Math.hypot(k.x - tc.x, k.y - tc.y) < tgt.R * 0.95 && k.vy > 0) { k.dead = true; tgt.joy = 36; } }
  }
  w.coins = w.coins.filter((k) => !k.dead);
  if (failedPre && !w.forger) w.forger = { x: 490, y: -30, vx: -1.2, vy: 0, a: 0, va: 0.05 };
  if (!failedPre) w.forger = undefined;
  if (w.forger) { const f = w.forger; f.vy += 0.35; f.x += f.vx; f.y += f.vy; f.a += f.va; if (f.y > FLOOR - 20) { f.y = FLOOR - 20; f.vy *= -0.55; f.vx = -1.4 + Math.sin(w.t / 20); } if (f.x < 330) f.vx = Math.abs(f.vx); }

  // privacy veil: on while the agent is inside the vault and the job is running
  const hcx = centre(hero).x;
  const insideNow = hcx > V.x + V.wall + 8 && !answered && (phase === 'inside' || steps.execute === 'active');
  w.priv = (w.priv ?? 0) + ((insideNow ? 1 : 0) - (w.priv ?? 0)) * 0.06;
  w.door += ((open ? 1 : 0) - w.door) * 0.07;
  const solids: Rect[] = [
    { x: V.x, y: V.roof, w: V.w, h: V.wall }, { x: V.x + V.w - V.wall, y: V.roof, w: V.wall, h: FLOOR - V.roof },
    { x: V.x, y: V.roof, w: V.wall, h: V.gap - V.roof }, ...(w.door > 0.6 ? [] : [{ x: V.x, y: V.gap, w: V.wall, h: FLOOR - V.gap }]),
  ];
  // only the buyer's agent may pass the doorway: everyone else always meets a closed door
  const solidsClosed: Rect[] = [...solids.filter((r) => r.y !== V.gap || r.w !== V.wall), { x: V.x, y: V.gap, w: V.wall, h: FLOOR - V.gap }];
  const target = (b: Blob): number | null => {
    if (b.kind === 'hero') {
      if (failedPre) return 100;
      if (answered) return 110;
      if (phase === 'seal') return 330;
      if (phase === 'travel' || phase === 'inside') return 612;
      return 100;
    }
    if (b.kind === 'provider') return b.homeX;
    if (b.kind === 'inspector') return preActive ? 430 : preDone && !answered ? 440 : failedPre ? 230 : b.homeX;
    return null;
  };
  for (const b of w.blobs) {
    const c0 = centre(b);
    b.hopT--; b.blink--; if (b.blink < -8) b.blink = 120 + Math.random() * 200; b.joy = Math.max(0, b.joy - 1);
    const tx = target(b);
    let cvx = 0; for (const p of b.pts) cvx += p.x - p.px; cvx /= N;
    if (tx !== null && Math.abs(tx - c0.x) > 26) {
      const dir = Math.sign(tx - c0.x), slow = Math.min(1, Math.abs(tx - c0.x) / 90);
      if (Math.abs(cvx) < 2.1 * slow + 0.3) for (const p of b.pts) { const top = p.y < c0.y ? 1 : 0; p.px -= dir * (0.07 + top * 0.16); if (p.y > FLOOR - 3) p.px += dir * 0.02; }
    } else if (b.hopT <= 0 && b.kind !== 'inspector') {
      const party = (b.kind !== 'hero' && settled) || (b.kind === 'friend' && preActive);
      for (const p of b.pts) if (p.y < c0.y - b.R * 0.2) p.py += 3.6 + b.R * 0.05;
      b.joy = 30; b.hopT = party ? 40 + Math.random() * 30 : 260 + Math.random() * 520;
    }
    const lookTarget = b.kind === 'hero' ? (open ? V.x : c0.x + 60) : centre(hero).x;
    b.look += (Math.max(-1, Math.min(1, (lookTarget - c0.x) / 200)) - b.look) * 0.08;
    integrate(b, w.t, w.drag?.b === b);
  }
  for (let it = 0; it < 7; it++) {
    for (const b of w.blobs) relax(b, b.kind === 'hero' ? solids : solidsClosed);
    for (let i = 0; i < w.blobs.length; i++) for (let j = i + 1; j < w.blobs.length; j++) { if (w.blobs[i].kind === 'provider' || w.blobs[j].kind === 'provider') continue; collide(w.blobs[i], w.blobs[j]); }
    if (w.drag) { const { b, i, x, y } = w.drag; for (const [o, k] of [[0, 0.3], [1, 0.16], [-1, 0.16], [2, 0.07], [-2, 0.07]] as [number, number][]) { const p = b.pts[(i + o + N) % N]; p.x += (x - p.x) * k; p.y += (y - p.y) * k; } }
  }
  for (const m of w.motes) { m.y -= m.s * (open ? 1 : 0.25); if (m.y < -10) { m.y = 420; m.x = Math.random() * W; } }
}

/* ------------------------------------------------------------------ drawing */
function blobPath(ctx: CanvasRenderingContext2D, pts: Pt[], dx = 0, dy = 0) {
  ctx.beginPath();
  const m = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2 + dx, y: (a.y + b.y) / 2 + dy });
  const s = m(pts[N - 1], pts[0]); ctx.moveTo(s.x, s.y);
  for (let i = 0; i < N; i++) { const p = pts[i], e = m(p, pts[(i + 1) % N]); ctx.quadraticCurveTo(p.x + dx, p.y + dy, e.x, e.y); }
  ctx.closePath();
}

const glow = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number) => {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(139,120,255,${a})`); g.addColorStop(1, 'rgba(139,120,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
};
const rr = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
const text = (ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center', weight = 600) => { if (COMPACT && size < 13) return; size *= 1.14; ctx.font = `${weight} ${size}px "JetBrains Mono", monospace`; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(s, x, y); };

/** Inspector art follows the live soft-body bounds; its lantern swings with horizontal velocity. */
function drawInspector(ctx: CanvasRenderingContext2D, b: Blob, t: number, startled: boolean) {
  const bb = bbox(b), c = centre(b);
  const w = Math.max(4, bb.w), h = Math.max(4, bb.h);
  const vx = b.pts.reduce((sum, p) => sum + p.x - p.px, 0) / N;
  const flutter = Math.sin(t / 38 + b.ph) * 0.025;
  const height = Math.max(0, FLOOR - bb.y1);
  ctx.save();
  ctx.fillStyle = `rgba(154,133,255,${Math.max(0.04, 0.16 - height / 500)})`;
  ctx.beginPath(); ctx.ellipse(c.x, FLOOR - 1, w * 0.36, 2.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.translate(bb.x0, bb.y0); ctx.scale(w, h);
  // A rounded hood and three broad fabric folds, with no sharp cutouts.
  const outline = () => {
    ctx.beginPath(); ctx.moveTo(0.08, 0.63);
    ctx.bezierCurveTo(0.07, 0.23, 0.23, 0.02, 0.48, 0.02);
    ctx.bezierCurveTo(0.77, 0.01, 0.92, 0.24, 0.91, 0.60);
    ctx.bezierCurveTo(0.90, 0.77, 0.98, 0.88, 0.92, 0.94);
    ctx.bezierCurveTo(0.86, 1.00, 0.75, 0.84 + flutter, 0.69, 0.89);
    ctx.bezierCurveTo(0.61, 0.96, 0.56, 1.02, 0.48, 0.97);
    ctx.bezierCurveTo(0.39, 0.91, 0.38, 0.86 - flutter, 0.30, 0.91);
    ctx.bezierCurveTo(0.17, 1.02, 0.05, 0.97, 0.07, 0.87);
    ctx.bezierCurveTo(0.08, 0.78, 0.08, 0.72, 0.08, 0.63); ctx.closePath();
  };
  const pearl = ctx.createLinearGradient(0.2, 0.1, 0.85, 1);
  pearl.addColorStop(0, '#ffffff'); pearl.addColorStop(0.52, '#f9f7ff'); pearl.addColorStop(1, '#c9bcec');
  outline(); ctx.fillStyle = pearl; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 0.016; ctx.stroke();
  ctx.strokeStyle = 'rgba(168,146,222,.25)'; ctx.lineWidth = 0.018; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0.27, 0.73); ctx.quadraticCurveTo(0.24, 0.83, 0.22, 0.88);
  ctx.moveTo(0.70, 0.74); ctx.quadraticCurveTo(0.72, 0.82, 0.77, 0.89); ctx.stroke();
  // Calm, widely spaced eyes with tiny reflected highlights.
  for (const x of [0.35, 0.65]) {
    const eyeX = x + b.look * 0.022;
    ctx.fillStyle = '#211a3e'; ctx.beginPath();
    if (b.blink < 0) { ctx.ellipse(eyeX, 0.40, 0.053, 0.013, 0, 0, Math.PI * 2); }
    else { ctx.ellipse(eyeX, 0.40, 0.052, 0.065, 0, 0, Math.PI * 2); }
    ctx.fill();
    if (b.blink >= 0) { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(eyeX - 0.014, 0.378, 0.014, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.strokeStyle = '#33264c'; ctx.lineWidth = 0.035; ctx.beginPath();
  if (startled) ctx.ellipse(0.5, 0.57, 0.035, 0.045, 0, 0, Math.PI * 2);
  else { ctx.moveTo(0.44, 0.54); ctx.quadraticCurveTo(0.50, 0.62, 0.56, 0.54); }
  ctx.stroke();
  ctx.fillStyle = 'rgba(174,143,235,.20)';
  for (const x of [0.25, 0.75]) { ctx.beginPath(); ctx.ellipse(x, 0.53, 0.055, 0.025, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();

  // Small suspended lantern, attached to a rounded sleeve at the side of the body.
  const handX = bb.x0 + w * 0.91, handY = bb.y0 + h * 0.62;
  ctx.save(); ctx.translate(handX, handY);
  ctx.rotate(Math.max(-0.28, Math.min(0.28, -vx * 0.065 + Math.sin(t / 46) * 0.06)));
  ctx.strokeStyle = '#bdb0e4'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(9, -3, 10, 6); ctx.stroke();
  glow(ctx, 10, 16, 22, 0.30);
  ctx.fillStyle = '#40305f'; rr(ctx, 3.5, 7, 13, 18, 4); ctx.fill();
  const glass = ctx.createLinearGradient(5, 10, 15, 22);
  glass.addColorStop(0, '#ede3ff'); glass.addColorStop(0.45, '#bc9dff'); glass.addColorStop(1, '#7b61ff');
  ctx.fillStyle = glass; rr(ctx, 5.5, 10, 9, 12, 2.5); ctx.fill();
  ctx.fillStyle = '#f9f3ff'; ctx.beginPath(); ctx.ellipse(10, 16, 1.6, 3.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#a68bdb'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(5, 8); ctx.lineTo(15, 8); ctx.moveTo(5, 24); ctx.lineTo(15, 24); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#f9f7ff'; ctx.beginPath(); ctx.ellipse(handX - 1, handY, w * 0.095, h * 0.075, -0.3, 0, Math.PI * 2); ctx.fill();
}

type Core = 'none' | 'plain' | 'sealed' | 'cipher' | 'answer' | 'coin';
function drawBlob(ctx: CanvasRenderingContext2D, b: Blob, mood: 'happy' | 'o', core: Core, t: number, lantern: boolean, lit: boolean) {
  const c = centre(b);
  const bb = bbox(b), sx = bb.w / (2 * b.R), sy = bb.h / (2 * b.R);
  if (b.kind === 'inspector') { drawInspector(ctx, b, t, mood === 'o'); return; }
  ctx.fillStyle = SHADOW; blobPath(ctx, b.pts, 4, 6); ctx.fill();
  if (lit) glow(ctx, c.x, c.y, b.R * 2.6, 0.16);
  ctx.fillStyle = '#fff'; blobPath(ctx, b.pts); ctx.fill();
  const F = b.face;
  const er = Math.max(2.3, b.R * 0.12 * F.eye) * (0.75 + 0.25 * Math.min(sx, sy, 1.3)), fx = (bb.x0 + bb.x1) / 2;
  const ex = Math.max(er * 1.7, bb.w * F.gap * 0.5), ey = bb.y0 + bb.h * F.eyeY;
  ctx.fillStyle = INK;
  for (const s of [-1, 1]) {
    const x = fx + s * ex + b.look * er * 0.8;
    if (b.blink < 0) ctx.fillRect(x - er, ey - 1, er * 2, 2); else { ctx.beginPath(); ctx.ellipse(x, ey, er, er * Math.max(0.85, Math.min(1.25, sy)), 0, 0, 7); ctx.fill(); }
  }
  // mouth: width follows the body, top edge never closer than 3px to the lower eyelid
  const mw = Math.max(2.4, bb.w * 0.095 * F.mouth), mh = Math.max(1.8, mw * (b.joy > 0 ? 0.8 : 0.55));
  const myTop = Math.min(Math.max(bb.y0 + bb.h * F.mouthY, ey + er * 1.25 + 3), bb.y0 + bb.h * 0.92 - mh * 1.6);
  ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.7, Math.min(2.4, b.R * 0.07)); ctx.lineCap = 'round'; ctx.beginPath();
  if (mood === 'o') ctx.ellipse(fx, myTop + mh * 0.9, mw * 0.4, mh * 0.95, 0, 0, 7);
  else { ctx.moveTo(fx - mw, myTop); ctx.quadraticCurveTo(fx, myTop + mh * 2, fx + mw, myTop); }
  ctx.stroke();
  if (core !== 'none') {
    const cy = bb.y0 + bb.h * 0.885, VIO = "#6a54f5", k = Math.max(0.6, Math.min(0.92, b.R / 40));
    ctx.save(); ctx.translate(c.x, cy); ctx.scale(k, k); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (core === 'plain') { // envelope = the secret
      ctx.strokeStyle = VIO; ctx.lineWidth = 2.2; ctx.fillStyle = '#efeaff'; rr(ctx, -9, -6, 18, 12, 3); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-8, -4.5); ctx.lineTo(0, 1.5); ctx.lineTo(8, -4.5); ctx.stroke();
    } else if (core === 'sealed' || core === 'cipher') { // padlock = sealed
      ctx.strokeStyle = VIO; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.arc(0, -3, 4.6, Math.PI, 0); ctx.lineTo(4.6, 0); ctx.moveTo(-4.6, -3); ctx.lineTo(-4.6, 0); ctx.stroke();
      ctx.fillStyle = VIO; rr(ctx, -7, -1, 14, 10, 3); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 4, 1.7, 0, 7); ctx.fill();
    } else if (core === 'answer') { // glowing check = signed answer
      glow(ctx, 0, 0, 30, 0.9); ctx.fillStyle = VIO; ctx.beginPath(); ctx.arc(0, 0, 8.5, 0, 7); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(-4, 0.5); ctx.lineTo(-1, 3.5); ctx.lineTo(4.5, -3); ctx.stroke();
    } else if (core === 'coin') { ctx.fillStyle = LIGHT; ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.fill(); }
    ctx.restore();
  }
  if (core === 'sealed' || core === 'cipher') {
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(Math.max(0.9, sx), Math.max(0.9, sy)); ctx.rotate(t / 40); ctx.strokeStyle = FG; ctx.globalAlpha = 0.55; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, b.R + 12, 0, 7); ctx.stroke(); ctx.restore();
  }
}

/** public data packet travelling to/from the marketplace API: a small white pearl with a short tail */
function drawPacket(ctx: CanvasRenderingContext2D, k: Chip) {
  const t = k.t - k.delay; if (t < 0) return;
  const u = Math.min(1, t / k.dur), at = (v: number) => {
    const e = v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2, mx = (k.from.x + k.to.x) / 2, my = Math.min(k.from.y, k.to.y) - 46;
    return { x: (1 - e) * (1 - e) * k.from.x + 2 * (1 - e) * e * mx + e * e * k.to.x, y: (1 - e) * (1 - e) * k.from.y + 2 * (1 - e) * e * my + e * e * k.to.y };
  };
  const fade = u >= 1 ? Math.max(0, 1 - (t - k.dur) / 24) : 1;
  for (let i = 3; i >= 0; i--) { const p = at(Math.max(0, u - i * 0.035)); ctx.globalAlpha = fade * (0.16 + (3 - i) * 0.1); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, 3 + (3 - i) * 0.6, 0, 7); ctx.fill(); }
  const p = at(u); ctx.globalAlpha = fade; glow(ctx, p.x, p.y, 16, 0.5); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
}

const hex2rgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a: string, b: string, t: number) => { const x = hex2rgb(a), y = hex2rgb(b); return `rgb(${Math.round(x[0] + (y[0] - x[0]) * t)},${Math.round(x[1] + (y[1] - x[1]) * t)},${Math.round(x[2] + (y[2] - x[2]) * t)})`; };

function draw(ctx: CanvasRenderingContext2D, w: World, c: Ctl, _tick: string) {
  const { steps, checks, outcome, phase } = c;
  const failedPre = steps.preflight === 'failed', preDone = steps.preflight === 'done';
  const answered = steps.execute === 'done';
  const settled = steps.settle === 'done' && outcome === 'settled';
  const funded = steps.fund === 'done' || steps.fund === 'failed';
  const privateLane = phase === 'seal' || phase === 'travel' || phase === 'inside';
  const t = w.t, d = w.door;
  const nPass = failedPre ? checks.length : preDone || steps.execute !== 'idle' ? 6 : Math.min(6, checks.length);
  const roomH = FLOOR - V.roof;

  ctx.clearRect(0, 0, W, H);

  // Standalone stages own their ground; the hero draws one continuous floor in CSS.
  if (!c.sharedFloor) {
    const fg = ctx.createLinearGradient(0, FLOOR, 0, H);
    fg.addColorStop(0, 'rgba(140,120,255,.13)'); fg.addColorStop(1, 'rgba(140,120,255,0)');
    ctx.fillStyle = fg; ctx.fillRect(0, FLOOR, W, H - FLOOR);
    ctx.fillStyle = 'rgba(160,140,255,.35)'; ctx.fillRect(0, FLOOR - 1, W, 2);
  }

  // light from the open door: one soft wedge, nothing else
  if (d > 0.02) {
    glow(ctx, V.x + 50, 300, 330 * d, 0.24 * d);
    const g = ctx.createLinearGradient(V.x, 0, 250, 0); g.addColorStop(0, `rgba(170,150,255,${0.3 * d})`); g.addColorStop(1, 'rgba(170,150,255,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(V.x, V.gap + 8); ctx.lineTo(V.x, FLOOR); ctx.lineTo(220, FLOOR); ctx.lineTo(380, FLOOR - 70); ctx.closePath(); ctx.fill();
  }
  if (failedPre) { const g = ctx.createLinearGradient(V.x, 0, 380, 0); g.addColorStop(0, 'rgba(255,90,79,.2)'); g.addColorStop(1, 'rgba(255,90,79,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(V.x, V.gap + 8); ctx.lineTo(V.x, FLOOR); ctx.lineTo(380, FLOOR); ctx.closePath(); ctx.fill(); }

  // A tiny open trading stall belongs to the world, rather than a UI button.
  const quoting = steps.quote === 'active' || steps.fund === 'active';
  ctx.save(); ctx.translate(MARKET.x, FLOOR - 70 * MS); ctx.scale(MS, MS);
  if (quoting) glow(ctx, 40, 40, 52, 0.15);
  ctx.fillStyle = 'rgba(154,133,255,.09)'; ctx.beginPath(); ctx.ellipse(40, 70, 44, 5, 0, 0, Math.PI * 2); ctx.fill();
  // Slender posts and a softly lit open interior.
  ctx.fillStyle = '#19162f'; rr(ctx, 8, 18, 64, 47, 9); ctx.fill();
  ctx.strokeStyle = '#80709f'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(10, 20); ctx.lineTo(10, 55); ctx.moveTo(70, 20); ctx.lineTo(70, 55); ctx.stroke();
  // Fabric canopy: broad alternating folds, not a surrounding rectangular frame.
  ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(68, 0); ctx.quadraticCurveTo(73, 0, 75, 5);
  ctx.lineTo(81, 20); ctx.lineTo(-1, 20); ctx.lineTo(5, 5); ctx.quadraticCurveTo(7, 0, 12, 0); ctx.closePath();
  ctx.fillStyle = '#b8a5f2'; ctx.fill();
  ctx.save(); ctx.clip(); ctx.fillStyle = '#72619f';
  ctx.beginPath(); ctx.moveTo(21, 0); ctx.lineTo(33, 0); ctx.lineTo(31, 22); ctx.lineTo(16, 22); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(47, 0); ctx.lineTo(59, 0); ctx.lineTo(64, 22); ctx.lineTo(49, 22); ctx.closePath(); ctx.fill(); ctx.restore();
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 ? '#72619f' : '#b8a5f2';
    ctx.beginPath(); ctx.moveTo(-1 + i * 16.4, 19); ctx.lineTo(15.4 + i * 16.4, 19);
    ctx.quadraticCurveTo(15.4 + i * 16.4, 28, 7.2 + i * 16.4, 28);
    ctx.quadraticCurveTo(-1 + i * 16.4, 28, -1 + i * 16.4, 19); ctx.fill();
  }
  // One offer sheet gently lifts while a quote is being requested.
  // The seller: a small blob keeping the stall, looking toward the buyer.
  { const bob = Math.sin(t / 38) * 1.1 - (quoting ? 2.5 + Math.abs(Math.sin(t / 12)) * 2 : 0), blink = t % 230 < 6;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(26, 58); ctx.arc(40, 58 + bob * 0.4, 14, Math.PI, 0); ctx.lineTo(54, 58); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#1a1630';
    for (const ex of [35, 44]) { if (blink) { ctx.fillRect(ex - 1.8, 51 + bob * 0.4, 3.6, 1.2); } else { ctx.beginPath(); ctx.arc(ex - 1.2, 51 + bob * 0.4, 1.9, 0, 7); ctx.fill(); } }
    ctx.strokeStyle = '#1a1630'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(38.5, 53.5 + bob * 0.4, quoting ? 3.2 : 2.4, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke(); }
  ctx.save(); ctx.translate(19, 43 + (quoting ? Math.sin(t / 15) * 2 : 0)); ctx.rotate(-0.12);
  ctx.fillStyle = '#ebe5fc'; rr(ctx, -10, -12, 20, 24, 4); ctx.fill();
  ctx.strokeStyle = '#8a72c1'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(-5, -5); ctx.lineTo(5, -5); ctx.moveTo(-5, 0); ctx.lineTo(2, 0); ctx.stroke();
  ctx.fillStyle = '#8a72c1'; ctx.beginPath(); ctx.arc(3, 6, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === 2 ? '#c4afff' : '#8c73cf';
    ctx.beginPath(); ctx.ellipse(63, 51 - i * 4, 8, 3.3, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#352c50'; rr(ctx, 4, 54, 72, 12, 5); ctx.fill();
  ctx.fillStyle = '#9a85cf'; rr(ctx, 1, 52, 78, 4, 2); ctx.fill();
  ctx.restore();
  // The one-eyed character checks public evidence for settlement, never private input.
  const checkingProof = steps.verify === 'done' || steps.settle === 'active' || steps.settle === 'done' || failedPre;
  const RX = ROUTER.x + ROUTER.w / 2, RY = ROUTER.y + ROUTER.h / 2;
  ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(RX, ROUTER.y); ctx.lineTo(RX, ROUTER.y - 12); ctx.stroke();
  ctx.fillStyle = checkingProof ? VIO2 : '#3a3a6a'; ctx.beginPath(); ctx.arc(RX, ROUTER.y - 14, 4, 0, 7); ctx.fill();
  ctx.fillStyle = '#10102a'; rr(ctx, ROUTER.x, ROUTER.y, ROUTER.w, ROUTER.h, 24); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.stroke();
  for (let i = 0; i < 3; i++) { ctx.fillStyle = !checkingProof ? '#34345c' : i === (Math.floor(t / 20) % 3) ? '#fff' : '#4c4c86'; ctx.beginPath(); ctx.arc(ROUTER.x + 22, RY - 12 + i * 12, 3, 0, 7); ctx.fill(); }
  if (!checkingProof) { ctx.strokeStyle = '#a598c9'; ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(RX - 17, RY); ctx.lineTo(RX + 17, RY); ctx.stroke(); }
  else { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(RX, RY, 17, 11, 0, 0, 7); ctx.fill(); ctx.fillStyle = '#14142b'; ctx.beginPath(); ctx.arc(RX + Math.sin(t / 40) * 3, RY, 5.5, 0, 7); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(RX + Math.sin(t / 40) * 3 + 2, RY - 2, 1.6, 0, 7); ctx.fill(); }

  // ---- escrow: a wall-mounted safe. Coins fly into its slot; the wheel spins when funds are released.
  { const { x, y, w: sw, h: sh } = SAFE, cx = x + sw / 2;
    const stored = w.coins.filter((k) => k.stored).length, releasing = (steps.settle === 'active' || (steps.settle === 'done' && w.coins.length > 0)) && !failedPre ? 1 : 0;
    const flash = (w.safeFlash ?? 0) / 14, edge = failedPre ? '#ff7a70' : funded ? VIO2 : 'rgba(190,180,230,.5)';
    if (funded) glow(ctx, cx, y + sh / 2, 96, 0.26 + flash * 0.25);
    // wall plate with four bolts, and a soft contact shadow
    ctx.fillStyle = 'rgba(0,0,0,.35)'; rr(ctx, x - 3, y - 1, sw + 14, sh + 14, 20); ctx.fill();
    const plate = ctx.createLinearGradient(0, y - 6, 0, y + sh + 6); plate.addColorStop(0, '#1b1a3b'); plate.addColorStop(1, '#100f27');
    ctx.fillStyle = plate; rr(ctx, x - 7, y - 7, sw + 14, sh + 14, 19); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1.5; ctx.stroke();
    for (const [bx, by] of [[x - 1, y - 1], [x + sw + 1, y - 1], [x - 1, y + sh + 1], [x + sw + 1, y + sh + 1]]) { ctx.fillStyle = '#4a4784'; ctx.beginPath(); ctx.arc(bx, by, 2.6, 0, 7); ctx.fill(); ctx.strokeStyle = '#14132e'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(bx - 1.6, by - 1.6); ctx.lineTo(bx + 1.6, by + 1.6); ctx.stroke(); }
    // body: brushed metal, lit from the top-left
    const bg = ctx.createLinearGradient(x, y, x + sw * 0.7, y + sh); bg.addColorStop(0, '#3b3875'); bg.addColorStop(0.5, '#27254f'); bg.addColorStop(1, '#16152f');
    ctx.fillStyle = bg; rr(ctx, x, y, sw, sh, 15); ctx.fill(); ctx.strokeStyle = edge; ctx.lineWidth = 2.4; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x + 14, y + 2); ctx.lineTo(x + sw - 14, y + 2); ctx.stroke();
    // door: an inset panel with a bevel
    const door = ctx.createLinearGradient(0, y + 8, 0, y + sh - 8); door.addColorStop(0, '#201e45'); door.addColorStop(1, '#121129');
    ctx.fillStyle = door; rr(ctx, x + 9, y + 9, sw - 18, sh - 18, 9); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = 1; rr(ctx, x + 10.5, y + 10.5, sw - 21, sh - 21, 8); ctx.stroke();
    // hinges
    for (const hy of [y + 20, y + sh - 34]) { ctx.fillStyle = '#6a66a8'; rr(ctx, x + 2, hy, 8, 14, 3); ctx.fill(); ctx.fillStyle = '#2a2858'; ctx.fillRect(x + 4.5, hy + 3, 3, 8); }
    // status lamps
    const lamps: [boolean, string][] = [[funded && !failedPre, '#9a85ff'], [releasing === 1, '#5be0a4'], [failedPre, '#ff6a5f']];
    lamps.forEach(([on, col], i) => { const lx = x + 22 + i * 10, ly = y + 21; ctx.fillStyle = '#07061a'; ctx.beginPath(); ctx.arc(lx, ly, 4.2, 0, 7); ctx.fill(); ctx.fillStyle = on ? col : '#25234a'; ctx.beginPath(); ctx.arc(lx, ly, 2.7, 0, 7); ctx.fill(); if (on) glow(ctx, lx, ly, 13, 0.55); });
    // coin slot with a lit lip
    const sy = y + sh * 0.62;
    ctx.fillStyle = '#0b0a20'; rr(ctx, x + 12, sy - 8, 20, 16, 6); ctx.fill(); ctx.strokeStyle = flash > 0 ? '#fff' : '#8f89d8'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.fillStyle = flash > 0 ? '#fff' : '#03030f'; rr(ctx, x + 16, sy - 2.5, 12, 5, 2.5); ctx.fill();
    // window onto the locked coins
    const wx = x + sw - 40, wy = y + 14, ww = 26, wh = 30;
    ctx.fillStyle = '#07071a'; rr(ctx, wx, wy, ww, wh, 7); ctx.fill(); ctx.strokeStyle = 'rgba(190,180,255,.4)'; ctx.lineWidth = 1.6; ctx.stroke();
    for (let i = 0; i < stored; i++) { const cy2 = wy + wh - 8 - i * 5; ctx.fillStyle = '#6f58e6'; ctx.beginPath(); ctx.ellipse(wx + ww / 2, cy2 + 1.2, 8, 3, 0, 0, 7); ctx.fill(); ctx.fillStyle = '#b6a3ff'; ctx.beginPath(); ctx.ellipse(wx + ww / 2, cy2, 8, 3, 0, 0, 7); ctx.fill(); }
    ctx.save(); ctx.beginPath(); rr(ctx, wx, wy, ww, wh, 7); ctx.clip(); ctx.fillStyle = 'rgba(255,255,255,.1)'; ctx.beginPath(); ctx.moveTo(wx + 5, wy); ctx.lineTo(wx + 13, wy); ctx.lineTo(wx + 3, wy + wh); ctx.lineTo(wx - 5, wy + wh); ctx.closePath(); ctx.fill(); ctx.restore();
    // combination dial: ticks, a spoked handle and a hub
    const dx = cx + 12, dy = y + sh - 33, spin = (funded ? 0.35 : 0) + releasing * t * 0.05;
    ctx.fillStyle = '#0d0c25'; ctx.beginPath(); ctx.arc(dx, dy, 22, 0, 7); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(190,180,255,.45)'; ctx.lineWidth = 1.2; for (let i = 0; i < 24; i++) { const a = (i * Math.PI) / 12, r1 = i % 6 === 0 ? 16 : 18.5; ctx.beginPath(); ctx.moveTo(dx + Math.cos(a) * r1, dy + Math.sin(a) * r1); ctx.lineTo(dx + Math.cos(a) * 20.5, dy + Math.sin(a) * 20.5); ctx.stroke(); }
    ctx.save(); ctx.translate(dx, dy); ctx.rotate(spin);
    ctx.strokeStyle = funded ? '#efeaff' : '#9a94c6'; ctx.lineWidth = 3.4; ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) { const a = (i * Math.PI * 2) / 3 - Math.PI / 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * 14, Math.sin(a) * 14); ctx.stroke(); ctx.fillStyle = funded ? '#fff' : '#9a94c6'; ctx.beginPath(); ctx.arc(Math.cos(a) * 15, Math.sin(a) * 15, 2.8, 0, 7); ctx.fill(); }
    ctx.fillStyle = funded ? '#fff' : '#7d78ad'; ctx.beginPath(); ctx.arc(0, 0, 5, 0, 7); ctx.fill(); ctx.fillStyle = funded ? '#5a43d6' : '#2b2850'; ctx.beginPath(); ctx.arc(0, 0, 2, 0, 7); ctx.fill(); ctx.restore();
    // vent slits and the release chute
    ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 1.5; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(x + 15, y + sh - 22 + i * 4.5); ctx.lineTo(x + 36, y + sh - 22 + i * 4.5); ctx.stroke(); }
    ctx.fillStyle = '#05050f'; rr(ctx, x + sw - 28, y + sh - 6, 16, 8, 3); ctx.fill(); ctx.strokeStyle = 'rgba(190,180,255,.35)'; ctx.lineWidth = 1.2; ctx.stroke(); }

  // ---- vault: a rounded safe seen in cross-section, door slides up into the wall
  if (d > 0.02) { ctx.fillStyle = `rgba(150,130,255,${0.1 * d})`; rr(ctx, V.x - 14, V.roof - 14, V.w + 28, roomH + 14, 34); ctx.fill(); }
  ctx.fillStyle = '#10102a'; rr(ctx, V.x, V.roof, V.w, roomH + 20, 26); ctx.fill();
  ctx.strokeStyle = failedPre ? 'rgba(255,90,79,.7)' : d > 0.5 ? 'rgba(190,175,255,.7)' : 'rgba(255,255,255,.16)'; ctx.lineWidth = 2; ctx.stroke();
  const inner = ctx.createLinearGradient(0, V.roof, 0, FLOOR); inner.addColorStop(0, mix('#0b0b1f', '#f1edff', d)); inner.addColorStop(1, mix('#08081a', '#9684ff', d));
  ctx.fillStyle = inner; rr(ctx, V.x + 12, V.roof + 12, V.w - 24, roomH - 12, 16); ctx.fill();
  // doorway: the left wall IS the door. It lifts, opening a hole that belongs to the lit room.
  const doorH = FLOOR - V.gap, openH = doorH * d;
  if (openH > 0.5) { ctx.fillStyle = inner; ctx.fillRect(V.x - 3, FLOOR - openH, V.wall + 8, openH + 1); }
  const leafH = doorH - openH;
  if (leafH > 1) {
    ctx.fillStyle = failedPre ? '#4a2036' : '#1d1d46'; rr(ctx, V.x + 1, V.gap, V.wall - 2, leafH, 4); ctx.fill();
    if (d < 0.25) { ctx.fillStyle = failedPre ? '#ff7a70' : '#7d7dd6'; ctx.beginPath(); ctx.arc(V.x + V.wall / 2, V.gap + doorH / 2, 2.6, 0, 7); ctx.fill(); }
  }
  if (openH > 6) { ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.fillRect(V.x - 1, FLOOR - openH - 1, V.wall + 4, 2); }
  // six lamps on an arch above the roof: each verified property lights one
  for (let i = 0; i < 6; i++) {
    const k = (i - 2.5) / 2.5, x = V.x + V.w / 2 + (i - 2.5) * 25, y = V.roof - 14 - (1 - k * k) * 9, lit = i < nPass, bad = failedPre && i === nPass - 1;
    if (lit && !bad) glow(ctx, x, y, 22, 0.85);
    ctx.fillStyle = bad ? RED : lit ? '#c9bfff' : '#2c2c58'; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fill();
    if (bad) { ctx.fillStyle = 'rgba(255,90,79,.28)'; ctx.beginPath(); ctx.arc(x, y, 13, 0, 7); ctx.fill(); }
  }

  // ---- characters
  const hero = w.blobs[0];
  const heroCore: Core = answered ? 'answer' : phase === 'seal' ? 'cipher' : phase === 'travel' || phase === 'inside' ? 'sealed' : preDone && steps.execute === 'idle' ? 'sealed' : 'plain';
  for (const b of w.blobs.slice(1)) drawBlob(ctx, b, failedPre && b.kind !== 'provider' ? 'o' : 'happy', b.kind === 'provider' ? (settled ? 'coin' : 'none') : 'none', t, b.kind === 'inspector', false);
  const pv = w.priv ?? 0;
  ctx.save();
  if (pv > 0.02) ctx.filter = `blur(${(pv * 7).toFixed(1)}px)`;
  drawBlob(ctx, hero, failedPre ? 'o' : 'happy', heroCore, t, false, answered);
  ctx.restore();
  const hc = centre(hero);
  if (pv > 0.02) {
    // frosted glass over the room, with ciphertext raining down the pane
    ctx.save(); ctx.beginPath(); rr(ctx, V.x + V.wall, V.roof + 12, V.w - V.wall - 12, roomH - 12, 14); ctx.clip();
    ctx.fillStyle = `rgba(120,100,230,${0.34 * pv})`; ctx.fillRect(V.x, V.roof, V.w, roomH);
    const sheen = ctx.createLinearGradient(V.x, V.roof, V.x + V.w, V.roof + roomH); sheen.addColorStop(0, `rgba(255,255,255,${0.16 * pv})`); sheen.addColorStop(0.5, 'rgba(255,255,255,0)'); sheen.addColorStop(1, `rgba(255,255,255,${0.07 * pv})`);
    ctx.fillStyle = sheen; ctx.fillRect(V.x, V.roof, V.w, roomH);
    ctx.font = '600 11px ui-monospace, monospace'; ctx.textAlign = 'center';
    for (let i = 0; i < 8; i++) {
      const gx = V.x + V.wall + 16 + i * ((V.w - V.wall - 32) / 7);
      for (let j = 0; j < 6; j++) {
        const gy = V.roof + 14 + ((t * (0.7 + (i % 3) * 0.25) + i * 41 + j * 36) % (roomH - 10));
        const a = (1 - (j / 6)) * 0.5 * pv;
        ctx.fillStyle = `rgba(226,218,255,${a})`; ctx.fillText(GLYPHS[(i * 5 + j * 3 + Math.floor(t / 11)) % GLYPHS.length], gx, gy);
      }
    }
    ctx.restore();
    // a privacy badge: a closed eye on a soft disc, floating above the agent
    const bx = V.x + V.w / 2 + 6, by = Math.min(hc.y - hero.R - 26, FLOOR - 120) + Math.sin(t / 30) * 2;
    ctx.globalAlpha = Math.min(1, pv * 1.4);
    glow(ctx, bx, by, 34, 0.45);
    ctx.fillStyle = '#1a1744'; ctx.beginPath(); ctx.arc(bx, by, 17, 0, 7); ctx.fill(); ctx.strokeStyle = '#baabff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = '#efeaff'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(bx - 9, by + 1); ctx.quadraticCurveTo(bx, by - 8, bx + 9, by + 1); ctx.quadraticCurveTo(bx, by + 8, bx - 9, by + 1); ctx.stroke();
    ctx.fillStyle = '#efeaff'; ctx.beginPath(); ctx.arc(bx, by + 1, 2.6, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(bx - 9, by - 9); ctx.lineTo(bx + 9, by + 11); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (failedPre) { ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2.5; ctx.setLineDash([]); ctx.beginPath(); ctx.arc(hc.x, hc.y, hero.R + 12, 0, 7); ctx.stroke(); }

  // the forger is the only angular shape in the world
  if (w.forger) { const f = w.forger; ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.a); ctx.fillStyle = RED; ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(22, 16); ctx.lineTo(-22, 16); ctx.closePath(); ctx.fill(); ctx.fillStyle = '#0a0a1a'; ctx.fillRect(-9, 0, 5, 5); ctx.fillRect(4, 0, 5, 5); ctx.restore(); }

  for (const k of w.coins) { if (k.hidden) continue; glow(ctx, k.x, k.y, 15, 0.3); ctx.fillStyle = '#8f7bff'; ctx.beginPath(); ctx.arc(k.x, k.y, 7, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.arc(k.x - 2, k.y - 2, 2.4, 0, 7); ctx.fill(); }
  if (!COMPACT || true) for (const k of w.chips) drawPacket(ctx, k);
  ctx.textAlign = 'start';
}

/* ------------------------------------------------------------------ component */
export const STEP_LIST: { n: number; key: keyof StepMap; title: string }[] = [
  { n: 1, key: 'quote', title: 'Get a price' }, { n: 2, key: 'fund', title: 'Lock payment' }, { n: 3, key: 'preflight', title: 'Verify the vault' },
  { n: 4, key: 'execute', title: 'Send the secret' }, { n: 5, key: 'verify', title: 'Check the answer' }, { n: 6, key: 'settle', title: 'Pay on proof' },
];

export function Stepper({ steps }: { steps: StepMap }) {
  return (
    <ol className="grid grid-cols-3 sm:grid-cols-6 gap-2" aria-label="How a job runs">
      {STEP_LIST.map((s) => {
        const st = steps[s.key];
        const cls = st === 'done' ? 'border-[#1d5c46] text-ok' : st === 'failed' ? 'border-[#6b2b2b] text-bad' : st === 'active' ? 'border-accent text-accent shadow-[0_0_22px_rgba(139,120,255,.25)]' : 'border-line text-mute';
        return (
          <li key={s.n} className={`rounded-2xl border-[1.5px] ${cls} px-3 py-2 bg-black/40 transition`}>
            <div className="text-[11px] mono font-bold">{st === 'done' ? '✓' : st === 'failed' ? '✕' : s.n}</div>
            <div className="text-xs font-semibold leading-tight text-text/90">{s.title}</div>
          </li>
        );
      })}
    </ol>
  );
}

export type StageInfo = { no: number; caption: string; nPass: number; failed: boolean };
export function Stage({ steps, checks, outcome, running, caption: forced, loop, className = '', onInfo, hideCaption, paused = false, sharedFloor = false, anchorsRef }: { anchorsRef?: { current: any };  steps: StepMap; checks: CheckLite[]; outcome: Outcome; running?: boolean; caption?: string; loop?: boolean; className?: string; onInfo?: (i: StageInfo) => void; hideCaption?: boolean; paused?: boolean; sharedFloor?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<World>(createWorld());
  const [phase, setPhase] = useState<Phase>('idle');
  const [compact, setCompact] = useState(false);
  const ctl = useRef<Ctl>({ steps, checks, outcome, phase });
  ctl.current = { steps, checks, outcome, phase, sharedFloor };
  const exec = steps.execute;
  const pauseRef = useRef(paused);
  pauseRef.current = paused;

  useEffect(() => {
    setPhase(exec === 'active' ? 'seal' : 'idle');
    if (exec !== 'active') return;
    let elapsed = 0;
    const id = window.setInterval(() => {
      if (pauseRef.current) return;
      elapsed += 100;
      setPhase(elapsed >= 5600 ? 'inside' : elapsed >= 2300 ? 'travel' : 'seal');
    }, 100);
    return () => clearInterval(id);
  }, [exec]);

  useEffect(() => {
    const cv = canvas.current!; const ctx = cv.getContext('2d')!; const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr);
    let raf = 0, tick = rndGlyphs(9), last = 0;
    draw(ctx, world.current, ctl.current, tick);
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (pauseRef.current || now - last < 15) return; last = now;
      if (world.current.t % 4 === 0) tick = rndGlyphs(9);
      (window as any).__cw = world.current; update(world.current, ctl.current); draw(ctx, world.current, ctl.current, tick);
      if (anchorsRef) {
        const w = world.current, c = (b: Blob) => { const q = centre(b); return { x: q.x, y: q.y, r: b.R }; };
        anchorsRef.current = {
          hero: c(w.blobs[0]), inspector: c(w.blobs[1]), provider: c(w.blobs.find((b) => b.kind === 'provider')!),
          jar: { x: SAFE_C.x, y: SAFE.y, r: 0 }, vault: { x: V.x + V.w / 2, y: V.roof, r: 0 }, door: { x: V.x, y: V.gap, r: 0 },
          market: { x: MARKET.x + MARKET.w / 2, y: FLOOR - 70 * MS, r: 0 },
          router: { x: ROUTER.x + ROUTER.w / 2, y: ROUTER.y + ROUTER.h, r: 0 }, floor: FLOOR, W, H,
          forger: w.forger ? { x: w.forger.x, y: w.forger.y, r: 24 } : null,
          jarCoins: w.coins.filter((k) => k.stored).length,
        };
      }
    };
    raf = requestAnimationFrame(frame);
    const ro = new ResizeObserver(() => { COMPACT = cv.clientWidth < 470; setCompact(COMPACT); }); ro.observe(cv); COMPACT = cv.clientWidth < 470; setCompact(COMPACT);
    const pos = (e: PointerEvent) => { const r = cv.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
    const near = (p: { x: number; y: number }) => { let best: { b: Blob; i: number } | undefined, bd = 30; for (const b of world.current.blobs) b.pts.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { best = { b, i }; bd = d; } }); return best; };
    const down = (e: PointerEvent) => { const p = pos(e), h = near(p); if (h) { world.current.drag = { ...h, ...p }; h.b.joy = 60; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; } };
    const move = (e: PointerEvent) => { const p = pos(e); if (world.current.drag) { world.current.drag.x = p.x; world.current.drag.y = p.y; } else cv.style.cursor = near(p) ? 'grab' : 'default'; };
    const up = () => { world.current.drag = undefined; cv.style.cursor = 'default'; };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up); };
  }, []);

  const failedPre = steps.preflight === 'failed';
  const settled = steps.settle === 'done' && outcome === 'settled';
  const refunded = steps.settle === 'done' && outcome === 'rejected';
  const [no, caption] = ((): [number, string] => {
    if (forced) return [0, forced];
    if (failedPre) return [3, refunded ? 'Forged proof. The vault stayed locked, the secret never left, and the escrow was refunded.' : 'Forged proof detected. The vault stays locked, the secret is never sent and the provider is not paid.'];
    if (settled) return [6, 'A signed verdict releases the escrow to the provider. Public receipt, private work.'];
    if (steps.settle === 'active') return [6, 'The verifier signs a verdict and sends it to the NEAR contract.'];
    if (steps.verify === 'done' || steps.execute === 'done') return [5, 'The vault returns an answer with a signature. The buyer checks it against the attested key.'];
    if (phase === 'seal') return [4, 'The secret is scrambled into ciphertext on the buyer side.'];
    if (phase === 'travel') return [4, 'It travels the private lane straight to the vault. The marketplace API is blind to it.'];
    if (phase === 'inside') return [4, 'Only inside the verified hardware is it decrypted and processed.'];
    if (steps.preflight === 'done') return [3, 'All hardware checks passed. The vault opens and lights the way.'];
    if (steps.preflight === 'active') return [3, 'Before sending anything, check the vault: each verified property lights a lamp.'];
    if (steps.fund === 'active') return [2, 'The payment is locked in an escrow contract on NEAR until a verdict arrives or the order times out.'];
    if (steps.quote === 'active') return [1, 'Ask the marketplace for a price. It only ever sees public details.'];
    if (running) return [0, 'Warming up…'];
    return [0, 'A buyer holds a secret. Press play, or grab a blob and stretch it.'];
  })();

  const nPass = failedPre ? checks.length : steps.preflight === 'done' || steps.execute !== 'idle' ? 6 : Math.min(6, checks.length);
  useEffect(() => { onInfo?.({ no, caption, nPass, failed: failedPre }); }, [no, caption, nPass, failedPre]);
  return (
    <div className={className}>
      <canvas ref={canvas} className="w-full h-auto block" style={{ aspectRatio: `${W} / ${H}`, objectFit: 'cover', objectPosition: 'top', touchAction: 'pan-y' }} role="img" aria-label="Diagram: a buyer verifies a hardware vault, then sends an encrypted secret straight to it, while the marketplace handles public price data and a separate proof checker verifies public evidence for settlement" />
      {!hideCaption && <div className="mt-3 flex items-start gap-3 min-h-[52px]" aria-live="polite">
        <span className={`shrink-0 w-8 h-8 rounded-full grid place-items-center text-sm font-bold ${no ? 'bg-accent text-ink' : 'bg-panel-2 text-mute'}`}>{no || '·'}</span>
        <p className="text-[15px] leading-snug text-text/90 pt-1">{caption}</p>
      </div>}
    </div>
  );
}

export const emptySteps = (): StepMap => ({ draft: 'idle', quote: 'idle', fund: 'idle', preflight: 'idle', execute: 'idle', verify: 'idle', settle: 'idle', receipt: 'idle' });

/** Autoplaying story: one tick = 1s. Happy path ~42s loop, forged-proof path ~32s loop. */
export function useDemoLoop(fail: boolean, paused = false) {
  const [t, setT] = useState(0);
  const period = fail ? 32 : 42;
  useEffect(() => { setT(0); }, [fail]);
  useEffect(() => { if (paused) return; const id = setInterval(() => setT((x) => (x + 1) % period), 1000); return () => clearInterval(id); }, [paused, period]);
  const s = emptySteps();
  if (t >= 1) s.draft = 'done';
  if (t >= 1 && t <= 3) s.quote = 'active'; else if (t > 3) s.quote = 'done';
  if (t >= 4 && t <= 6) s.fund = 'active'; else if (t > 6) s.fund = 'done';
  const nChecks = t >= 8 ? Math.min(6, t - 7) : 0;
  if (t >= 7 && t <= 13) s.preflight = 'active';
  if (t >= 14) s.preflight = fail ? 'failed' : 'done';
  if (!fail) {
    if (t >= 14 && t <= 23) s.execute = 'active'; else if (t >= 24) s.execute = 'done';
    if (t >= 25) s.verify = 'done';
    if (t >= 26 && t <= 27) s.settle = 'active'; else if (t >= 28) s.settle = 'done';
  } else {
    if (t >= 17 && t <= 18) s.settle = 'active'; else if (t >= 19) s.settle = 'done';
  }
  const total = fail ? Math.min(4, nChecks) : nChecks;
  const checks: CheckLite[] = Array.from({ length: total }, (_, i) => ({ status: fail && t >= 14 && i === total - 1 ? 'failed' : 'passed' }));
  return { steps: s, checks, outcome: (s.settle === 'done' ? (fail ? 'rejected' : 'settled') : null) as Outcome };
}
