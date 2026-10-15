// 言葉航空 — データ生成スクリプト
// 使い方:  node scripts/build_data.mjs [--target 1500] [--concurrency 3]
// Node.js 18 以上（fetch 内蔵）。外部ライブラリ不要。
// 途中で止めても cache/ に結果が残るので、再実行すると続きから進む。

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 設定
const ARG = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const TARGET_WORDS = Number(ARG.target ?? 1500);   // 空港（言葉）の数の目標
const CONCURRENCY = Number(ARG.concurrency ?? 3);  // 同時リクエスト数。増やすと Wikipedia に止められる
const CLUSTER_KM = 30;                             // 「密集」とみなす半径
const START_EXCLUDE_KM = 30;                       // ゴールからこの距離以内はスタート地点にしない
const TOKYO_STATION = { lat: 35.681236, lon: 139.767125 };
const JAPAN_BBOX = { latMin: 20, latMax: 46, lonMin: 122, lonMax: 154 };
// Wikipedia のルールで、名乗り（User-Agent）には連絡先を入れる。公開されるコードに残らないよう、実行時に --contact で渡す
const CONTACT = ARG.contact ?? process.env.KOTOBA_CONTACT ?? '';
const UA = `KotobaKoku/0.2 (university data-visualization class project${CONTACT ? '; ' + CONTACT : ''}) node-fetch`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache');
const OUT_DIR = path.join(ROOT, 'game', 'data');

// ジャンルごとの種（seed）。ここからリンクをたどって言葉を集める。
// ジャンルをばらけさせることで、言葉同士の関係が見えにくくなる。
const SEEDS = {
  食べ物: ['ラーメン', '寿司', 'カレーライス', '天ぷら', '納豆', '味噌', '日本酒', 'コーヒー', 'パン', '野菜'],
  動物: ['ネコ', 'イヌ', 'パンダ', 'カラス', 'カエル', 'クマ', 'ウナギ', 'ツル', '金魚', 'ゴキブリ'],
  自然: ['富士山', '火山', '温泉', '台風', '地震', '雪', '桜', '森林', '島', '滝'],
  宇宙と科学: ['宇宙', '月', '太陽', '数学', '物理学', '化学', '人工知能', 'ロボット', 'インターネット', '原子爆弾'],
  歴史: ['侍', '忍者', '城', '天皇', '明治維新', '江戸時代', '戦国時代', '縄文時代', '第二次世界大戦', '鎖国'],
  宗教と信仰: ['神社', '寺院', '仏教', '神道', '妖怪', '河童', '天狗', '幽霊', '墓', '葬儀'],
  文化と芸能: ['歌舞伎', '落語', '能', '茶道', '書道', '俳句', '漫画', 'アニメ', '演歌', '映画'],
  スポーツ: ['相撲', '野球', 'サッカー', '柔道', '剣道', '将棋', '囲碁', 'マラソン', '競馬', 'プロレス'],
  暮らし: ['結婚', '誕生日', '正月', 'クリスマス', '花火', '祭り', '着物', '傘', '時計', 'コンビニエンスストア'],
  社会と経済: ['株式', '銀行', '税金', '年金', '選挙', '憲法', '少子化', '観光', '漁業', '農業'],
  乗り物: ['鉄道', '新幹線', '飛行機', '自動車', '自転車', '船', '港', '空港', '路面電車', 'ロープウェイ'],
  感情と抽象: ['愛', '孤独', '幸福', '夢', '笑い', '涙', '眠り', '平和', '死', '時間'],
};

// 言葉として使わない記事（年号・日付・一覧・曖昧さ回避など）
const JUNK = [/^\d+年$/, /^\d+月\d+日$/, /^\d+月$/, /^\d+世紀$/, /^\d+年代$/, /一覧/, /^\d+$/, /\(曖昧さ回避\)/,
  /^(Wikipedia|Help|ファイル|カテゴリ|Template|ポータル):/];
const isJunk = (t) => JUNK.some((r) => r.test(t));

// ---------------------------------------------------------------- 共通関数
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const km = (a, b) => {
  const R = 6371, r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};
