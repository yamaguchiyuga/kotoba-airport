// 言葉航空 — 各言葉に Wikipedia の短い説明（記事冒頭の最初の一文）を付ける
// 使い方:  node scripts/add_desc.mjs --contact あなたの連絡先
// game/data/words.json の各言葉に desc を追加して上書きする。取得結果は cache/ に残る。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ARG = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const CONTACT = ARG.contact ?? process.env.KOTOBA_CONTACT ?? '';
const UA = `KotobaKoku/0.2 (university data-visualization class project${CONTACT ? '; ' + CONTACT : ''}) node-fetch`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache');
const FILE = ARG.file ? path.resolve(ARG.file) : path.join(ROOT, 'game', 'data', 'words.json');  // --file で v2 などのファイルも指定できる
const MAX_CHARS = 80;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status >= 500) {
        const wait = (Number(r.headers.get('retry-after')) || 5 * (i + 1)) * 1000 + 500;
        console.log(`  …アクセスが多すぎると言われたので ${Math.round(wait / 1000)} 秒待ちます`);
        await sleep(wait); continue;
      }
      const j = await r.json();
      if (j.error?.code === 'maxlag') { await sleep(5000); continue; }
      return j;
    } catch {}
    await sleep(1500 * (i + 1));
  }
  throw new Error('取得に失敗: ' + url);
}

async function cached(key, fn) {
  const f = path.join(CACHE, crypto.createHash('sha1').update(key).digest('hex') + '.json');
  try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch {}
  const v = await fn();
  await fs.writeFile(f, JSON.stringify(v));
  return v;
}

// 記事の冒頭から「最初の一文」を取り出し、読み仮名などのカッコ書きを消して短くする
function shorten(text) {
  if (!text) return '';
  let s = text.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 5; i++) s = s.replace(/（[^（）]*）|\([^()]*\)/g, '');
  s = s.replace(/\s+([、。])/g, '$1').trim();
  const end = s.indexOf('。');
  if (end >= 0) s = s.slice(0, end + 1);
  if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS - 1) + '…';
  return s;
}

const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
await fs.mkdir(CACHE, { recursive: true });
const titles = data.words.map((w) => w.word);
const desc = {};
for (let k = 0; k < titles.length; k += 20) {
  const chunk = titles.slice(k, k + 20);
  const j = await cached('extract:' + chunk.join('|'), async () => {
    await sleep(250);
    return getJSON('https://ja.wikipedia.org/w/api.php?' + new URLSearchParams({
      format: 'json', formatversion: 2, maxlag: 5, action: 'query', titles: chunk.join('|'), redirects: 1,
      prop: 'extracts', exintro: 1, explaintext: 1, exlimit: 20,
    }));
  });
  const redir = Object.fromEntries((j.query?.redirects ?? []).map((r) => [r.from, r.to]));
  const norm = Object.fromEntries((j.query?.normalized ?? []).map((r) => [r.from, r.to]));
  const pages = Object.fromEntries((j.query?.pages ?? []).map((p) => [p.title, p.extract]));
  for (const t of chunk) { const n = norm[t] ?? t; desc[t] = shorten(pages[redir[n] ?? n]); }
  if ((k / 20) % 10 === 0) console.log(`  説明: ${Math.min(k + 20, titles.length)}/${titles.length}`);
}
for (const w of data.words) w.desc = desc[w.word] ?? '';
await fs.writeFile(FILE, JSON.stringify(data));
const empty = data.words.filter((w) => !w.desc).length;
console.log(`完了：${data.words.length - empty}語に説明を付けました（取れなかった言葉 ${empty}語）`);
for (const w of data.words.slice(0, 5)) console.log(` ・${w.word}：${w.desc}`);
