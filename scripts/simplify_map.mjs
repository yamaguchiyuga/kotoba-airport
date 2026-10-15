// 言葉航空 — 日本地図（japan.geojson）を軽くする
// 使い方:  node scripts/simplify_map.mjs
// 輪郭の点を間引き（ダグラス・ポーカー法）、小さすぎる島を消し、座標の桁を減らす。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'game', 'data', 'japan.geojson');
const TOL = 0.004;       // 間引きの細かさ（度）。約400m より細かい凹凸は省く
const MIN_AREA = 0.0004; // これより小さい島は省く（平方度）

function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// 輪郭は始点と終点が同じ点なので、そのままだと間引けない。半分に分けてから間引く
const simplifyRing = (r, tol) => {
  const m = Math.floor(r.length / 2);
  return [...simplify(r.slice(0, m + 1), tol), ...simplify(r.slice(m), tol).slice(1)];
};
const area = (r) => Math.abs(r.reduce((s, [x, y], i) => { const [x2, y2] = r[(i + 1) % r.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
const round = (r) => r.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]);

const src = JSON.parse(await fs.readFile(FILE, 'utf8'));
const before = (await fs.stat(FILE)).size;
const features = src.features.map((f) => {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const out = polys
    .filter((p) => area(p[0]) >= MIN_AREA)
    .map((p) => p.map((r) => round(simplifyRing(r, TOL))).filter((r) => r.length >= 4));
  return { type: 'Feature', properties: { nam_ja: f.properties.nam_ja }, geometry: { type: 'MultiPolygon', coordinates: out.filter((p) => p.length) } };
});
const txt = JSON.stringify({ type: 'FeatureCollection', features });
await fs.writeFile(FILE, txt);
console.log(`japan.geojson: ${(before / 1e6).toFixed(1)}MB → ${(txt.length / 1e6).toFixed(2)}MB`);
