import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDev } from '../lib/dev.js';
import { codeFiles, codeVersion, gameEntry } from '../lib/games.js';
import { crc32, unzip, zip } from '../lib/zip.js';

/** 임시 폴더에 files(슬래시 경로 → 내용)를 씁니다 */
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardmadang-'));
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

test('crc32는 표준 값과 같습니다', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zip으로 묶고 다시 풀면 같습니다', () => {
  const files = [
    { name: 'index.js', data: Buffer.from('export default {};\n'.repeat(50)) }, // 압축됨
    { name: 'lib/규칙.mjs', data: Buffer.from('export const a = 1;\n') }, // 하위 폴더, UTF-8 이름
    { name: 'noise.json', data: crypto.randomBytes(300) }, // 압축해도 안 작아짐 → 그대로
  ];
  const out = unzip(zip(files));
  assert.deepEqual(out.map((f) => f.name), files.map((f) => f.name));
  out.forEach((f, i) => assert.ok(f.data.equals(files[i].data), f.name));
  // 같은 파일이면 같은 zip
  assert.ok(zip(files).equals(zip(files)));
});

test('게임 코드 버전은 Go 서버와 같은 값입니다 (server/internal/site의 TestCodeVersionMatchesServeJS)', () => {
  const dir = tree({
    'index.js': 'export default {};\n',
    'lib.js': 'export const a = 1;\n',
    'lib/rules.mjs': 'export const b = 2;\n',
    'lib0.js': 'export const c = 3;\n',
    'index.test.js': 'excluded\n',
    'node_modules/x/index.js': 'excluded\n',
    'listing.json': '{}\n',
    '.draft.js': 'hidden\n',
    '.cache/index.js': 'hidden\n',
  });
  assert.deepEqual(codeFiles(dir), ['index.js', 'lib.js', 'lib/rules.mjs', 'lib0.js']);
  assert.equal(codeVersion(dir), '27440701b9ad088b');
});

test('/api/games 항목: 등록 정보와 썸네일이 없거나 깨졌으면 null', () => {
  const none = gameEntry(tree({ 'index.js': 'x' }), { id: 'a', module: '/games/a/index.js' });
  assert.deepEqual(Object.keys(none), ['id', 'module', 'version', 'private', 'listing', 'thumbnail']);
  assert.equal(none.listing, null);
  assert.equal(none.thumbnail, null);

  const broken = gameEntry(tree({ 'index.js': 'x', 'listing.json': '{', 'thumbnail.json': '{' }), { id: 'b', module: '/games/b/index.js', private: true });
  assert.equal(broken.listing, null);
  assert.ok(broken.listingError);
  assert.equal(broken.thumbnail, null);
  assert.equal(broken.private, true);

  const ok = gameEntry(tree({ 'index.js': 'x', 'thumbnail.json': '{"player":1}' }), { id: 'c', module: '/games/c/index.js' });
  assert.deepEqual(ok.thumbnail, { player: 1 });
});

// ---- npx boardmadang dev의 서버 (lib/dev.js, lib/http.js) ----

/** 임시 게임 폴더로 개발 서버를 띄우고, 테스트가 끝나면 닫습니다 */
async function devServer(t, name = 'my-game') {
  const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-dev-')), name);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'index.js'), 'export default {};\n');
  fs.writeFileSync(path.join(folder, '.secret.js'), 'x');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
  const { server, url, id } = await startDev({ folder, port: 0 });
  t.after(() => {
    server.close();
    fs.rmSync(path.dirname(folder), { recursive: true, force: true });
  });
  return { folder, id, get: (p, init) => fetch(new URL(p, url), { redirect: 'manual', ...init }) };
}

test('개발 서버: 플레이그라운드와 이 게임의 코드만 내보냅니다', async (t) => {
  const { id, get } = await devServer(t);
  assert.equal(id, 'my-game');
  const home = await get('/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/sdk/playground/?game=my-game');

  const [entry] = await (await get('/api/games')).json();
  assert.deepEqual({ ...entry, version: null }, { id: 'my-game', module: '/games/my-game/index.js', version: null, private: false, listing: null, thumbnail: null });
  assert.match(entry.version, /^[0-9a-f]{16}$/);

  const board = await get('/sdk/playground/board.js');
  assert.equal(board.status, 200);
  assert.equal(board.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(board.headers.get('cache-control'), 'no-store', '고친 코드가 새로고침에 바로 보여야 합니다');
  assert.equal((await get('/sdk/playground/')).headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal((await get('/games/my-game/index.js')).status, 200);

  // 플레이그라운드가 쓰지 않는 패키지 파일, 숨긴 파일, 코드가 아닌 파일, 다른 게임, 폴더 밖
  for (const p of ['/sdk/playground/serve.js', '/sdk/package.json', '/sdk/lib/http.js', '/games/my-game/.secret.js', '/games/my-game/notes.txt',
    '/games/other/index.js', '/games/my-game/..%2F..%2Fetc%2Fpasswd.js', '/nope']) {
    const res = await get(p);
    assert.equal(res.status, 404, p);
    assert.deepEqual(await res.json(), { error: 'not found' }, p);
  }
});

test('개발 서버: 썸네일은 검사를 통과한 JSON만 thumbnail.json에 씁니다', async (t) => {
  const { folder, get } = await devServer(t);
  const file = path.join(folder, 'thumbnail.json');
  const put = (body, type = 'application/json') => get('/api/games/my-game/thumbnail', { method: 'PUT', headers: { 'Content-Type': type }, body });

  assert.equal((await put('{}', 'text/plain')).status, 415);
  assert.equal((await put('{bad')).status, 400);
  const invalid = await put(JSON.stringify({ board: { places: 'cells', rows: 3, cols: 3 }, pieces: 'xo', player: 2, view: { pieces: [] } }));
  assert.equal(invalid.status, 422);
  assert.deepEqual((await invalid.json()).problems, ['thumbnail.player: must be 0 or 1']);
  assert.ok(!fs.existsSync(file), '틀린 썸네일은 쓰지 않습니다');
  assert.equal((await get('/api/games/other/thumbnail', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);

  const thumb = { board: { places: 'cells', rows: 3, cols: 3, extra: 1 }, pieces: 'xo', player: 0, view: { pieces: [{ row: 1, col: 1, piece: 'x', extra: 1 }], message: 'hi' } };
  const ok = await put(JSON.stringify(thumb));
  assert.equal(ok.status, 200);
  const saved = { board: { places: 'cells', rows: 3, cols: 3 }, pieces: 'xo', player: 0, view: { pieces: [{ row: 1, col: 1, piece: 'x' }] } };
  assert.deepEqual((await ok.json()).thumbnail, saved, '알려진 칸만 남깁니다');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), saved);
  assert.deepEqual((await (await get('/api/games')).json())[0].thumbnail, saved);
});

test('개발 서버: 폴더 이름으로 만든 id는 게임 id 규칙(소문자, 숫자, -, 40자까지)에 맞습니다', async (t) => {
  const { id } = await devServer(t, `My Game_${'x'.repeat(60)}`);
  assert.match(id, /^[a-z0-9-]{1,40}$/);
  assert.ok(id.startsWith('my-game-x'));
});
