// 言葉航空 v2 — データ生成スクリプト（世界版）
// 使い方:
//   1) node scripts/build_data.mjs --target 3000 --concurrency 1 --fetch-only --contact 連絡先   … Wikipedia から取得（cache/ に保存）
//   2) node scripts/build_v2.mjs --contact 連絡先                                                 … この スクリプト
//
// 考え方（v1 との違い）
//   v1：言葉の記事がリンクしている「場所の記事」が集まるところを住所にした
//   v2：場所の記事は使わない。言葉どうしのリンク関係だけで「意味の空間での位置」を決め、
//       それを世界中の実在の空港に割り当てる
//
// 手順
//   ① 便（行き先）を決める（v1 と同じルール）
//   ② 言葉ごとに「どの記事にリンクしているか／どの言葉からリンクされているか」を並べた表を作る
//   ③ PPMI（ありふれたリンク先の影響を下げる重み）をかけ、SVD でぎゅっと縮めて「意味のベクトル」にする
//        参考：Mikolov et al. 2013, Stanford CS224U "Distributed word representations"
//   ④ t-SNE で、近い意味の言葉が近くに来るように平面に並べる
//   ⑤ 平面の並びを、世界の空港の並びに対応させる（ヒルベルト曲線の順番どうしを対応させる）
//   ⑥ 成田空港に来た言葉を「言葉界の成田空港」（ゴール）にする

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ARG = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const CONTACT = ARG.contact ?? process.env.KOTOBA_CONTACT ?? '';
const UA = `KotobaKoku/0.3 (university data-visualization class project${CONTACT ? '; ' + CONTACT : ''}) node-fetch`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache');
const OUT_DIR = ARG.out ?? path.join(ROOT, 'game', 'v2', 'data');
const DIM = 64;                 // 意味のベクトルの次元
const START_EXCLUDE_KM = 3000;  // ゴールからこの距離以内はスタート地点にしない
const GOAL_IATA = 'NRT';

// ---------------------------------------------------------------- 共通
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const km = (a, b) => {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
let seedState = 20261022;
const rand = () => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 4294967296; };
const gauss = () => { const u = rand() || 1e-9, v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cacheFile = (key) => path.join(CACHE, crypto.createHash('sha1').update(key).digest('hex') + '.json');
const readCache = async (key) => JSON.parse(await fs.readFile(cacheFile(key), 'utf8'));
async function cached(key, fn) {
  try { return await readCache(key); } catch {}
  const v = await fn();
  await fs.writeFile(cacheFile(key), JSON.stringify(v));
  return v;
}
async function getJSON(url) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status >= 500) { await sleep((Number(r.headers.get('retry-after')) || 5 * (i + 1)) * 1000 + 500); continue; }
      const j = await r.json();
      if (j.error?.code === 'maxlag') { await sleep(5000); continue; }
      return j;
    } catch {}
    await sleep(1500 * (i + 1));
  }
  throw new Error('取得に失敗: ' + url);
}
const JUNK = [/^\d+年$/, /^\d+月\d+日$/, /^\d+月$/, /^\d+世紀$/, /^\d+年代$/, /一覧/, /^\d+$/, /\(曖昧さ回避\)/,
  /^(Wikipedia|Help|ファイル|カテゴリ|Template|ポータル):/, /^紀元前/, /^ISBN$|^ISSN$|^国際標準図書番号$|^デジタルオブジェクト識別子$/];
const isJunk = (t) => JUNK.some((r) => r.test(t));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

// CSV（ダブルクォート内のカンマに対応）
function parseCSV(txt) {
  const parse = (line) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  };
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const head = parse(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(parse(l).map((v, i) => [head[i], v])));
}

