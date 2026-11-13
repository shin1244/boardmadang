#!/usr/bin/env node
// 시제품을 돌려 보는 도구. "둘 수 있는 수" 형태(simple.js)로 쓴 게임 폴더를 검사하거나 플레이그라운드로 엽니다.
// 게임 파일에는 import가 없습니다. 여기서 toGame()으로 지금의 게임 API로 바꿔서 원래 도구(check.js, 플레이그라운드)에 넘깁니다.
// 정식으로 넣게 되면 이 변환이 npx boardmadang과 사이트의 실행기 안으로 들어가고, 이 파일은 없어집니다.
//
//   node sdk/experimental/try.js check sdk/experimental/twelve
//   node sdk/experimental/try.js dev sdk/experimental/twelve     → http://localhost:5174 (다른 포트는 맨 뒤에)

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkGame } from '../check.js';
import { idOf } from '../lib/dev.js';
import { gameEntry, saveThumbnail } from '../lib/games.js';
import { json, sendFile } from '../lib/http.js';
import { toGame } from './simple.js';

const SDK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, dir = '.', port = '5174'] = process.argv.slice(2);
const folder = path.resolve(dir);
if (!['check', 'dev'].includes(command) || !fs.existsSync(path.join(folder, 'index.js'))) {
  console.error('usage: node sdk/experimental/try.js <check | dev> <game folder> [port]');
  process.exit(1);
}

if (command === 'check') {
  const game = toGame((await import(pathToFileURL(path.join(folder, 'index.js')).href)).default);
  const { problems, warnings, stats } = checkGame(game, { n: 200, langs: ['en', 'ko'] });
  for (const p of problems) console.log(`  ✖ ${p}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  if (stats) {
    const { n, tally, avgMoves, avgMs, maxMs } = stats;
    console.log(`  ${n} random games: first player won ${tally[0]} · second player won ${tally[1]} · draws ${tally.draw + tally.maxActions}`
      + ` · ${avgMoves.toFixed(1)} moves on average · play() ${avgMs.toFixed(3)}ms average, ${maxMs.toFixed(2)}ms max`);
  }
  console.log(problems.length ? `Fix ${problems.length} problem(s).` : 'All checks passed.');
  process.exit(problems.length ? 1 : 0);
}

// dev: 플레이그라운드가 불러오는 모듈(/play.js)이 게임을 toGame()으로 감싸서 내보냅니다
const id = idOf(folder);
const WRAPPER = `import game from '/games/${id}/index.js';\nimport { toGame } from '/sdk/experimental/simple.js';\nexport default toGame(game);\n`;
const SDK_FILES = ['check.js', 'experimental/simple.js', 'playground/index.html', 'playground/playground.js', 'playground/playground.css',
  'playground/board.js', 'playground/listing.js', 'playground/platform.js'];

http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (p === '/') {
    res.writeHead(302, { Location: `/sdk/playground/?game=${id}` });
    return res.end();
  }
  if (p === '/api/games') return json(res, 200, [gameEntry(folder, { id, module: '/play.js' })]);
  if (p === '/play.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(WRAPPER);
  }
  if (p === `/api/games/${id}/thumbnail` && req.method === 'PUT') return saveThumbnail(req, res, folder);
  const sdk = p === '/sdk/playground/' ? 'playground/index.html' : p.startsWith('/sdk/') ? p.slice(5) : null;
  if (sdk !== null && SDK_FILES.includes(sdk)) return sendFile(res, path.join(SDK, sdk));
  // 게임 폴더 바로 아래의 코드 파일만
  const file = p.startsWith(`/games/${id}/`) ? p.slice(`/games/${id}/`.length) : '';
  if (/^[\w-]+\.m?js$/.test(file)) return sendFile(res, path.join(folder, file));
  json(res, 404, { error: 'not found' });
}).listen(Number(port), '127.0.0.1', () => {
  console.log(`Playground: http://localhost:${port}/  (game: ${id})`);
  console.log('Edit the game code and refresh the page to see changes. Press Ctrl+C to stop.');
});
