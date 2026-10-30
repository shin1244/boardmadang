// 게임 폴더를 읽는 Node 도구. 레포의 개발 서버(playground/serve.js), 명령줄(bin/boardmadang.js)이 같이 씁니다.
// 게임 폴더에는 index.js(필수), 다른 .js/.mjs, listing.json(등록 정보), thumbnail.json(썸네일)이 있습니다.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeThumbnail, validateThumbnail } from '../check.js';

/** 게임 코드 파일인지. 테스트는 빼고, 판에 영향을 주는 .js, .mjs만 */
export const isCodeFile = (name) => /\.m?js$/.test(name) && !/\.test\.m?js$/.test(name);

/** 게임 폴더의 코드 파일. 폴더 기준 /로 구분한 상대 경로를 정렬해서 돌려줍니다. node_modules와 점으로 시작하는 폴더는 빼냅니다. */
export function codeFiles(folder) {
  const files = [];
  (function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name !== 'node_modules') walk(p);
      } else if (isCodeFile(d.name)) {
        files.push(path.relative(folder, p).split(path.sep).join('/'));
      }
    }
  })(folder);
  return files.sort();
}

/**
 * 게임 코드의 버전: 코드 파일의 경로와 내용을 이은 SHA-256 앞 16글자.
 * 같은 버전끼리만 매칭하고 기보에도 남깁니다. 등록 정보와 썸네일은 판에 영향이 없어 넣지 않습니다.
 * 운영의 Go 서버(server/internal/site의 codeVersion)와 결과가 같아야 합니다.
 * 그래서 경로는 운영체제와 상관없이 /로 구분한 상대 경로로 정렬합니다 (윈도우의 \로 정렬하면 순서가 달라질 수 있습니다).
 */
export function codeVersion(folder) {
  const hash = crypto.createHash('sha256');
  for (const rel of codeFiles(folder)) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(folder, rel)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/** JSON 파일을 읽습니다. 없으면 { value: null }, 깨졌으면 { value: null, error } */
export function readJson(file) {
  if (!fs.existsSync(file)) return { value: null };
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { value: null, error: e.message };
  }
}

/**
 * /api/games의 게임 하나 (docs/protocol.md). Go 서버와 모양이 같아야 합니다.
 * listing이 없으면 null(등록 전), 깨졌으면 null과 listingError. 썸네일이 없거나 깨졌으면 null.
 */
export function gameEntry(folder, { id, module, private: isPrivate = false }) {
  const listing = readJson(path.join(folder, 'listing.json'));
  const entry = { id, module, version: codeVersion(folder), private: isPrivate, listing: listing.value };
  if (listing.error) entry.listingError = listing.error;
  entry.thumbnail = readJson(path.join(folder, 'thumbnail.json')).value;
  return entry;
}

export const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** 내 컴퓨터에서 온 요청인지 (같은 와이파이의 다른 기기가 파일을 못 쓰게) */
export const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

/**
 * PUT /api/games/<id>/thumbnail: 플레이그라운드의 "Use as thumbnail"이 찍은 판을 게임 폴더의 thumbnail.json에 씁니다.
 * 개발용이라 내 컴퓨터에서 온 JSON만 받습니다. 다른 사이트가 보내는 요청은 JSON 본문 때문에
 * 브라우저가 미리 확인(preflight)하는데, 개발 서버가 CORS 허가를 주지 않으므로 막힙니다.
 */
export function saveThumbnail(req, res, folder) {
  if (!isLocal(req)) return json(res, 403, { error: 'local only' });
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'JSON only' });
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 200_000) req.destroy();
  });
  req.on('end', () => {
    let thumb;
    try {
      thumb = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'bad JSON' });
    }
    const problems = validateThumbnail(thumb);
    if (problems.length) return json(res, 422, { problems });
    const saved = normalizeThumbnail(thumb);
    fs.writeFileSync(path.join(folder, 'thumbnail.json'), JSON.stringify(saved, null, 2) + '\n');
    json(res, 200, { thumbnail: saved });
  });
}