const inJapan = (c) => c.lat > JAPAN_BBOX.latMin && c.lat < JAPAN_BBOX.latMax && c.lon > JAPAN_BBOX.lonMin && c.lon < JAPAN_BBOX.lonMax;
// 毎回同じ順番に混ぜる（乱数の種を固定）。こうすると --target を増やして再実行しても、取得済みの言葉がそのまま使える
let seedState = 20261015;
const rand = () => { seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0; return seedState / 4294967296; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function cached(key, fn) {
  const f = path.join(CACHE, crypto.createHash('sha1').update(key).digest('hex') + '.json');
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch {}
  const v = await fn();
  await fs.writeFile(f, JSON.stringify(v));
  return v;
}

// アクセスの間隔をあける。「多すぎる」と言われたら、全員そろって指定の秒数だけ待つ
const MIN_GAP_MS = Number(ARG.gap ?? 250);
let nextSlot = 0, pausedUntil = 0;
async function gate() {
  for (;;) {
    const now = Date.now();
    if (now < pausedUntil) { await sleep(pausedUntil - now); continue; }
    if (now < nextSlot) { await sleep(nextSlot - now); continue; }
    nextSlot = now + MIN_GAP_MS;
    return;
  }
}

async function getJSON(url) {
  for (let i = 0; i < 12; i++) {
    await gate();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } });
      const t = await r.text();
      if (r.ok && t.startsWith('{')) {
        const j = JSON.parse(t);
        // サーバーが混んでいる合図（maxlag）。言われた秒数だけ待ってやり直す
        if (j.error?.code === 'maxlag') { pausedUntil = Math.max(pausedUntil, Date.now() + (Number(r.headers.get('retry-after')) || 5) * 1000); continue; }
        return j;
      }
      if (r.status === 429 || r.status >= 500) {
        const wait = (Number(r.headers.get('retry-after')) || 5 * (i + 1)) * 1000 + 500;
        if (Date.now() + wait > pausedUntil) {
          pausedUntil = Date.now() + wait;
          console.log(`  …アクセスが多すぎると言われたので ${Math.round(wait / 1000)} 秒待ちます`);
        }
        continue;
      }
    } catch {}
    await sleep(1500 * (i + 1));
  }
  throw new Error('取得に失敗: ' + url);
}

const WP = 'https://ja.wikipedia.org/w/api.php?format=json&formatversion=2&';
const wp = (params) => getJSON(WP + new URLSearchParams({ maxlag: 5, ...params }).toString());

async function pool(items, n, fn, label) {
  let i = 0, done = 0;
  const out = new Array(items.length);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; console.warn('  !', items[k], e.message); }
      if (++done % 50 === 0 || done === items.length) {
        const s = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`  ${label}: ${done}/${items.length} (${s}s)`);
      }
    }
  }));
  return out;
}

// ---------------------------------------------------------------- Wikipedia から取る情報
// 記事の基本情報（転送の解決・曖昧さ回避かどうか・カテゴリ）。50件ずつまとめて取る。
async function fetchInfo(titles) {
  const res = {};
  for (let k = 0; k < titles.length; k += 50) {
    const chunk = titles.slice(k, k + 50);
    const j = await cached('info:' + chunk.join('|'), () => wp({
      action: 'query', titles: chunk.join('|'), redirects: 1,
      prop: 'categories|pageprops', clshow: '!hidden', cllimit: 'max', ppprop: 'disambiguation',
    }));
    const redir = Object.fromEntries((j.query?.redirects ?? []).map((r) => [r.from, r.to]));
    const norm = Object.fromEntries((j.query?.normalized ?? []).map((r) => [r.from, r.to]));
    const pages = Object.fromEntries((j.query?.pages ?? []).map((p) => [p.title, p]));
    for (const t of chunk) {
      const n = norm[t] ?? t;
      const resolved = redir[n] ?? n;
      const p = pages[resolved];
      if (!p || p.missing) continue;
      res[t] = {
        title: resolved,
        disambig: !!p.pageprops?.disambiguation,
        categories: (p.categories ?? []).map((c) => c.title.replace(/^Category:/, '')),
      };
    }
  }
  return res;
}

