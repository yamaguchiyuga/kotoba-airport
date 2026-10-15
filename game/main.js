// 言葉航空 — ゲーム本体（外部ライブラリなし）
'use strict';

const CONFIG = {
  timeLimitSec: 60,                        // 制限時間（秒）
  flightMs: [1200, 2200],                  // 飛行アニメーションの長さ（短距離〜長距離）。飛んでいる間もタイマーは進む
  maxZoom: 1500,                           // 自動ズームの最大倍率（東京の密集地で数百mの移動でも見えるように）
  introMs: [700, 3600, 5600],              // 「出発地は……」演出：ルーレット開始・決定・離陸の時刻（ミリ秒）
  slotsByTier: [0, 2, 4, 6, 8],            // 空港の規模ごとの、掲示板に出る便の数（tier 1〜4）
  rotateMsByTier: [0, 6000, 4500, 3000, 2000], // 便が入れ替わる間隔（ハブほど慌ただしい）
  meshNeighbors: 3,                        // 白い網目：各空港を近い何か所とつなぐか
  storageKey: 'kotoba-koku-records-60s',
};

// ---------------------------------------------------------------- 状態
let DATA = null, WORDS = [], GOAL = null, LAND = null;
const S = {
  name: '', cur: null, route: [], legs: 0,
  timeLeft: CONFIG.timeLimitSec, running: false, flying: null,
  board: [], rotateTimer: null, lastTick: 0, ended: false, intro: null,
};

