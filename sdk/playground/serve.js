// 개발용 정적 파일 서버. 의존성 없이 Node만으로 돌아갑니다.
// 레포 루트를 그대로 보여주므로, 플레이그라운드와 로비가 games/ 아래의 게임을 import할 수 있습니다.
//   node sdk/playground/serve.js     → http://localhost:5173 (로비)
//
// GET /api/games, /api/locale 은 운영에서 Go 서버(server/internal/site)가 같은 모양으로 제공합니다 (docs/protocol.md).
// 여기를 고치면 그쪽도 같이 고칩니다.
// /api/games 의 version 은 게임 폴더의 코드 파일 해시입니다. 코드를 고치면 바뀝니다.
// PUT /api/games/<id>/listing 은 개발용 등록창이 games/<id>/listing.json 에 저장할 때 씁니다.
// PUT /api/games/<id>/thumbnail 은 플레이그라운드의 "Use as thumbnail"이 games/<id>/thumbnail.json 에 저장할 때 씁니다.
//   DEV_COUNTRY=US node sdk/playground/serve.js  → 다른 나라에서 들어온 것처럼 확인
//
// 대전(/ws)과 신원(/api/me)은 Go 서버에 넘깁니다 (GO_SERVER, 기본 http://localhost:8080).
// 한 주소에서 로비와 대전을 같이 쓰려는 것입니다. 운영에서는 Go 서버가 전부 맡습니다.
//   cd server && go run ./cmd/server          → Go 서버를 같이 켜 두면 대전 찾기가 됩니다
// /api/me 는 Go 서버가 켜져 있으면 Go 서버의 신원을 그대로 넘깁니다. 의견, 방 만들기는 Go 서버가 계정인지 확인하므로
// 화면만 계정으로 꾸미지 않습니다. 계정으로 시험하려면 Go 서버를 DEV_LOGIN=1로 켜고 상단의 "개발용 로그인"을 누릅니다.
// Go 서버가 꺼져 있으면 가짜 신원(DEV_ME)만 돌려줍니다 (로비와 등록창은 됩니다).
// 소셜 로그인(/auth/..., /api/auth/providers)도 Go 서버로 넘깁니다. Host를 그대로 넘기므로
// 돌아올 주소는 http://localhost:5173/auth/<google|github>/callback 입니다 (docs/identity.md).
//   DEV_AS=guest node sdk/playground/serve.js    → Go 서버가 꺼져 있을 때 게스트로 보이게 (등록창이 막히는지 확인)

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gameEntry, json, isLocal, saveThumbnail } from '../lib/games.js';
import { normalizeListing, validateListing } from './listing.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT) || 5173;
const GO = new URL(process.env.GO_SERVER || 'http://localhost:8080');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * games/<id>/index.js 와 games/private/<id>/index.js 를 찾아 목록으로 만듭니다. 등록 정보와 썸네일이 있으면 같이 넣습니다.
 * folder는 /api/games에 넣지 않고 이 서버 안에서만 씁니다 (썸네일 저장).
 */
function listGames() {
  const list = [];
  for (const [dir, isPrivate] of [['games', false], ['games/private', true]]) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory() || !/^[a-z0-9-]+$/.test(d.name)) continue;
      if (!fs.existsSync(path.join(base, d.name, 'index.js'))) continue;
      const folder = path.join(base, d.name);
      const entry = gameEntry(folder, { id: d.name, module: `/${dir}/${d.name}/index.js`, private: isPrivate });
      Object.defineProperty(entry, 'folder', { value: folder }); // JSON에는 나가지 않습니다
      list.push(entry);
    }
  }
  return list;
}

/** 개발용 가짜 신원 (Go 서버가 꺼져 있을 때). 기본은 계정이라 등록창을 쓸 수 있습니다. */
const DEV_ME = process.env.DEV_AS === 'guest'
  ? { id: 'g_dev', kind: 'guest', tag: '0000' }
  : { id: 'm_dev', kind: 'member', name: 'dev', tag: '0000' };