// 記事の全リンク（転送解決済み）と、そのうち座標を持つもの
async function fetchLinks(title) {
  return cached('links:' + title, async () => {
    let cont = {};
    const links = new Set();
    const coords = {};
    const redirects = {};
    for (let g = 0; g < 30; g++) {
      const j = await wp({
        action: 'query', titles: title, redirects: 1, generator: 'links', gplnamespace: 0, gpllimit: 'max',
        prop: 'coordinates', colimit: 'max', coprimary: 'primary', ...cont,
      });
      for (const r of j.query?.redirects ?? []) redirects[r.from] = r.to;
      for (const p of j.query?.pages ?? []) {
        if (p.missing) continue;
        links.add(p.title);
        if (p.coordinates?.[0]) coords[p.title] = { lat: p.coordinates[0].lat, lon: p.coordinates[0].lon };
      }
      if (j.continue) cont = j.continue; else break;
    }
    return { links: [...links], coords, redirects };
  });
}

// 冒頭（最初の見出しより前・インフォボックス含む）のリンク。わかりやすすぎる関係なので便から外す。
async function fetchLeadLinks(title) {
  return cached('lead:' + title, async () => {
    const j = await wp({ action: 'parse', page: title, prop: 'links', section: 0, redirects: 1 });
    return (j.parse?.links ?? []).filter((l) => l.ns === 0).map((l) => l.title);
  });
}

