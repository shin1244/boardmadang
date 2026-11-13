// 개발 서버들이 같이 쓰는 작은 HTTP 도구. npx boardmadang dev(lib/dev.js)와 레포의 개발 서버(playground/serve.js)가 씁니다.

import fs from 'node:fs';
import path from 'node:path';

/** 내보내는 파일의 종류 */
export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm', // 브라우저 AI의 onnxruntime-web (web/vendor)
};

export const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** 내 컴퓨터에서 온 요청인지 (같은 와이파이의 다른 기기가 파일을 못 쓰게) */
export const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

/** 파일 하나를 내보냅니다. 없으면 404. 게임 코드를 고치고 새로고침하면 바로 반영되게 캐시하지 않습니다 */
export function sendFile(res, file, headers = {}) {
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', ...headers });
    res.end(data);
  });
}

/**
 * 요청의 JSON 본문(200KB까지)을 읽어 then(값)을 부릅니다. JSON이 아니면 415나 400으로 답하고 then은 부르지 않습니다.
 * 파일을 쓰는 개발용 주소(썸네일, 등록 정보 저장)가 씁니다. 다른 사이트가 보내는 요청은 JSON 본문 때문에
 * 브라우저가 미리 확인(preflight)하는데, 개발 서버가 CORS 허가를 주지 않으므로 막힙니다.
 */
export function readBody(req, res, then) {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'JSON only' });
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 200_000) req.destroy();
  });
  req.on('end', () => {
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'bad JSON' });
    }
    then(value);
  });
}
