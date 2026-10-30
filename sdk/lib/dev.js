// npx boardmadang dev: 게임 폴더 하나로 플레이그라운드를 띄웁니다.
// 레포의 개발 서버(playground/serve.js)와 달리 사이트 화면이나 Go 서버는 없고, 이 게임 하나만 둬봅니다.
//
//   /                              → 플레이그라운드로
//   /sdk/playground/…, /sdk/check.js   이 패키지의 플레이그라운드
//   /games/<id>/…                  게임 폴더의 .js, .mjs, .json
//   GET /api/games                 이 게임 하나 (사이트의 /api/games와 같은 모양)
//   PUT /api/games/<id>/thumbnail  "Use as thumbnail"이 찍은 판을 thumbnail.json에 저장

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameEntry, json, saveThumbnail } from './games.js';

const SDK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** 플레이그라운드가 쓰는 이 패키지의 파일 */
const SDK_FILES = new Set([
  'check.js',
  'playground/index.html', 'playground/playground.js', 'playground/playground.css',
  'playground/board.js', 'playground/listing.js', 'playground/platform.js',
]);

/** 폴더 이름으로 게임 id를 만듭니다. 사이트 주소에 쓰이므로 영문 소문자, 숫자, -만 */
export function idOf(folder) {
  const id = path.basename(path.resolve(folder)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return id || 'game';
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', // 게임 코드를 고치고 새로고침하면 바로 반영되게
    });
    res.end(data);
  });
}

/** 게임 폴더 안의 파일. 점으로 시작하는 이름, 폴더 밖으로 나가는 경로, 코드와 JSON이 아닌 파일은 404 */
function gameFile(folder, rel) {
  const parts = rel.split('/');
  if (parts.some((p) => !p || p.startsWith('.'))) return null;
  if (!['.js', '.mjs', '.json'].includes(path.extname(rel))) return null;
  const file = path.resolve(folder, ...parts);
  return file.startsWith(path.resolve(folder) + path.sep) ? file : null;
}

/**
 * @param {{ folder: string, port: number }} opts
 * @returns {Promise<{ server: http.Server, url: string, id: string }>}
 */
export function startDev({ folder, port }) {
  folder = path.resolve(folder);
  const id = idOf(folder);
  const module = `/games/${id}/index.js`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (p === '/') {
      res.writeHead(302, { Location: `/sdk/playground/?game=${id}` });
      return res.end();
    }
    if (p === '/api/games') return json(res, 200, [gameEntry(folder, { id, module })]);
    if (p === `/api/games/${id}/thumbnail` && req.method === 'PUT') return saveThumbnail(req, res, folder);

    let rel = p.startsWith('/sdk/') ? p.slice('/sdk/'.length) : null;
    if (rel === 'playground/' || rel === 'playground') rel = 'playground/index.html';
    if (rel !== null) return SDK_FILES.has(rel) ? sendFile(res, path.join(SDK, rel)) : json(res, 404, { error: 'not found' });

    const prefix = `/games/${id}/`;
    if (p.startsWith(prefix)) {
      const file = gameFile(folder, p.slice(prefix.length));
      return file ? sendFile(res, file) : json(res, 404, { error: 'not found' });
    }
    json(res, 404, { error: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://localhost:${server.address().port}/`, id }));
  });
}
