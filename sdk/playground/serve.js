// 플레이그라운드용 정적 파일 서버. 의존성 없이 Node만으로 돌아갑니다.
// 레포 루트를 그대로 보여주므로, 플레이그라운드가 games/ 아래의 게임을 import할 수 있습니다.
//   node sdk/playground/serve.js     → http://localhost:5173

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(302, { Location: '/sdk/playground/' });
    return res.end();
  }

  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  // ../ 로 레포 밖을 읽지 못하게 막습니다.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', // 게임 코드를 고치고 새로고침하면 바로 반영되게
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`플레이그라운드: http://localhost:${PORT}/sdk/playground/?game=tictactoe`);
});