// ---------------------------------------------------------------- 便利関数
const $ = (id) => document.getElementById(id);
const km = (a, b) => {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const fmtTime = (s) => { const d = Math.round(s * 10); return `${Math.floor(d / 600)}:${((d % 600) / 10).toFixed(1).padStart(4, '0')}`; };
const fmtKm = (d) => (d < 10 ? d.toFixed(2) : d < 100 ? d.toFixed(1) : Math.round(d).toString());
const streetView = (w) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${w.lat},${w.lon}`;
const flightCode = (from, to) => {
  let h = 2166136261;
  for (const c of `${from.word}>${to.word}`) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return 'KW' + String((h >>> 0) % 900 + 100);
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- 地図（メルカトル図法・自前）
const VIEW = { lonMin: 122.8, lonMax: 146.2, latMin: 24.0, latMax: 45.8 };
const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
let PROJ = null;
function fitProjection(w, h) {
  const pad = 28;
  const x0 = VIEW.lonMin, x1 = VIEW.lonMax, y0 = merc(VIEW.latMin), y1 = merc(VIEW.latMax);
  const sx = (w - pad * 2) / ((x1 - x0) * Math.PI / 180), sy = (h - pad * 2) / (y1 - y0);
  const s = Math.min(sx, sy);
  const ox = (w - s * (x1 - x0) * Math.PI / 180) / 2, oy = (h - s * (y1 - y0)) / 2;
  PROJ = (lat, lon) => [ox + s * (lon - x0) * Math.PI / 180, h - oy - s * (merc(lat) - y0)];
}

const base = $('base'), live = $('live');
const bctx = base.getContext('2d'), lctx = live.getContext('2d');
let DPR = 1, W = 0, H = 0, MESH = [], LAND_PATH = null;

// ズームとパン：地図上の点 (x, y) は、画面では (x*k+tx, y*k+ty) に描く
const V = { k: 1, tx: 0, ty: 0 };
const scr = (p) => ({ x: p.x * V.k + V.tx, y: p.y * V.k + V.ty, word: p.word });
let HOVER = null;           // マウスが指している空港
let CAM = null;             // カメラの目標 { k: 拡大率, cx, cy: 画面の真ん中に来る地図上の点 }。null なら止まっている

// 指定した空港がちょうど画面に収まるようにカメラを動かす
function camFit(points, maxK = CONFIG.maxZoom) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
  const k = Math.max(1, Math.min(maxK, (W * 0.6) / (bw || 1), (H * 0.6) / (bh || 1)));
  CAM = { k, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 };
}
const camHome = () => { CAM = { k: 1, cx: W / 2, cy: H / 2 }; };

// カメラを目標に向かって少しずつ近づける（毎フレーム呼ぶ）
function stepCamera(dt) {
  if (!CAM) return;
  const a = 1 - Math.exp(-dt * 3.2);
  const ccx = (W / 2 - V.tx) / V.k, ccy = (H / 2 - V.ty) / V.k;
  const k = Math.exp(Math.log(V.k) + (Math.log(CAM.k) - Math.log(V.k)) * a);
  const cx = ccx + (CAM.cx - ccx) * a, cy = ccy + (CAM.cy - ccy) * a;
  V.k = k; V.tx = W / 2 - cx * k; V.ty = H / 2 - cy * k;
  baseDirty = true;
  if (Math.abs(Math.log(V.k / CAM.k)) < 0.002 && Math.hypot(cx - CAM.cx, cy - CAM.cy) * k < 0.5) {
    V.k = CAM.k; V.tx = W / 2 - CAM.cx * CAM.k; V.ty = H / 2 - CAM.cy * CAM.k;
    CAM = null;
  }
}
let baseDirty = true;       // 下の地図を描き直す必要があるか

function resize() {
  const r = $('mapwrap').getBoundingClientRect();
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = r.width; H = r.height;
  for (const c of [base, live]) { c.width = W * DPR; c.height = H * DPR; }
  fitProjection(W, H);
  for (const w of WORDS) [w.x, w.y] = PROJ(w.lat, w.lon);
  Object.assign(V, { k: 1, tx: 0, ty: 0 });
  buildLandPath();
  buildMesh();
  baseDirty = true;
  // 画面の大きさが変わっても（スマホの回転など）、遊んでいる途中なら現在地に寄り直す
  if (S.cur && S.running && !S.flying) camFit([S.cur, GOAL]);
}

// 日本列島の形を一度だけ Path2D（図形データ）にしておく。ズームのたびに作り直さなくて済む
function buildLandPath() {
  LAND_PATH = null;
  if (!LAND) return;
  const p = new Path2D();
  for (const f of LAND.features) {
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) for (const ring of poly) {
      ring.forEach(([lon, lat], i) => { const [x, y] = PROJ(lat, lon); i ? p.lineTo(x, y) : p.moveTo(x, y); });
      p.closePath();
    }
  }
  LAND_PATH = p;
}

function buildMesh() {
  // 各空港を近いk か所とつなぐ → 白いポリゴンの網目に見える
  const k = CONFIG.meshNeighbors, seen = new Set();
  MESH = [];
  const pts = WORDS;
  for (let i = 0; i < pts.length; i++) {
    const near = [];
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const d = (pts[i].x - pts[j].x) ** 2 + (pts[i].y - pts[j].y) ** 2;
      if (near.length < k) { near.push([d, j]); near.sort((a, b) => a[0] - b[0]); }
      else if (d < near[k - 1][0]) { near[k - 1] = [d, j]; near.sort((a, b) => a[0] - b[0]); }
    }
    for (const [d, j] of near) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!seen.has(key) && d < (Math.min(W, H) * 0.12) ** 2) { seen.add(key); MESH.push([pts[i], pts[j]]); }
    }
  }
}

function drawBase() {
  const c = bctx;
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);

  // ここから下は「地図の座標」で描く（ズーム・パンを反映）。線の太さはズームしても変わらないよう 1/k にする
  c.setTransform(DPR * V.k, 0, 0, DPR * V.k, DPR * V.tx, DPR * V.ty);
  const px = 1 / V.k;

  // 経緯線のグリッド
  c.strokeStyle = 'rgba(80,140,255,0.08)'; c.lineWidth = px;
  c.beginPath();
  for (let lon = 124; lon <= 146; lon += 2) { const [x1, y1] = PROJ(VIEW.latMin, lon), [x2, y2] = PROJ(VIEW.latMax, lon); c.moveTo(x1, y1); c.lineTo(x2, y2); }
  for (let lat = 24; lat <= 46; lat += 2) { const [x1, y1] = PROJ(lat, VIEW.lonMin), [x2, y2] = PROJ(lat, VIEW.lonMax); c.moveTo(x1, y1); c.lineTo(x2, y2); }
  c.stroke();

  // 陸地：日本列島を青く塗る（点が日本のどこにあるか分かるように）
  if (LAND_PATH) {
    c.save();
    c.shadowColor = 'rgba(40,110,255,0.55)'; c.shadowBlur = CAM ? 0 : 18;
    c.fillStyle = '#0a2a6e'; c.fill(LAND_PATH);
    c.restore();
    c.strokeStyle = 'rgba(110,170,255,0.55)'; c.lineWidth = 0.7 * px; c.stroke(LAND_PATH);
  }

  // 白い網目
  c.strokeStyle = 'rgba(255,255,255,0.10)'; c.lineWidth = 0.6 * px;
  c.beginPath();
  for (const [a, b] of MESH) { c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); }
  c.stroke();

  // 空港（規模で大きさを変える）。点の大きさは画面上で一定、ズームすると少しだけ大きく
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  const grow = Math.min(2, Math.sqrt(V.k));
  for (const w of WORDS) {
    const p = scr(w);
    if (p.x < -10 || p.y < -10 || p.x > W + 10 || p.y > H + 10) continue;
    const r = [0, 1.1, 1.5, 2.0, 2.8][w.tier] * grow;
    c.fillStyle = w.tier === 4 ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.7)';
    c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill();
  }
  // かなり拡大したら、言葉の名前も小さく出す
  if (V.k >= 4) {
    c.font = '11px "Noto Sans JP", sans-serif'; c.fillStyle = 'rgba(255,255,255,0.55)';
    // 名前同士が重なる場所では、大きい空港の名前を優先して出す
    const taken = new Set();
    const order = WORDS.slice().sort((a, b) => b.tier - a.tier);
    for (const w of order) {
      const p = scr(w);
      if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) continue;
      const tw = c.measureText(w.word).width;
      const cells = [];
      for (let gx = Math.floor((p.x + 4) / 24); gx <= Math.floor((p.x + 4 + tw) / 24); gx++) cells.push(gx + ',' + Math.floor((p.y - 10) / 14));
      if (cells.some((k) => taken.has(k))) continue;
      cells.forEach((k) => taken.add(k));
      c.fillText(w.word, p.x + 4, p.y - 4);
    }
  }
  baseDirty = false;
}

function arcPoint(a, b, t) {
  // 2点を結ぶ弧（少し持ち上げた二次ベジェ）
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const lift = Math.min(160, len * 0.35);
  let nx = -dy / len, ny = dx / len;
  if (ny > 0) { nx = -nx; ny = -ny; } // 常に画面の上側へふくらませる
  const cx = mx + nx * lift, cy = my + ny * lift;
  const u = 1 - t;
  return [u * u * a.x + 2 * u * t * cx + t * t * b.x, u * u * a.y + 2 * u * t * cy + t * t * b.y];
}

const BLUE = '#4fc3ff', BLUE_GLOW = 'rgba(79,195,255,1)';

function strokeArc(c, a, b, upto = 1) {
  c.beginPath();
  for (let s = 0; s <= upto + 0.0001; s += 0.02) { const [x, y] = arcPoint(a, b, Math.min(s, upto)); s ? c.lineTo(x, y) : c.moveTo(x, y); }
  c.stroke();
}

function drawLive(now) {
  if (baseDirty) drawBase();
  const c = lctx;
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.clearRect(0, 0, W, H);
  if (!GOAL) return;

  // 通ってきた航路（遊んでいる間は青い点線、終わったら光らせる）
  if (S.ended && S.showRoute) drawRouteGlow(c, now);
  else {
    c.strokeStyle = 'rgba(120,210,255,0.85)'; c.lineWidth = 1.8; c.setLineDash([5, 4]);
    for (let i = 1; i < S.route.length; i++) strokeArc(c, scr(S.route[i - 1]), scr(S.route[i]));
    c.setLineDash([]);
  }

  // ゴール（言葉界の東京駅）
  const pulse = (Math.sin(now / 300) + 1) / 2;
  const g = scr(GOAL);
  c.strokeStyle = '#fff'; c.lineWidth = 1.5;
  c.beginPath(); c.arc(g.x, g.y, 7 + pulse * 6, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.moveTo(g.x - 14, g.y); c.lineTo(g.x + 14, g.y); c.moveTo(g.x, g.y - 14); c.lineTo(g.x, g.y + 14); c.stroke();
  label(c, g.x + 12, g.y - 10, `GOAL ${GOAL.word}`);

  // 現在地
  if (S.cur && !S.flying && !S.intro && !S.ended) {
    const p = scr(S.cur);
    c.fillStyle = '#fff';
    c.beginPath(); c.arc(p.x, p.y, 5, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.6)';
    c.beginPath(); c.arc(p.x, p.y, 10 + pulse * 4, 0, Math.PI * 2); c.stroke();
    label(c, p.x + 12, p.y + 16, S.cur.word);
  }

  // 飛行中の機体：これから飛ぶ道をうっすら、飛んだ分を光る青で描く
  if (S.flying) {
    const { to, t0 } = S.flying;
    const from = scr(S.flying.from), dest = scr(to);
    const t = Math.min(1, (now - t0) / S.flying.ms);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    c.strokeStyle = 'rgba(120,210,255,0.45)'; c.lineWidth = 1; c.setLineDash([2, 4]);
    strokeArc(c, from, dest);
    c.setLineDash([]);
    c.save();
    c.shadowColor = BLUE_GLOW; c.shadowBlur = 12;
    c.strokeStyle = BLUE; c.lineWidth = 4;
    strokeArc(c, from, dest, e);
    c.restore();
    c.strokeStyle = '#e6f6ff'; c.lineWidth = 1.4;
    strokeArc(c, from, dest, e);
    c.fillStyle = BLUE;
    c.beginPath(); c.arc(dest.x, dest.y, 3 + pulse * 3, 0, Math.PI * 2); c.fill();
    const [px, py] = arcPoint(from, dest, e), [qx, qy] = arcPoint(from, dest, Math.min(1, e + 0.01));
    c.save(); c.translate(px, py); c.rotate(Math.atan2(qy - py, qx - px));
    c.shadowColor = BLUE_GLOW; c.shadowBlur = 10;
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(9, 0); c.lineTo(-6, -5); c.lineTo(-3, 0); c.lineTo(-6, 5); c.closePath(); c.fill();
    c.restore();
    label(c, px + 10, py - 10, `${to.word} 行き`);
    $('hud-dist').textContent = `${fmtKm(S.flying.from.distGoalKm + (to.distGoalKm - S.flying.from.distGoalKm) * e)} km`;
    if (t >= 1) land(to);
  }

  // 「出発地は……」ルーレット中に光っている空港
  if (S.intro?.spot) {
    const p = scr(S.intro.spot), d = S.intro.decided;
    c.save(); c.shadowColor = BLUE_GLOW; c.shadowBlur = 16;
    c.fillStyle = d ? '#fff' : BLUE;
    c.beginPath(); c.arc(p.x, p.y, d ? 7 : 5, 0, Math.PI * 2); c.fill();
    c.restore();
    c.strokeStyle = d ? '#fff' : BLUE; c.lineWidth = 1.5;
    c.beginPath(); c.arc(p.x, p.y, (d ? 14 : 10) + pulse * 6, 0, Math.PI * 2); c.stroke();
  }

  // マウスが指している空港の名前と住所
  if (HOVER) {
    const p = scr(HOVER);
    c.strokeStyle = BLUE; c.lineWidth = 1.5;
    c.beginPath(); c.arc(p.x, p.y, 7, 0, Math.PI * 2); c.stroke();
    tooltip(c, p.x + 12, p.y - 14, HOVER.word, HOVER.address || '', HOVER.desc || '');
  }
}

function label(c, x, y, text) {
  c.font = '700 12px "Noto Sans JP", sans-serif';
  const w = c.measureText(text).width;
  if (x + w + 8 > W) x = W - w - 8;
  c.fillStyle = 'rgba(0,0,0,0.75)'; c.fillRect(x - 4, y - 12, w + 8, 17);
  c.fillStyle = '#fff'; c.fillText(text, x, y);
}

// 文字数で折り返す（日本語は単語の区切りがないので1文字ずつ測る）
function wrapText(c, text, maxW) {
  const lines = []; let line = '';
  for (const ch of text) {
    if (c.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; } else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}

function tooltip(c, x, y, title, sub, desc = '') {
  const DESC_W = Math.min(260, W * 0.6);
  c.font = '900 15px "Noto Sans JP", sans-serif';
  const w1 = c.measureText(title).width;
  c.font = '11px "Noto Sans JP", sans-serif';
  const w2 = c.measureText(sub).width;
  c.font = '12px "Noto Sans JP", sans-serif';
  const lines = desc ? wrapText(c, desc, DESC_W) : [];
  const w3 = lines.length ? Math.max(...lines.map((l) => c.measureText(l).width)) : 0;
  const w = Math.max(w1, w2, w3) + 16, h = (sub ? 42 : 26) + (lines.length ? lines.length * 17 + 6 : 0);
  if (x + w > W - 4) x = x - w - 24;
  if (x < 12) x = 12;
  if (y + h - 16 > H - 4) y = H - 4 - h + 16;
  if (y - 16 < 4) y = 20;
  c.fillStyle = 'rgba(0,8,30,0.94)'; c.fillRect(x - 8, y - 16, w, h);
  c.strokeStyle = BLUE; c.lineWidth = 1; c.strokeRect(x - 8 + 0.5, y - 16 + 0.5, w - 1, h - 1);
  c.fillStyle = '#fff'; c.font = '900 15px "Noto Sans JP", sans-serif'; c.fillText(title, x, y);
  if (sub) { c.fillStyle = '#9fc2ff'; c.font = '11px "Noto Sans JP", sans-serif'; c.fillText(sub, x, y + 18); }
  c.fillStyle = '#e8eefc'; c.font = '12px "Noto Sans JP", sans-serif';
  lines.forEach((l, i) => c.fillText(l, x, y + (sub ? 18 : 0) + 22 + i * 17));
}

// ---------------------------------------------------------------- マウス操作（ホバー・ズーム・ドラッグ）
function nearestWord(mx, my, maxPx = 14) {
  let best = null, bd = maxPx * maxPx;
  for (const w of WORDS) {
    const p = scr(w), d = (p.x - mx) ** 2 + (p.y - my) ** 2;
    if (d < bd) { bd = d; best = w; }
  }
  return best;
}

function zoomAt(mx, my, factor) {
  const k = Math.max(1, Math.min(CONFIG.maxZoom, V.k * factor));
  const f = k / V.k;
  V.tx = mx - (mx - V.tx) * f; V.ty = my - (my - V.ty) * f; V.k = k;
  clampView();
  baseDirty = true;
}
function clampView() {
  // 日本が画面の外に飛んでいかないように
  if (V.k === 1) { V.tx = 0; V.ty = 0; return; }
  V.tx = Math.min(W * 0.5, Math.max(W * 0.5 - W * V.k, V.tx));
  V.ty = Math.min(H * 0.5, Math.max(H * 0.5 - H * V.k, V.ty));
}

function setupPointer() {
  const el = $('mapwrap');
  const pos = (e) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  let drag = null;
  const touches = new Map();
  let pinch = null;

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    CAM = null;
    const [mx, my] = pos(e);
    zoomAt(mx, my, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#hud-top, #map-tools')) return;
    touches.set(e.pointerId, pos(e));
    el.setPointerCapture(e.pointerId);
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
      drag = null;
    } else {
      const [mx, my] = pos(e);
      drag = { x: mx, y: my, tx: V.tx, ty: V.ty, moved: false };
    }
  });
  el.addEventListener('pointermove', (e) => {
    const [mx, my] = pos(e);
    if (touches.has(e.pointerId)) touches.set(e.pointerId, [mx, my]);
    if (pinch && touches.size === 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinch.d);
      pinch.d = d;
      return;
    }
    if (drag) {
      const dx = mx - drag.x, dy = my - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) CAM = null;
      if (drag.moved && V.k > 1) { V.tx = drag.tx + dx; V.ty = drag.ty + dy; clampView(); baseDirty = true; }
    }
    HOVER = nearestWord(mx, my, e.pointerType === 'touch' ? 24 : 14);
    el.style.cursor = drag?.moved && V.k > 1 ? 'grabbing' : HOVER ? 'pointer' : V.k > 1 ? 'grab' : 'default';
  });
  const up = (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (drag && !drag.moved) {
      // タップ／クリック：一番近い空港の名前を出す（スマホ用）
      const [mx, my] = pos(e);
      HOVER = nearestWord(mx, my, e.pointerType === 'touch' ? 24 : 14);
    }
    drag = null;
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') HOVER = null; });
  el.addEventListener('dblclick', camHome);

  $('zoom-in').addEventListener('click', () => { CAM = null; zoomAt(W / 2, H / 2, 1.6); });
  $('zoom-out').addEventListener('click', () => { CAM = null; zoomAt(W / 2, H / 2, 1 / 1.6); });
  $('zoom-reset').addEventListener('click', camHome);
  $('zoom-here').addEventListener('click', () => S.cur && camFit([S.cur, GOAL]));
}

// ---------------------------------------------------------------- ゲーム進行
function loop(now) {
  const dt = Math.min(0.1, (now - S.lastTick) / 1000);
  stepCamera(dt);
  if (S.intro) stepIntro(now);
  if (S.running && !S.ended) {
    S.timeLeft = Math.max(0, S.timeLeft - dt);
    if (S.timeLeft <= 0) endGame(false);
  }
  S.lastTick = now;
  $('hud-time').textContent = fmtTime(S.timeLeft);
  $('hud-time').classList.toggle('warn', S.running && S.timeLeft < 15);
  drawLive(now);
  requestAnimationFrame(loop);
}

function startGame() {
  S.name = $('name').value.trim() || 'NO NAME';
  const candidates = WORDS.filter((w) => w !== GOAL && w.distGoalKm > DATA.startExcludeKm && w.flights.length && REACHABLE.has(w.id));
  const start = pick(candidates.length ? candidates : WORDS);
  Object.assign(S, { cur: start, route: [start], legs: 0, timeLeft: CONFIG.timeLimitSec, running: false, flying: null, ended: false, showRoute: null });
  $('hud-name').textContent = S.name;
  $('hud-legs').textContent = 0;
  $('hud-dist').textContent = '— km';
  $('screen-start').classList.add('hidden');
  $('screen-brief').classList.add('hidden');
  $('screen-end').classList.add('hidden');
  clearInterval(S.rotateTimer);
  $('flights').innerHTML = ''; $('board-foot').textContent = '';
  $('here-word').textContent = '……'; $('here-addr').textContent = '出発地を抽選中'; $('here-desc').textContent = '';
  $('here-meta').textContent = ''; $('board-total').textContent = '';
  $('here-sv').removeAttribute('href');
  startIntro(performance.now(), start);
}

// ---------------------------------------------------------------- 搭乗前の説明（スキップできる）
const BRIEF_EXAMPLES = [
  ['ポルトガル', '鉄砲を伝えたポルトガル人が流れ着いた島。'],
  ['フォーブス (雑誌)', '世界の大富豪を載せる経済誌の住所は、あの自動車会社の本社。'],
  ['なめろう', '千葉・房総の郷土料理なのに、住所は宮崎の島。'],
  ['地震学', '決め手は1889年の熊本地震。'],
];
function briefPages() {
  const g = GOAL;
  const ex = BRIEF_EXAMPLES.map(([w, note]) => [WORDS.find((x) => x.word === w), note]).filter(([w]) => w);
  return [
    { title: 'ルール', html: `<ul class="brief-list">
      <li>言葉界の東京駅<b>「${esc(g.word)}」</b>を目指す。</li>
      <li><b>出発便</b>から行き先を選んで、言葉から言葉へ乗り継ぐ。</li>
      <li>制限時間は<b>${CONFIG.timeLimitSec}秒</b>。</li>
      <li>時間切れのとき、ゴールに一番近い人が勝ち。</li>
    </ul>` },
    { title: '言葉の住所', html: `<p class="brief-big">言葉に、架空の住所を設定しました。</p>` },
    { title: '偶然の一致', html: `<ul class="brief-ex">${ex.map(([w, note]) => `<li><b>${esc(w.word.replace(/ \(.*\)$/, ''))}</b> → ${esc(w.address)}<br><span class="dim">${esc(note)}</span></li>`).join('')}</ul>` },
  ];
}
let BRIEF_PAGE = 0;
function showBrief() {
  BRIEF_PAGE = 0;
  $('screen-start').classList.add('hidden');
  $('screen-brief').classList.remove('hidden');
  renderBrief();
}
function renderBrief() {
  const pages = briefPages(), p = pages[BRIEF_PAGE];
  $('brief-step').textContent = `${BRIEF_PAGE + 1} / ${pages.length}`;
  $('brief-title').textContent = p.title;
  $('brief-body').innerHTML = p.html;
  $('brief-next').textContent = BRIEF_PAGE === pages.length - 1 ? '出発する ▶' : '次へ ▶';
}
function finishBrief() {
  $('screen-brief').classList.add('hidden');
  startGame();
}

// ---------------------------------------------------------------- 「出発地は……」の演出
// ルーレットのように言葉が次々に光り、だんだん遅くなって出発地が決まる → そこへズーム → 離陸
function startIntro(now, start) {
  const [t1, t2] = CONFIG.introMs;
  const times = [];
  for (let t = t1, gap = 55; t < t2 - 250; gap *= 1.13) { times.push(t); t += gap; }
  const pool = WORDS.filter((w) => w !== start && w !== GOAL);
  S.intro = { t0: now, start, times, words: times.map(() => pick(pool)), shown: -1, decided: false, spot: null };
  camHome();
  $('intro').classList.remove('hidden', 'decided', 'go');
  $('intro-lead').textContent = '出発地は……';
  $('intro-word').textContent = '';
  $('intro-addr').textContent = '';
}

function stepIntro(now) {
  const I = S.intro, t = now - I.t0;
  const [, t2, t3] = CONFIG.introMs;
  if (t < t2) {
    let i = -1;
    while (i + 1 < I.times.length && I.times[i + 1] <= t) i++;
    if (i !== I.shown && i >= 0) {
      I.shown = i; I.spot = I.words[i];
      $('intro-word').textContent = I.spot.word;
      $('intro-addr').textContent = I.spot.pref || '';
    }
  } else if (!I.decided) {
    I.decided = true; I.spot = I.start;
    $('intro').classList.add('decided');
    $('intro-word').textContent = I.start.word;
    $('intro-addr').textContent = I.start.address;
    camFit([I.start, GOAL]);
  } else if (t >= t3) {
    S.intro = null;
    $('intro').classList.add('go');
    setTimeout(() => $('intro').classList.add('hidden'), 500);
    S.running = true;
    arrive(I.start);
  }
}

function arrive(w) {
  S.cur = w;
  $('here-word').textContent = w.word;
  $('here-addr').textContent = w.address || '—';
  $('here-desc').textContent = w.desc || '';
  $('here-sv').href = streetView(w);
  $('here-meta').textContent = `${['', '地方空港', '中規模空港', '拠点空港', 'ハブ空港'][w.tier]} / ${w.lat.toFixed(4)}, ${w.lon.toFixed(4)}`;
  $('board-total').textContent = `本日の発着 ${w.linksTotal}便`;
  $('hud-dist').textContent = `${fmtKm(w.distGoalKm)} km`;
  $('hud-legs').textContent = S.legs;
  if (w === GOAL) return endGame(true);
  setupBoard(w);
}

// 便を「ゴールに近づく便」と「遠ざかる便」に分け、掲示板には半分ずつ出す
function setupBoard(w) {
  clearInterval(S.rotateTimer);
  const slots = Math.min(CONFIG.slotsByTier[w.tier], w.flights.length);
  const shuffle = (a) => a.sort(() => Math.random() - 0.5);
  const near = shuffle(w.flights.filter((id) => WORDS_BY_ID[id].distGoalKm < w.distGoalKm));
  const far = shuffle(w.flights.filter((id) => WORDS_BY_ID[id].distGoalKm >= w.distGoalKm));
  const isFar = (b) => b.distGoalKm >= w.distGoalKm;
  // 遠ざかる便を半分（足りなければ近づく便で埋める。逆も同じ）
  let nFar = Math.min(far.length, Math.floor(slots / 2));
  let nNear = Math.min(near.length, slots - nFar);
  nFar = Math.min(far.length, slots - nNear);
  S.board = shuffle([...far.slice(0, nFar), ...near.slice(0, nNear)]).map((id) => WORDS_BY_ID[id]);
  renderBoard(-1);
  $('board-foot').textContent = w.flights.length > slots ? '便は随時入れ替わります' : '';
  if (w.flights.length > slots) {
    S.rotateTimer = setInterval(() => {
      if (S.flying || S.ended) return;
      const shown = new Set(S.board.map((b) => b.id));
      const i = Math.floor(Math.random() * S.board.length);
      // 入れ替えるときは、同じ側（近づく／遠ざかる）の便と交代させて、半分ずつを保つ
      const same = (isFar(S.board[i]) ? far : near).filter((id) => !shown.has(id));
      const rest = same.length ? same : w.flights.filter((id) => !shown.has(id));
      if (!rest.length) return;
      S.board[i] = WORDS_BY_ID[pick(rest)];
      renderBoard(i);
    }, CONFIG.rotateMsByTier[w.tier]);
  }
}

function renderBoard(newIndex) {
  const ol = $('flights');
  ol.innerHTML = '';
  S.board.forEach((to, i) => {
    const li = document.createElement('li');
    if (i === newIndex) li.className = 'new';
    li.innerHTML = `<button><span class="code">${flightCode(S.cur, to)}</span><span class="dest">${esc(to.word)} 行き</span><span class="stat">BOARDING</span></button>`;
    li.querySelector('button').addEventListener('click', () => takeFlight(to));
    ol.appendChild(li);
  });
}

function takeFlight(to) {
  if (S.flying || S.ended) return;
  clearInterval(S.rotateTimer);
  document.querySelectorAll('#flights button').forEach((b) => (b.disabled = true));
  // 長く飛ぶほど時間がかかる（1000km で最長）
  const [msMin, msMax] = CONFIG.flightMs;
  const ms = msMin + (msMax - msMin) * Math.min(1, km(S.cur, to) / 1000);
  S.flying = { from: S.cur, to, t0: performance.now(), ms };
  // 出発地と行き先が両方入るまで引く（近い移動ほど大きく拡大される）
  camFit([S.cur, to]);
}

function land(to) {
  S.flying = null;
  S.legs++;
  S.route.push(to);
  camFit([to, GOAL]);
  arrive(to);
}

function endGame(reached) {
  if (S.ended) return;
  S.ended = true; S.running = false;
  clearInterval(S.rotateTimer);
  const used = CONFIG.timeLimitSec - S.timeLeft;
  const rec = { name: S.name, reached, time: +used.toFixed(1), dist: S.cur.distGoalKm, legs: S.legs, last: S.cur.word, at: Date.now() };
  const all = loadRecords(); all.push(rec); saveRecords(all);

  $('end-kind').textContent = reached ? 'ARRIVED' : 'TIME UP';
  $('end-result').innerHTML = reached
    ? `言葉界の東京駅「${esc(GOAL.word)}」に到着！<br>${fmtTime(used)}・${S.legs}便`
    : `「${esc(S.cur.word)}」で時間切れ<br>ゴールまで ${fmtKm(S.cur.distGoalKm)} km`;
  $('end-route').textContent = '航路：' + S.route.map((w) => w.word).join(' → ');
  renderRanking(rec);
  renderReveal();
  S.showRoute = { t0: performance.now() };
  camFit([...S.route, GOAL]);
  setTimeout(() => $('screen-end').classList.remove('hidden'), 1200);
}

// ---------------------------------------------------------------- 種明かし（終了画面）
// 言葉の住所の決め方・自分が立ち寄った言葉の決め手・言葉の住所の分布
const shortName = (t) => t.replace(/ \(.*\)$/, '');
function renderReveal() {
  const ex = WORDS.find((w) => w.word === '蘭学');
  const exText = ex
    ? `たとえば「蘭学」の記事は、${ex.members.slice(0, 3).map(shortName).join('・')}など、長崎の場所にたくさんリンクしています。だから蘭学の住所は長崎（${esc(ex.address)}）。`
    : '';
  const goalWhy = GOAL.members.slice(0, 3).map(shortName).join('・');

  // 立ち寄った言葉（同じ言葉は1回だけ）
  const visited = [...new Set(S.route)];
  const visitedHtml = visited.map((w) => `<li><b>${esc(w.word)}</b> → ${esc(w.address)}<br>
    <span class="dim">決め手：${esc(w.members.slice(0, 3).map(shortName).join('・') || '—')}</span></li>`).join('');

  // 都道府県ごとの言葉の数（上位5）と、そこに住んでいる言葉の例
  const byPref = {};
  for (const w of WORDS) (byPref[w.pref] ??= []).push(w);
  const top = Object.entries(byPref).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  const max = top[0][1].length;
  const tokyo = (byPref['東京都'] ?? []).length;
  const share = Math.round((tokyo / WORDS.length) * 100);
  const bars = top.map(([pref, ws]) => {
    const sample = ws.filter((w) => w !== GOAL).sort(() => Math.random() - 0.5).slice(0, 3).map((w) => esc(w.word)).join('、');
    return `<li><span class="bar-label">${esc(pref)}</span><span class="bar"><i style="width:${(ws.length / max) * 100}%"></i></span><span class="bar-n">${ws.length}語</span>
      <div class="bar-ex">${sample} …</div></li>`;
  }).join('');

  $('end-reveal').innerHTML = `
    <h2>種明かし</h2>
    <p>どの言葉の Wikipedia 記事も、その言葉にゆかりのある場所へリンクしています。そのリンク先が地図の上で<b>いちばん集まっているところ</b>を、その言葉の住所にしました。</p>
    <p>${exText}ゴールの「${esc(GOAL.word)}」が東京駅のそばに住んでいるのも、${esc(goalWhy)}にリンクしているからです。</p>
    <p>住所はデタラメではありません。言葉が生まれ、語られてきた<b>「舞台」</b>が住所になっています。この地図は、言葉の記憶を日本地図に描いたものです。</p>
    <h2>あなたが立ち寄った言葉の決め手</h2>
    <ul class="reveal-list">${visitedHtml}</ul>
    <h2>言葉はどこに住んでいる？</h2>
    <p>${WORDS.length}語のうち<b>${tokyo}語（${share}%）が東京都</b>に住んでいます。新聞社・出版社・劇場・官庁など、記事がリンクする場所の多くが東京にあるからです。言葉の世界にも「東京一極集中」がありました。</p>
    <ol class="bars">${bars}</ol>`;
}

// 自分がたどった航路を、光る線と番号つきの言葉で描く（終了画面の後ろ）
function drawRouteGlow(c, now) {
  const pts = S.route.map(scr);
  const legMs = Math.max(250, Math.min(700, 4000 / Math.max(1, pts.length - 1)));
  const prog = (now - S.showRoute.t0) / legMs;           // 何区間目まで描いたか（小数つき）
  const pulse = (Math.sin(now / 260) + 1) / 2;
  for (let i = 1; i < pts.length; i++) {
    const p = Math.max(0, Math.min(1, prog - (i - 1)));
    if (p <= 0) break;
    c.save();
    c.shadowColor = BLUE_GLOW; c.shadowBlur = 14 + pulse * 10;
    c.strokeStyle = BLUE; c.lineWidth = 4;
    strokeArc(c, pts[i - 1], pts[i], p);
    c.restore();
    c.strokeStyle = '#eaf8ff'; c.lineWidth = 1.5;
    strokeArc(c, pts[i - 1], pts[i], p);
  }
  // 番号つきの言葉（同じ場所に何度も来たら番号をまとめる）
  const shown = Math.min(pts.length, Math.floor(prog) + 1);
  const seen = new Map();
  for (let i = 0; i < shown; i++) {
    const w = S.route[i];
    seen.set(w, [...(seen.get(w) ?? []), i + 1]);
  }
  // 名前が重なるときは、空いている高さまで下にずらす
  const boxes = [];
  c.font = '700 12px "Noto Sans JP", sans-serif';
  for (const [w, nums] of seen) {
    const p = scr(w);
    c.save(); c.shadowColor = BLUE_GLOW; c.shadowBlur = 12;
    c.fillStyle = '#fff'; c.beginPath(); c.arc(p.x, p.y, 4.5, 0, Math.PI * 2); c.fill();
    c.restore();
    const text = `${nums.join('・')}. ${w.word}`;
    const tw = c.measureText(text).width + 8;
    let x = p.x + 9, y = p.y - 8;
    if (x + tw > W) x = W - tw;
    for (let n = 0; n < 12 && boxes.some((b) => x < b.x + b.w && b.x < x + tw && y - 12 < b.y + 5 && b.y - 12 < y + 5); n++) y += 18;
    boxes.push({ x, y, w: tw });
    if (y !== p.y - 8) { c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1; c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(x, y - 4); c.stroke(); }
    label(c, x, y, text);
  }
  // 全部描き終わったら、最後のほうで固まっている場所（東京など）に寄る
  if (!S.showRoute.zoomed && prog > pts.length + 1.5) {
    S.showRoute.zoomed = true;
    const last = S.route[S.route.length - 1];
    const tail = [...new Set([...S.route, GOAL])].filter((w) => km(w, last) < 50);
    if (tail.length >= 2 && tail.length < S.route.length + 1) camFit(tail);
  }
}

// ---------------------------------------------------------------- 記録（この端末のブラウザに保存）
let MEMORY_RECORDS = [];
function loadRecords() {
  try { return JSON.parse(localStorage.getItem(CONFIG.storageKey)) ?? MEMORY_RECORDS; } catch { return MEMORY_RECORDS; }
}
function saveRecords(r) {
  MEMORY_RECORDS = r;
  try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(r)); } catch {}
}
function rankSort(a, b) {
  if (a.reached !== b.reached) return a.reached ? -1 : 1;     // 到着した人が上
  if (a.reached) return a.time - b.time || a.legs - b.legs;   // 到着者は早い順
  return a.dist - b.dist || a.time - b.time;                  // 未到着は近い順
}
function renderRanking(me) {
  const list = loadRecords().sort(rankSort);
  const ol = $('ranking'); ol.innerHTML = '';
  list.slice(0, 10).forEach((r, i) => {
    const li = document.createElement('li');
    if (r.at === me.at) li.className = 'me';
    li.innerHTML = `<span>${i + 1}</span><span>${esc(r.name)}</span><span>${r.reached ? '到着 ' + fmtTime(r.time) : fmtKm(r.dist) + ' km'}</span>`;
    ol.appendChild(li);
  });
  const rank = list.findIndex((r) => r.at === me.at);
  if (rank >= 10) {
    const li = document.createElement('li'); li.className = 'me';
    li.innerHTML = `<span>${rank + 1}</span><span>${esc(me.name)}</span><span>${me.reached ? '到着 ' + fmtTime(me.time) : fmtKm(me.dist) + ' km'}</span>`;
    ol.appendChild(li);
  }
}

// ---------------------------------------------------------------- 起動
let WORDS_BY_ID = {};
const REACHABLE = new Set();
async function boot() {
  try {
    const [d, land] = await Promise.all([
      fetch('data/words.json?v=11').then((r) => r.json()),
      fetch('data/japan.geojson').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    DATA = d; LAND = land; WORDS = d.words;
    WORDS_BY_ID = Object.fromEntries(WORDS.map((w) => [w.id, w]));
    GOAL = WORDS_BY_ID[d.goal];
    // ゴールまで便を乗り継いでたどり着ける言葉だけをスタート候補にする（ゴールから逆向きにたどる）
    const inbound = {};
    for (const w of WORDS) for (const id of w.flights) (inbound[id] ??= []).push(w.id);
    const queue = [GOAL.id];
    REACHABLE.add(GOAL.id);
    while (queue.length) for (const from of inbound[queue.shift()] ?? []) if (!REACHABLE.has(from)) { REACHABLE.add(from); queue.push(from); }
    $('goal-word').textContent = `「${GOAL.word}」`;
    $('hud-dist-lbl').textContent = `${GOAL.word}（${GOAL.pref.replace(/[都道府県]$/, '')}）まで`;
    $('load-msg').textContent = `空港 ${WORDS.length} か所 / 言葉界の東京駅は「${GOAL.word}」（${GOAL.address}）`;
    resize();
    setupPointer();
    const ready = () => ($('btn-start').disabled = !$('name').value.trim());
    $('name').addEventListener('input', ready);
    $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('btn-start').disabled) showBrief(); });
    $('btn-start').addEventListener('click', showBrief);
    $('brief-skip').addEventListener('click', finishBrief);
    $('brief-next').addEventListener('click', () => { if (++BRIEF_PAGE >= briefPages().length) finishBrief(); else renderBrief(); });
    $('btn-again').addEventListener('click', () => { camHome(); $('screen-end').classList.add('hidden'); $('screen-start').classList.remove('hidden'); $('name').focus(); });
    window.addEventListener('resize', resize);
    $('name').focus();
    requestAnimationFrame((t) => { S.lastTick = t; loop(t); });
  } catch (e) {
    $('load-msg').textContent = 'データを読み込めませんでした。scripts/build_data.mjs を先に実行し、ローカルサーバーで開いてください。';
    console.error(e);
  }
}
boot();
