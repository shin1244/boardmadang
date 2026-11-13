// 게임 폴더를 읽고 쓰는 Node 도구. 레포의 개발 서버(playground/serve.js), 명령줄(bin/boardmadang.js)이 같이 씁니다.
// 게임 폴더에는 index.js(필수), 다른 .js/.mjs, listing.json(등록 정보), thumbnail.json(썸네일)이 있습니다.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeThumbnail, validateThumbnail } from '../check.js';
import { usesMoves } from '../playground/platform.js';
import { isLocal, json, readBody } from './http.js';

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
  return versionOf(readCode(folder));
}

/** 게임 폴더의 코드 파일을 읽은 것 [{ name, data }]. name은 /로 구분한 상대 경로이고 그 순서로 정렬돼 있습니다 */
const readCode = (folder) => codeFiles(folder).map((name) => ({ name, data: fs.readFileSync(path.join(folder, ...name.split('/'))) }));

/** 코드 파일들([{ name, data }], 이름순)의 버전. codeVersion과 같은 계산입니다 */
export function versionOf(files) {
  const hash = crypto.createHash('sha256');
  for (const { name, data } of files) {
    hash.update(name);
    hash.update('\0');
    hash.update(data);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

// ---- 올릴 코드 ----
// moves()와 move()로 쓴 게임(playground/moves.js)은 올릴 때 게임 API로 바꾸는 코드를 같이 넣습니다.
// 사이트가 받는 것은 언제나 게임 API로 된 게임이라 사이트와 서버는 그대로이고, 올린 게임은 그때의 변환기를 품고 있어서
// 나중에 변환기를 고쳐도 이미 둔 대국의 기보가 달라지지 않습니다.

/** zip 안에서 제작자의 index.js가 갖는 이름 */
const SOURCE = 'index.game.js';
/** zip 안에서 변환기가 들어가는 폴더와 그 파일들 (playground/의 파일 그대로. moves.js는 platform.js만 import합니다) */
const RUNTIME_DIR = 'boardmadang';
const RUNTIME = ['moves.js', 'platform.js'];
const WRAPPER = `// Made by "npx boardmadang pack". Your game is in ./${SOURCE}.
// This file turns its moves() and move() into the game API that boardmadang.com runs.
import game from './${SOURCE}';
import { toGame } from './${RUNTIME_DIR}/moves.js';

export default toGame(game);
`;

/**
 * 올릴 zip에 들어갈 코드 파일 [{ name, data }] (이름순).
 * 게임 API로 쓴 게임이면 폴더의 코드 파일 그대로입니다. moves()로 쓴 게임(raw가 불러온 그대로의 게임)이면
 * 제작자의 index.js를 index.game.js로 넣고, 그것을 toGame()에 넘기는 index.js와 변환기(boardmadang/)를 같이 넣습니다.
 * 폴더에 이미 그 이름의 파일이 있으면 Error입니다.
 */
export function packedCode(folder, raw) {
  const files = readCode(folder);
  if (!usesMoves(raw)) return files;
  const clash = files.find((f) => f.name === SOURCE || f.name.startsWith(`${RUNTIME_DIR}/`));
  if (clash) throw new Error(`${clash.name}: pack needs this name for a game written with moves(). Rename your file or folder.`);
  const playground = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'playground');
  return [
    ...files.map((f) => (f.name === 'index.js' ? { ...f, name: SOURCE } : f)),
    { name: 'index.js', data: Buffer.from(WRAPPER) },
    ...RUNTIME.map((name) => ({ name: `${RUNTIME_DIR}/${name}`, data: fs.readFileSync(path.join(playground, name)) })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

/**
 * PUT /api/games/<id>/thumbnail: 플레이그라운드의 "Use as thumbnail"이 찍은 판을 게임 폴더의 thumbnail.json에 씁니다.
 * 개발용이라 내 컴퓨터에서 온 JSON만 받습니다 (lib/http.js의 readBody).
 */
export function saveThumbnail(req, res, folder) {
  if (!isLocal(req)) return json(res, 403, { error: 'local only' });
  readBody(req, res, (thumb) => {
    const problems = validateThumbnail(thumb);
    if (problems.length) return json(res, 422, { problems });
    const saved = normalizeThumbnail(thumb);
    fs.writeFileSync(path.join(folder, 'thumbnail.json'), JSON.stringify(saved, null, 2) + '\n');
    json(res, 200, { thumbnail: saved });
  });
}