/** GET /api/me: Go 서버에 물어 세션 쿠키와 신원을 그대로 넘깁니다. Go 서버가 꺼져 있으면 DEV_ME. */
function proxyMe(req, res) {
  const up = http.get(new URL('/api/me', GO), { headers: { cookie: req.headers.cookie ?? '' }, timeout: 1000 }, (r) => {
    let body = '';
    r.setEncoding('utf8');
    r.on('data', (c) => (body += c));
    r.on('end', () => {
      let real;
      try {
        real = JSON.parse(body);
      } catch {
        return json(res, 200, DEV_ME);
      }
      if (r.headers['set-cookie']) res.setHeader('Set-Cookie', r.headers['set-cookie']);
      json(res, 200, real);
    });
  });
  // Go 서버가 꺼져 있으면 가짜 신원만 (대전은 안 되지만 로비와 등록창은 됩니다)
  up.on('error', () => json(res, 200, DEV_ME));
  up.on('timeout', () => up.destroy());
}

/**
 * 방 목록(/api/rooms), 진행 중인 대국(/api/live), 기보(/api/matches...), 의견과 신고(/api/games/<id>/comments, /api/reports)는
 * Go 서버에만 있습니다. 쿠키와 본문을 붙여 그대로 넘깁니다.
 * Go 서버가 꺼져 있으면 목록은 빈 목록, 나머지는 503입니다.
 */
function proxyGo(req, res, url) {
  const isList = req.method === 'GET' && ['/api/rooms', '/api/live', '/api/matches'].includes(url.pathname);
  const fail = () => (isList ? json(res, 200, []) : json(res, 503, { error: 'no game server' }));
  const headers = { cookie: req.headers.cookie ?? '' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  const up = http.request(new URL(url.pathname + url.search, GO), { method: req.method, headers, timeout: 2000 }, (r) => {
    let body = '';
    r.setEncoding('utf8');
    r.on('data', (c) => (body += c));
    r.on('end', () => {
      try {
        json(res, r.statusCode, JSON.parse(body));
      } catch {
        fail();
      }
    });
  });
  up.on('error', fail);
  up.on('timeout', () => up.destroy());
  req.pipe(up);
}

/**
 * 소셜 로그인은 응답을 고치지 않고 그대로 넘깁니다 (리다이렉트, 쿠키).
 * Host를 그대로 보내서 Go 서버가 이 주소(localhost:5173)로 돌아올 주소를 만들게 합니다.
 * Go 서버가 꺼져 있으면 로그인 방법은 빈 목록(버튼이 "준비 중"), 나머지는 503입니다.
 */
function proxyRaw(req, res, url) {
  const fail = () => (url.pathname === '/api/auth/providers' ? json(res, 200, { providers: [] }) : json(res, 503, { error: 'no game server' }));
  const headers = { host: req.headers.host ?? '', cookie: req.headers.cookie ?? '' };
  for (const h of ['sec-fetch-site', 'content-type']) if (req.headers[h]) headers[h] = req.headers[h];
  const up = http.request(new URL(url.pathname + url.search, GO), { method: req.method, headers, timeout: 15000 }, (r) => {
    const out = {};
    for (const h of ['content-type', 'location', 'set-cookie', 'cache-control']) if (r.headers[h]) out[h] = r.headers[h];
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on('error', fail);
  up.on('timeout', () => up.destroy());
  req.pipe(up);
}

/** /ws 웹소켓을 Go 서버로 그대로 잇습니다. Host와 Origin을 바꾸지 않으므로 Go 서버는 같은 출처로 봅니다. */
function proxyWS(req, socket, head) {
  const up = net.connect(Number(GO.port) || 80, GO.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
}

/**
 * 개발용 등록 정보 저장. 내 컴퓨터에서 온 요청만 받습니다 (같은 와이파이의 다른 기기가 파일을 못 쓰게).
 * 다른 사이트가 보내는 요청은 JSON 본문 때문에 브라우저가 미리 확인(preflight)하는데,
 * 이 서버가 CORS 허가를 주지 않으므로 막힙니다.
 */
function saveListing(req, res, id) {
  if (!isLocal(req)) return json(res, 403, { error: 'local only' });
  if (DEV_ME.kind !== 'member') return json(res, 403, { error: 'member only' });
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'JSON only' });
  const game = listGames().find((g) => g.id === id);
  if (!game) return json(res, 404, { error: 'no such game' });

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 200_000) req.destroy();
  });
  req.on('end', () => {
    let listing;
    try {
      listing = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'bad JSON' });
    }
    const problems = validateListing(listing);
    if (problems.length) return json(res, 422, { problems });
    const saved = normalizeListing(listing);
    hasTurn(game).then((ok) => {
      // 타이머는 누구 시계가 가는지 알아야 하므로 turn()이 있는 게임만 쓸 수 있습니다
      if ((saved.timer.minutes !== null || saved.timer.custom) && !ok) {
        return json(res, 422, { problems: [{ code: 'timer.needsTurn' }] });
      }
      const file = path.join(game.folder, 'listing.json');
      fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n');
      json(res, 200, { listing: saved });
    });
  });
}