// 国土地理院の逆ジオコーダ（緯度経度 → 市区町村コード・町名）
let MUNI = null;
async function loadMuni() {
  const txt = await cached('muni.js', async () => {
    const r = await fetch('https://maps.gsi.go.jp/js/muni.js', { headers: { 'User-Agent': UA } });
    return await r.text();
  });
  MUNI = {};
  // 形式: GSI.MUNI_ARRAY["13101"] = '13,東京都,13101,千代田区';
  for (const m of txt.matchAll(/MUNI_ARRAY\["(\d+)"\]\s*=\s*'(\d+),([^,]+),(\d+),([^']*)'/g)) {
    MUNI[String(Number(m[1]))] = { pref: m[3], city: m[5].replace(/　/g, '') };
  }
}
async function reverseGeocode(c) {
  const key = `rg:${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  const j = await cached(key, () => getJSON(
    `https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${c.lat}&lon=${c.lon}`));
  const r = j?.results;
  if (!r?.muniCd) return null; // 海の上など
  const m = MUNI[String(Number(r.muniCd))] ?? { pref: '', city: '' };
  return { pref: m.pref, city: m.city, town: r.lv01Nm === '－' ? '' : r.lv01Nm };
}

// ---------------------------------------------------------------- 本体
async function main() {
  await fs.mkdir(CACHE, { recursive: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  // 1) 種の言葉を解決する
  console.log('1/7 種の言葉を確認');
  const seedTitles = Object.values(SEEDS).flat();
  const seedInfo = await fetchInfo(seedTitles);
  const seeds = Object.entries(SEEDS).map(([genre, ts]) => ({
    genre, titles: ts.map((t) => seedInfo[t]?.title).filter(Boolean),
  }));
  const missing = seedTitles.filter((t) => !seedInfo[t]);
  if (missing.length) console.log('  見つからなかった種:', missing.join(', '));

  // 2) 種の本文リンクから、ジャンルが均等になるように言葉を集める
  console.log('2/7 言葉を集める');
  const allSeedTitles = seeds.flatMap((s) => s.titles);
  const seedLinks = await pool(allSeedTitles, CONCURRENCY, async (t) => {
    const [L, lead] = await Promise.all([fetchLinks(t), fetchLeadLinks(t)]);
    const leadSet = new Set(lead.map((x) => L.redirects[x] ?? x));
    return L.links.filter((x) => !leadSet.has(x) && !isJunk(x));
  }, '種のリンク');
  const linksBySeed = Object.fromEntries(allSeedTitles.map((t, i) => [t, shuffle(seedLinks[i] ?? [])]));

  const vocab = new Set(allSeedTitles);
  const perGenre = Math.ceil((TARGET_WORDS * 1.3) / seeds.length); // 後で落ちる分を見越して多めに
  for (const s of seeds) {
    let added = 0, round = 0;
    while (added < perGenre && round < 200) {
      let progressed = false;
      for (const t of s.titles) {
        const cand = linksBySeed[t].shift();
        if (cand && !vocab.has(cand)) { vocab.add(cand); added++; progressed = true; }
        if (added >= perGenre) break;
      }
      if (!progressed) break;
      round++;
    }
  }
  let words = [...vocab];
  console.log(`  候補: ${words.length}語`);

  // 3) 基本情報（曖昧さ回避を除外、カテゴリ取得）
  console.log('3/7 基本情報');
  const info = await fetchInfo(words);
  words = [...new Set(words.map((t) => info[t]).filter((x) => x && !x.disambig && !isJunk(x.title)).map((x) => x.title))];
  const cats = Object.fromEntries(Object.values(info).map((x) => [x.title, x.categories]));

  // 4) 各言葉のリンク・座標・冒頭リンク
  console.log('4/7 リンクと座標（ここが一番時間がかかる）');
  const data = {};
  const got = await pool(words, CONCURRENCY, async (t) => {
    const [L, lead] = await Promise.all([fetchLinks(t), fetchLeadLinks(t)]);
    return { L, lead: lead.map((x) => L.redirects[x] ?? x) };
  }, 'リンク');
  words.forEach((t, i) => { if (got[i]) data[t] = got[i]; });
  words = words.filter((t) => data[t]);

  // 5) 住所（緯度経度）を決める
  //    どの言葉からもよくリンクされる場所（省庁・出版社・テレビ局など）は重みを下げる（IDF）
  console.log('5/7 住所を計算');
  const df = {};
  for (const t of words) for (const p of Object.keys(data[t].L.coords)) df[p] = (df[p] ?? 0) + 1;
  const N = words.length;
  const weight = (p) => Math.max(0, Math.log((N + 1) / (df[p] + 1)));

  const place = {};
  for (const t of words) {
    const pts = Object.entries(data[t].L.coords)
      .filter(([, c]) => inJapan(c))
      .map(([name, c]) => ({ name, ...c, w: weight(name) }))
      .filter((p) => p.w > 0);
    if (!pts.length) continue;
    let best = null, bestScore = -1;
    for (const p of pts) {
      const s = pts.reduce((a, q) => a + (km(p, q) < CLUSTER_KM ? q.w : 0), 0);
      if (s > bestScore) { bestScore = s; best = p; }
    }
    const cl = pts.filter((q) => km(best, q) < CLUSTER_KM);
    const W = cl.reduce((a, q) => a + q.w, 0);
    const center = { lat: cl.reduce((a, q) => a + q.lat * q.w, 0) / W, lon: cl.reduce((a, q) => a + q.lon * q.w, 0) / W };
    const heaviest = cl.reduce((a, q) => (q.w > a.w ? q : a));
    place[t] = { center, heaviest, members: cl.sort((a, b) => b.w - a.w).slice(0, 6).map((q) => q.name) };
  }
  words = words.filter((t) => place[t]);

  // 6) 逆ジオコーディング。海に落ちたら一番重い地点（陸）に寄せる
  console.log('6/7 実住所に変換');
  await loadMuni();
  const addr = await pool(words, CONCURRENCY, async (t) => {
    let c = place[t].center;
    let a = await reverseGeocode(c);
    if (!a) { c = { lat: place[t].heaviest.lat, lon: place[t].heaviest.lon }; a = await reverseGeocode(c); }
    return a ? { ...a, ...c } : null;
  }, '住所');
  words.forEach((t, i) => { if (addr[i]) place[t].addr = addr[i]; });
  words = words.filter((t) => place[t].addr);

  // 7) 便（行き先）を決める
  //    ・本文のリンクのみ（冒頭リンクは除外）
  //    ・お互いにリンクし合っている言葉は除外（関係が強すぎる）
  //    ・同じカテゴリを持つ言葉は除外（同じジャンル）
  //    便がなくなった言葉は落とし、落とした結果で再計算する
  console.log('7/7 便を計算');
  const linkSet = Object.fromEntries(words.map((t) => [t, new Set(data[t].L.links)]));
  let alive = new Set(words);
  let flights = {};
  for (let pass = 0; pass < 10; pass++) {
    flights = {};
    for (const a of alive) {
      const lead = new Set(data[a].lead);
      const ca = new Set(cats[a] ?? []);
      flights[a] = data[a].L.links.filter((b) =>
        b !== a && alive.has(b) && !lead.has(b) &&
        !linkSet[b].has(a) &&
        !(cats[b] ?? []).some((c) => ca.has(c)));
    }
    const dead = [...alive].filter((t) => flights[t].length === 0);
    if (!dead.length) break;
    dead.forEach((t) => alive.delete(t));
  }
  words = [...alive];

  // ゴール＝実際の東京駅に一番近い住所になった言葉
  //   （たどり着けないと困るので、どこかの言葉から便が来ている言葉の中から選ぶ）
  const inbound = {};
  for (const a of words) for (const b of flights[a]) inbound[b] = (inbound[b] ?? 0) + 1;
  for (const t of words) place[t].distToStation = km(place[t].addr, TOKYO_STATION);
  const goal = words.filter((t) => inbound[t] > 0)
    .reduce((a, t) => (place[t].distToStation < place[a].distToStation ? t : a));
  const goalPos = place[goal].addr;

  // 空港の規模（便の数の段階）。便の数の分布の四分位で4段階に分ける
  const counts = words.map((t) => flights[t].length).sort((a, b) => a - b);
  const q = (p) => counts[Math.floor(p * (counts.length - 1))];
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
  const tierOf = (n) => (n <= q1 ? 1 : n <= q2 ? 2 : n <= q3 ? 3 : 4);

  const id = Object.fromEntries(words.map((t, i) => [t, i]));
  const out = {
    builtAt: new Date().toISOString(),
    source: '日本語版Wikipedia（CC BY-SA 4.0）、国土地理院 逆ジオコーダ',
    tokyoStation: TOKYO_STATION,
    goal: id[goal],
    startExcludeKm: START_EXCLUDE_KM,
    words: words.map((t) => {
      const a = place[t].addr;
      return {
        id: id[t],
        word: t,
        lat: +a.lat.toFixed(6),
        lon: +a.lon.toFixed(6),
        address: `${a.pref}${a.city}${a.town}`,
        pref: a.pref,
        linksTotal: data[t].L.links.length,       // 掲示板の「本日の発着」に出す本物のリンク数
        tier: tierOf(flights[t].length),         // 1=地方空港 … 4=ハブ空港
        flights: flights[t].map((b) => id[b]),
        members: place[t].members,               // 住所を決めた場所の記事（デバッグ・解説用）
        distGoalKm: +km(a, goalPos).toFixed(3),
      };
    }),
  };
  await fs.writeFile(path.join(OUT_DIR, 'words.json'), JSON.stringify(out));

  // 日本地図（都道府県の輪郭）。まだなければダウンロードする
  const geo = path.join(OUT_DIR, 'japan.geojson');
  try { await fs.access(geo); } catch {
    console.log('日本地図をダウンロード');
    const r = await fetch('https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson');
    await fs.writeFile(geo, await r.text());
  }

  // まとめ
  const near = (k) => out.words.filter((w) => w.distGoalKm < k).length;
  console.log('\n===== 完成 =====');
  console.log(`空港（言葉）: ${out.words.length}`);
  console.log(`言葉界の東京駅: 「${goal}」 ${place[goal].addr.pref}${place[goal].addr.city}${place[goal].addr.town}` +
    `（実際の東京駅から ${place[goal].distToStation.toFixed(2)} km）`);
  console.log(`  決め手になった場所: ${place[goal].members.join('、')}`);
  console.log(`  「${goal}」行きの便が出ている空港: ${inbound[goal]}か所`);
  console.log(`ゴールから 5km以内: ${near(5)}語 / 30km以内: ${near(30)}語 / 100km以内: ${near(100)}語`);
  console.log(`便の数: 最小 ${counts[0]} / 中央 ${q2} / 最大 ${counts.at(-1)}（段階の境目 ${q1}, ${q2}, ${q3}）`);
  const byPref = {};
  for (const w of out.words) byPref[w.pref] = (byPref[w.pref] ?? 0) + 1;
  console.log('都道府県別（上位10）:', Object.entries(byPref).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p, n]) => `${p}${n}`).join(' '));
  console.log('出力: game/data/words.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
