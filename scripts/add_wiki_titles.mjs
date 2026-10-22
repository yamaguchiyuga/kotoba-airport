// 言葉航空 v2 — 各言葉（空港）に、その空港の英語版 Wikipedia 記事名を付ける
// 使い方:  node scripts/add_wiki_titles.mjs
// 写真そのものは入れない。ゲーム画面が、着いたときにその場で Wikipedia から写真を取ってくる。
// ネットには接続しない（OurAirports の airports.csv から記事名を読むだけ）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'game', 'v2', 'data', 'words.json');
const CSV = path.join(ROOT, 'cache', 'ourairports', 'airports.csv');

const parse = (line) => {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
};
const lines = (await fs.readFile(CSV, 'utf8')).split(/\r?\n/).filter(Boolean);
const head = parse(lines[0]);
const col = (n) => head.indexOf(n);
const titleOf = {};
for (const l of lines.slice(1)) {
  const r = parse(l);
  const iata = r[col('iata_code')], link = r[col('wikipedia_link')];
  if (!iata || !link || r[col('scheduled_service')] !== 'yes') continue;
  const t = decodeURIComponent(link.split('/wiki/')[1] ?? '').replace(/_/g, ' ');
  if (t) titleOf[iata] = t;
}
const data = JSON.parse(await fs.readFile(FILE, 'utf8'));
let n = 0;
for (const w of data.words) { w.wiki = titleOf[w.iata] ?? ''; if (w.wiki) n++; }
await fs.writeFile(FILE, JSON.stringify(data));
console.log(`記事名を付けた空港: ${n}/${data.words.length}`);