// ---------------------------------------------------------------- 本体
async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const { words: allWords, cats } = JSON.parse(await fs.readFile(ARG['words-file'] ?? path.join(CACHE, 'v2_words.json'), 'utf8'));
  const data = {};
  for (const t of allWords) {
    try { data[t] = { L: await readCache('links:' + t), lead: await readCache('lead:' + t) }; } catch {}
  }
  let words = allWords.filter((t) => data[t] && !isJunk(t));
  for (const t of words) data[t].leadSet = new Set(data[t].lead.map((x) => data[t].L.redirects[x] ?? x));
  log(`読み込み: ${words.length}語`);

  // ① 便（v1 と同じルール）。便がなくなった言葉は落として計算し直す
  const linkSet = Object.fromEntries(words.map((t) => [t, new Set(data[t].L.links)]));
  let alive = new Set(words), flights = {};
  for (let pass = 0; pass < 10; pass++) {
    flights = {};
    for (const a of alive) {
      const ca = new Set(cats[a] ?? []);
      flights[a] = data[a].L.links.filter((b) => b !== a && alive.has(b) && !data[a].leadSet.has(b) &&
        !linkSet[b].has(a) && !(cats[b] ?? []).some((c) => ca.has(c)));
    }
    const dead = [...alive].filter((t) => !flights[t].length);
    if (!dead.length) break;
    dead.forEach((t) => alive.delete(t));
  }
  words = [...alive];
  const inbound = {};
  for (const a of words) for (const b of flights[a]) inbound[b] = (inbound[b] ?? 0) + 1;
  log(`① 便: ${words.length}語に便あり`);

  // ② 言葉 × 特徴（リンク先の記事・リンクしてくる言葉）の表
  const vocab = new Set(words);
  const feats = words.map(() => new Set());
  const idx = Object.fromEntries(words.map((t, i) => [t, i]));
  words.forEach((t, i) => {
    for (const f of data[t].L.links) {
      if (isJunk(f)) continue;
      feats[i].add(f);                                  // 自分がリンクしている記事
      if (vocab.has(f)) feats[idx[f]].add('←' + t);    // 相手から見ると「t からリンクされている」
    }
    feats[i].add('自分:' + t);                          // 自分自身（リンクしてくる言葉と同じ列にそろえる）
  });
  // 自分自身の列を「←自分」と同じ扱いにして、A→B と B の特徴が重なるようにする
  words.forEach((t, i) => { feats[i].delete('自分:' + t); feats[i].add('←' + t); });
  const df = new Map();
  for (const s of feats) for (const f of s) df.set(f, (df.get(f) ?? 0) + 1);
  const cols = new Map();
  for (const [f, n] of df) if (n >= 2 && n <= words.length * 0.4) cols.set(f, cols.size);
  const M = cols.size, N = words.length;
  log(`② 特徴: ${M}種類（2語以上が共有するもの）`);

  // ③ PPMI（文脈の分布を 0.75 乗でならす）→ ランダム化 SVD
  const rows = feats.map((s) => [...s].filter((f) => cols.has(f)).map((f) => cols.get(f)));
  const colCount = new Float64Array(M);
  for (const r of rows) for (const c of r) colCount[c]++;
  const total = rows.reduce((a, r) => a + r.length, 0);
  const colP = new Float64Array(M);
  let z = 0; for (let c = 0; c < M; c++) z += colCount[c] ** 0.75;
  for (let c = 0; c < M; c++) colP[c] = colCount[c] ** 0.75 / z;
  const X = rows.map((r) => {
    const pw = r.length / total;
    const ent = r.map((c) => [c, Math.max(0, Math.log((1 / total) / (pw * colP[c])))]).filter(([, v]) => v > 0);
    const norm = Math.hypot(...ent.map(([, v]) => v)) || 1;
    return ent.map(([c, v]) => [c, v / norm]);
  });
  const L = DIM + 16;
  // Y = X Ω（Ω は M×L の乱数行列。列ごとに必要なときだけ作る）
  const omega = new Float32Array(M * L);
  for (let i = 0; i < omega.length; i++) omega[i] = gauss();
  const mulX = (Bmat) => { // X (N×M) × B (M×L) → N×L
    const out = Array.from({ length: N }, () => new Float64Array(L));
    X.forEach((r, i) => { const o = out[i]; for (const [c, v] of r) { const base = c * L; for (let k = 0; k < L; k++) o[k] += v * Bmat[base + k]; } });
    return out;
  };
  const mulXt = (Y) => { // Xᵀ (M×N) × Y (N×L) → M×L（平らな配列）
    const out = new Float64Array(M * L);
    X.forEach((r, i) => { const y = Y[i]; for (const [c, v] of r) { const base = c * L; for (let k = 0; k < L; k++) out[base + k] += v * y[k]; } });
    return out;
  };
  const orth = (Y) => { // 列を直交化（グラム・シュミット）
    for (let k = 0; k < L; k++) {
      for (let j = 0; j < k; j++) { let d = 0; for (let i = 0; i < N; i++) d += Y[i][k] * Y[i][j]; for (let i = 0; i < N; i++) Y[i][k] -= d * Y[i][j]; }
      let n = 0; for (let i = 0; i < N; i++) n += Y[i][k] ** 2; n = Math.sqrt(n) || 1;
      for (let i = 0; i < N; i++) Y[i][k] /= n;
    }
    return Y;
  };
  let Q = orth(mulX(omega));
  for (let it = 0; it < 2; it++) Q = orth(mulX(mulXt(Q)));   // 精度を上げるための繰り返し
  const Bt = mulXt(Q);                                         // Bᵀ = Xᵀ Q（M×L）
  const C = Array.from({ length: L }, () => new Float64Array(L)); // C = B Bᵀ（L×L）
  for (let c = 0; c < M; c++) { const base = c * L; for (let a = 0; a < L; a++) { const va = Bt[base + a]; if (!va) continue; for (let b = a; b < L; b++) C[a][b] += va * Bt[base + b]; } }
  for (let a = 0; a < L; a++) for (let b = 0; b < a; b++) C[a][b] = C[b][a];
  // ヤコビ法で固有値分解
  const V = Array.from({ length: L }, (_, i) => Float64Array.from({ length: L }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < L; p++) for (let q = p + 1; q < L; q++) {
      if (Math.abs(C[p][q]) < 1e-12) continue;
      off += C[p][q] ** 2;
      const th = (C[q][q] - C[p][p]) / (2 * C[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < L; k++) { const a = C[k][p], b = C[k][q]; C[k][p] = cs * a - sn * b; C[k][q] = sn * a + cs * b; }
      for (let k = 0; k < L; k++) { const a = C[p][k], b = C[q][k]; C[p][k] = cs * a - sn * b; C[q][k] = sn * a + cs * b; }
      for (let k = 0; k < L; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = cs * a - sn * b; V[k][q] = sn * a + cs * b; }
    }
    if (off < 1e-18) break;
  }
  const order = [...Array(L).keys()].sort((a, b) => C[b][b] - C[a][a]).slice(0, DIM);
  const vec = Q.map((q) => {
    const v = order.map((j) => { let s = 0; for (let k = 0; k < L; k++) s += q[k] * V[k][j]; return s * Math.sqrt(Math.sqrt(Math.max(0, C[j][j]))); });
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
  log(`③ 意味のベクトル: ${DIM}次元`);
  const cos = (a, b) => { let s = 0; for (let k = 0; k < DIM; k++) s += a[k] * b[k]; return s; };

  // 確認用：いくつかの言葉の「意味のご近所」
  const neighbors = (t, n = 8) => { const i = idx[t] ?? words.indexOf(t); if (i < 0) return null; return words.map((w, j) => [w, cos(vec[i], vec[j])]).filter(([w]) => w !== t).sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w); };
  const sample = ['歌舞伎', '寿司', 'ネコ', '宇宙', '野球', '仏教', '愛', '鉄道', '漫画', '江戸時代'];
  const report = sample.filter((t) => words.includes(t)).map((t) => `  ${t} → ${neighbors(t).join('、')}`);
  await fs.writeFile(path.join(CACHE, 'v2_neighbors.txt'), report.join('\n'));
  console.log('意味のご近所（確認用）:\n' + report.join('\n'));

  // ④ t-SNE で平面に並べる（近い意味の言葉が近くに来るように）
  const Y2 = tsne(vec, { perplexity: 30, iters: 900 });
  if (ARG.debug) await fs.writeFile(path.join(OUT_DIR, 'layout_debug.json'), JSON.stringify({ words, Y2 }));
  log('④ 平面に並べた');

  // ⑤ 世界の空港に割り当てる
  const ap = parseCSV(await fs.readFile(path.join(CACHE, 'ourairports', 'airports.csv'), 'utf8'))
    .filter((r) => r.scheduled_service === 'yes' && r.iata_code && r.type !== 'closed')
    .map((r) => ({ iata: r.iata_code, name: r.name, lat: +r.latitude_deg, lon: +r.longitude_deg, country: r.iso_country, city: r.municipality, type: r.type, wiki: r.wikipedia_link }));
  const rank = { large_airport: 0, medium_airport: 1, small_airport: 2, seaplane_base: 3, heliport: 4 };
  const nAp = Math.min(N, ap.length);
  const chosen = shuffle(ap.slice()).sort((a, b) => rank[a.type] - rank[b.type]).slice(0, nAp);
  if (!chosen.some((a) => a.iata === GOAL_IATA)) chosen[chosen.length - 1] = ap.find((a) => a.iata === GOAL_IATA);
  if (N > nAp) { log(`言葉が空港より多いので ${N - nAp} 語を減らします`); }
  // ヒルベルト曲線の順番：平面上で近いものは順番も近い。言葉の並びと空港の並びを順番どうしで対応させる
  const hilbert = (x, y, n = 1 << 16) => { let d = 0; for (let s = n >> 1; s > 0; s >>= 1) { const rx = (x & s) > 0 ? 1 : 0, ry = (y & s) > 0 ? 1 : 0; d += s * s * ((3 * rx) ^ ry); if (ry === 0) { if (rx === 1) { x = n - 1 - x; y = n - 1 - y; } [x, y] = [y, x]; } } return d; };
  // 0〜1に直す。最小・最大ではなく順位を使うので、飛び離れた点があってもつぶれない
  const norm01 = (vals) => { const ord = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const out = new Array(vals.length); ord.forEach(([, i], r) => { out[i] = r / (vals.length - 1 || 1); }); return out; };
  const wx = norm01(Y2.map((p) => p[0])), wy = norm01(Y2.map((p) => p[1]));
  const wOrder = words.map((t, i) => [i, hilbert(Math.floor(wx[i] * 65535), Math.floor(wy[i] * 65535))]).sort((a, b) => a[1] - b[1]).map(([i]) => i).slice(0, nAp);
  const ax = norm01(chosen.map((a) => a.lon)), ay = norm01(chosen.map((a) => a.lat));
  const aOrder = chosen.map((a, i) => [i, hilbert(Math.floor(ax[i] * 65535), Math.floor(ay[i] * 65535))]).sort((a, b) => a[1] - b[1]).map(([i]) => i);
  const airportOf = {};
  wOrder.forEach((wi, k) => { airportOf[words[wi]] = chosen[aOrder[k]]; });
  words = words.filter((t) => airportOf[t]);

  // ⑥ ゴール：成田空港に来た言葉。便が来ていなければ、便が来ている近くの言葉と空港を入れ替える
  const nrt = chosen.find((a) => a.iata === GOAL_IATA);
  let goal = words.find((t) => airportOf[t] === nrt);
  const inbound2 = {};
  for (const a of words) for (const b of flights[a]) if (airportOf[b]) inbound2[b] = (inbound2[b] ?? 0) + 1;
  if ((inbound2[goal] ?? 0) < 10) {
    const alt = words.filter((t) => (inbound2[t] ?? 0) >= 10).sort((a, b) => km(airportOf[a], nrt) - km(airportOf[b], nrt))[0];
    [airportOf[goal], airportOf[alt]] = [airportOf[alt], airportOf[goal]];
    goal = alt;
  }
  log(`⑥ 言葉界の成田空港: 「${goal}」（便が来ている空港 ${inbound2[goal]}か所）`);

  // 空港の日本語名（英語版 Wikipedia の言語間リンクから）
  const jaName = {};
  const enTitles = [...new Set(words.map((t) => airportOf[t].wiki).filter(Boolean).map((u) => decodeURIComponent(u.split('/wiki/')[1] ?? '').replace(/_/g, ' ')).filter(Boolean))];
  for (let k = 0; k < enTitles.length; k += 50) {
    const chunk = enTitles.slice(k, k + 50);
    const j = await cached('enja:' + chunk.join('|'), async () => {
      await sleep(250);
      return getJSON('https://en.wikipedia.org/w/api.php?' + new URLSearchParams({
        format: 'json', formatversion: 2, maxlag: 5, action: 'query', titles: chunk.join('|'), redirects: 1, prop: 'langlinks', lllang: 'ja', lllimit: 'max',
      }));
    });
    const back = {};
    for (const r of j.query?.normalized ?? []) back[r.to] = [...(back[r.to] ?? []), r.from];
    for (const r of j.query?.redirects ?? []) back[r.to] = [...(back[r.to] ?? []), r.from, ...(back[r.from] ?? [])];
    for (const p of j.query?.pages ?? []) {
      const ja = p.langlinks?.[0]?.title;
      if (!ja) continue;
      for (const name of [p.title, ...(back[p.title] ?? [])]) jaName[name] = ja;
    }
  }
  // 国の日本語名。同じ国コードの地域が複数あるとき（オーストラリアと小さな領土など）は人口の多いほうを使う
  const countryJa = {}, countryPop = {};
  for (const f of JSON.parse(await fs.readFile(path.join(CACHE, 'naturalearth', 'ne_50m_admin_0_countries.geojson'), 'utf8')).features) {
    const p = f.properties;
    if (!p.NAME_JA) continue;
    for (const code of new Set([p.ISO_A2_EH, p.ISO_A2])) {
      if (!code || code === '-99') continue;
      if ((countryPop[code] ?? -1) < (p.POP_EST ?? 0)) { countryJa[code] = p.NAME_JA; countryPop[code] = p.POP_EST ?? 0; }
    }
  }
  const apJa = (a) => { const t = a.wiki ? decodeURIComponent(a.wiki.split('/wiki/')[1] ?? '').replace(/_/g, ' ') : ''; return jaName[t] ?? a.name; };
  log(`空港の日本語名: ${words.filter((t) => jaName[decodeURIComponent((airportOf[t].wiki ?? '').split('/wiki/')[1] ?? '').replace(/_/g, ' ')]).length}/${words.length}`);

  // 書き出し
  const id = Object.fromEntries(words.map((t, i) => [t, i]));
  const counts = words.map((t) => flights[t].filter((b) => id[b] !== undefined).length).sort((a, b) => a - b);
  const qn = (p) => counts[Math.floor(p * (counts.length - 1))];
  const [q1, q2, q3] = [qn(0.25), qn(0.5), qn(0.75)];
  const tierOf = (n) => (n <= q1 ? 1 : n <= q2 ? 2 : n <= q3 ? 3 : 4);
  const g = airportOf[goal];
  const out = {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: '日本語版Wikipedia（CC BY-SA 4.0）、OurAirports（パブリックドメイン）、Natural Earth（パブリックドメイン）',
    goal: id[goal],
    startExcludeKm: START_EXCLUDE_KM,
    words: words.map((t) => {
      const a = airportOf[t];
      const fl = flights[t].filter((b) => id[b] !== undefined);
      // 意味のご近所（種明かし用）
      const i = idx[t];
      const near = words.map((w) => [w, cos(vec[i], vec[idx[w]])]).filter(([w]) => w !== t).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([w]) => w);
      return {
        id: id[t], word: t, lat: a.lat, lon: a.lon, iata: a.iata,
        airport: apJa(a), country: countryJa[a.country] ?? a.country, city: a.city,
        address: `${apJa(a)}（${countryJa[a.country] ?? a.country}）`,
        pref: countryJa[a.country] ?? a.country,     // 画面の「都道府県」欄は v2 では国名
        linksTotal: data[t].L.links.length,
        tier: tierOf(fl.length),
        flights: fl.map((b) => id[b]),
        members: near,                                // v2 では「意味のご近所」の言葉
        distGoalKm: +km(a, g).toFixed(1),
      };
    }),
  };
  await fs.writeFile(path.join(OUT_DIR, 'words.json'), JSON.stringify(out));

  // 世界地図（軽くする：座標を小数2桁に）
  const world = JSON.parse(await fs.readFile(path.join(CACHE, 'naturalearth', 'ne_110m_admin_0_countries.geojson'), 'utf8'));
  const r2 = (c) => (typeof c[0] === 'number' ? [+c[0].toFixed(2), +c[1].toFixed(2)] : c.map(r2));
  const slim = { type: 'FeatureCollection', features: world.features.map((f) => ({ type: 'Feature', properties: { name: f.properties.NAME_JA }, geometry: { type: f.geometry.type, coordinates: r2(f.geometry.coordinates) } })) };
  await fs.writeFile(path.join(OUT_DIR, 'world.geojson'), JSON.stringify(slim));

  const byC = {}; for (const w of out.words) byC[w.country] = (byC[w.country] ?? 0) + 1;
  console.log('\n===== 完成（v2） =====');
  console.log(`空港（言葉）: ${out.words.length}`);
  console.log(`言葉界の成田空港: 「${goal}」 ${apJa(g)}（${g.iata}）`);
  console.log(`  意味のご近所: ${out.words[id[goal]].members.join('、')}`);
  console.log(`  行きの便が出ている空港: ${inbound2[goal]}か所`);
  console.log(`便の数: 中央 ${q2}（段階の境目 ${q1}, ${q2}, ${q3}）`);
  console.log('国別（上位10）:', Object.entries(byC).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c}${n}`).join(' '));
  console.log(`スタート候補（ゴールから${START_EXCLUDE_KM}km以上）: ${out.words.filter((w) => w.distGoalKm > START_EXCLUDE_KM).length}語`);
}

// ---------------------------------------------------------------- t-SNE（近い意味を近くに並べる）
function tsne(vec, { perplexity = 30, iters = 900 } = {}) {
  const N = vec.length, D = vec[0].length;
  // 距離（コサイン距離の2乗に近いもの）
  const dist = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    let s = 0; for (let k = 0; k < D; k++) s += vec[i][k] * vec[j][k];
    const d = Math.max(0, 2 - 2 * s); dist[i * N + j] = d; dist[j * N + i] = d;
  }
  // 各点の近さの分布（パープレキシティで幅を決める）
  const P = new Float64Array(N * N), target = Math.log(perplexity);
  for (let i = 0; i < N; i++) {
    let lo = 1e-20, hi = 1e20, beta = 1;
    for (let it = 0; it < 60; it++) {
      let sum = 0, H = 0;
      for (let j = 0; j < N; j++) { if (j === i) continue; const p = Math.exp(-dist[i * N + j] * beta); P[i * N + j] = p; sum += p; }
      for (let j = 0; j < N; j++) { if (j === i) continue; const p = P[i * N + j] / (sum || 1e-300); P[i * N + j] = p; if (p > 1e-12) H -= p * Math.log(p); }
      if (Math.abs(H - target) < 1e-4) break;
      if (H > target) { lo = beta; beta = hi >= 1e20 ? beta * 2 : (beta + hi) / 2; } else { hi = beta; beta = (beta + lo) / 2; }
    }
  }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const p = Math.max((P[i * N + j] + P[j * N + i]) / (2 * N), 1e-12); P[i * N + j] = p; P[j * N + i] = p; }
  // 平面上の位置を少しずつ動かす
  const Y = Array.from({ length: N }, () => [gauss() * 1e-4, gauss() * 1e-4]);
  const gains = Array.from({ length: N }, () => [1, 1]), upd = Array.from({ length: N }, () => [0, 0]);
  const num = new Float64Array(N * N);
  for (let it = 0; it < iters; it++) {
    const exag = it < 200 ? 4 : 1, mom = it < 200 ? 0.5 : 0.8;
    let sumQ = 0;
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const dx = Y[i][0] - Y[j][0], dy = Y[i][1] - Y[j][1];
      const q = 1 / (1 + dx * dx + dy * dy); num[i * N + j] = q; num[j * N + i] = q; sumQ += 2 * q;
    }
    for (let i = 0; i < N; i++) {
      let gx = 0, gy = 0;
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const q = num[i * N + j], m = (exag * P[i * N + j] - q / sumQ) * q;
        gx += 4 * m * (Y[i][0] - Y[j][0]); gy += 4 * m * (Y[i][1] - Y[j][1]);
      }
      for (const [d, g] of [[0, gx], [1, gy]]) {
        gains[i][d] = Math.sign(g) === Math.sign(upd[i][d]) ? Math.max(0.01, gains[i][d] * 0.8) : gains[i][d] + 0.2;
        upd[i][d] = Math.max(-5, Math.min(5, mom * upd[i][d] - 100 * gains[i][d] * g)); // 1回に動ける距離に上限
        Y[i][d] += upd[i][d];
      }
    }
    // 全体が流れていかないよう中心をそろえる
    let mx = 0, my = 0; for (const p of Y) { mx += p[0]; my += p[1]; } mx /= N; my /= N;
    for (const p of Y) { p[0] -= mx; p[1] -= my; }
    if (it % 100 === 0) log(`  t-SNE ${it}/${iters}`);
  }
  return Y;
}

main().catch((e) => { console.error(e); process.exit(1); });
