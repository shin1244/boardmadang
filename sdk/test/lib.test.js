import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