/** 게임 코드에 turn()이 있는지. 불러오지 못하면 false. 저장할 때마다 새로 읽도록 쿼리를 붙입니다. */
async function hasTurn(game) {
  try {
    const url = pathToFileURL(path.join(ROOT, game.module));
    url.search = `?t=${Date.now()}`;
    return typeof (await import(url.href)).default?.turn === 'function';
  } catch {
    return false;
  }
}

/**
 * 접속한 나라로 화면 언어를 고릅니다. 한국이면 ko, 그 밖의 나라는 en.
 * 운영에서는 Go 서버가 같은 방식으로 고르고, 앞에 선 프록시가 나라 코드를 넣어 줍니다
 * (GCP 부하 분산기의 커스텀 요청 헤더 `X-Client-Region: {client_region}`, Cloudflare의 `CF-IPCountry`).
 * 나라를 모르면 브라우저의 Accept-Language를 봅니다.
 */
function detectLocale(req) {
  // Cloudflare는 나라를 모르면 XX를 보냅니다
  const country = [req.headers['x-client-region'], req.headers['cf-ipcountry'], process.env.DEV_COUNTRY]
    .map((v) => String(v ?? '').toUpperCase())
    .find((c) => /^[A-Z]{2}$/.test(c) && c !== 'XX') ?? null;
  const lang = country
    ? (country === 'KR' ? 'ko' : 'en')
    : (/^ko\b/i.test(req.headers['accept-language'] ?? '') ? 'ko' : 'en');
  return { country, lang };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(302, { Location: '/web/' });
    return res.end();
  }
  if (url.pathname === '/api/games') return json(res, 200, listGames());
  if (url.pathname === '/api/locale') return json(res, 200, detectLocale(req));
  if (url.pathname === '/api/me') return proxyMe(req, res);
  if (url.pathname === '/api/auth/providers' || url.pathname.startsWith('/auth/')) return proxyRaw(req, res, url);
  if (url.pathname === '/api/rooms' || url.pathname === '/api/live' || /^\/api\/matches(\/[A-Z0-9]+)?$/.test(url.pathname)) return proxyGo(req, res, url);
  if (/^\/api\/games\/[a-z0-9-]+\/comments(\/[A-Z0-9]+)?$/.test(url.pathname) || url.pathname === '/api/reports') return proxyGo(req, res, url);
  const m = url.pathname.match(/^\/api\/games\/([a-z0-9-]+)\/listing$/);
  if (m && req.method === 'PUT') return saveListing(req, res, m[1]);
  const th = url.pathname.match(/^\/api\/games\/([a-z0-9-]+)\/thumbnail$/);
  if (th && req.method === 'PUT') {
    const game = listGames().find((g) => g.id === th[1]);
    return game ? saveThumbnail(req, res, game.folder) : json(res, 404, { error: 'no such game' });
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
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname === '/ws') return proxyWS(req, socket, head);
  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`로비: http://localhost:${PORT}/web/`);
  console.log(`플레이그라운드: http://localhost:${PORT}/sdk/playground/?game=tictactoe`);
  console.log(`신원: Go 서버의 신원. Go 서버가 꺼져 있으면 ${DEV_ME.kind}${DEV_ME.kind === 'guest' ? ' (DEV_AS=guest)' : ' (게스트로 보려면 DEV_AS=guest)'}`);
  console.log('계정으로 시험하려면 Go 서버를 DEV_LOGIN=1로 켜고 상단의 "개발용 로그인"을 누릅니다');
  console.log(`대전: ${GO.origin} 의 Go 서버로 넘깁니다 (cd server && go run ./cmd/server)`);
});
