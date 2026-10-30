#!/usr/bin/env node
// 보드마당 게임 제작 도구. 게임 폴더 안에서 씁니다 (폴더를 따로 적어도 됩니다).
//
//   npx boardmadang new <폴더>   새 게임 틀 (틱택토에서 시작)
//   npx boardmadang dev          플레이그라운드: 혼자 양쪽을 두고, 「썸네일로」로 게임 목록에 보일 판을 찍습니다
//   npx boardmadang check        업로드할 때와 같은 검사
//   npx boardmadang pack         검사를 통과하면 올릴 zip을 만듭니다 (<id>.zip)
//
// 게임 폴더: index.js(필수), index.js가 import하는 다른 .js/.mjs, listing.json(등록 정보), thumbnail.json(썸네일)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GAME_LIMITS, checkGame, checkThumbnail } from '../check.js';
import { startDev } from '../lib/dev.js';
import { codeFiles, codeVersion, readJson } from '../lib/games.js';
import { zip } from '../lib/zip.js';
import { LANGS, fullLangs, validateListing } from '../playground/listing.js';
import { makeRng } from '../playground/platform.js';

const SDK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(SDK, 'package.json'), 'utf8')).version;

const HELP = `보드마당 게임 제작 도구 ${VERSION}

  npx boardmadang new <폴더>          새 게임 틀을 만듭니다 (틱택토에서 시작)
  npx boardmadang dev [폴더]          플레이그라운드를 띄웁니다 (--port 5173)
  npx boardmadang check [폴더]        업로드할 때와 같은 검사를 합니다 (--games 200)
  npx boardmadang pack [폴더]         검사를 통과하면 올릴 zip을 만듭니다

폴더를 적지 않으면 지금 폴더입니다. 게임 API: https://github.com/shin1244/boardmadang/blob/main/sdk/README.md`;

/** 등록 정보 검사 결과(code)를 글로. 사이트 등록창과 같은 뜻입니다. */
const LISTING_TEXT = {
  'languages.none': () => '지원 언어를 하나 이상 고르세요.',
  'languages.needFull': () => '완전 번역(full) 언어가 하나 이상 있어야 합니다. 게임 안 글자를 보여줄 언어가 필요합니다.',
  'languages.invalid': () => '모르는 언어나 지원 수준이 들어 있습니다.',
  'difficulty.invalid': () => "difficulty는 'easy', 'normal', 'hard' 중 하나여야 합니다.",
  'timer.invalid': (p) => `timer.minutes는 ${p.min}~${p.max}의 정수이거나 null, timer.custom은 true/false여야 합니다.`,
  'timer.needsTurn': () => '타이머를 쓰려면 게임 코드에 turn()이 있어야 합니다.',
  'text.missing': (p) => `${p.field}.${p.lang} 칸이 비어 있습니다.`,
  'text.tooLong': (p) => `${p.field}.${p.lang} 칸은 ${p.max}자까지 쓸 수 있습니다.`,
};

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      opts[k] = v ?? rest[++i];
    } else {
      opts._.push(a);
    }
  }
  return { command, opts };
}

const say = (s = '') => console.log(s);
const bad = (s) => console.log(`  ✖ ${s}`);
const good = (s) => console.log(`  ✔ ${s}`);
const note = (s) => console.log(`  ! ${s}`);

// ---- new ----

function newGame(dir) {
  if (!dir) throw new Error('만들 폴더 이름을 적으세요: npx boardmadang new my-game');
  const folder = path.resolve(dir);
  const id = path.basename(folder);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`폴더 이름이 게임 id가 됩니다. 영문 소문자, 숫자, -만 쓰세요 (받은 이름: ${id})`);
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new Error(`${dir} 폴더가 비어 있지 않습니다`);
  fs.mkdirSync(folder, { recursive: true });
  const template = path.join(SDK, 'template');
  for (const name of fs.readdirSync(template)) {
    const text = fs.readFileSync(path.join(template, name), 'utf8').replaceAll('__ID__', id);
    // npm은 패키지 안의 .gitignore를 빼 버려서 gitignore로 넣어 두고 여기서 이름을 바꿉니다
    fs.writeFileSync(path.join(folder, name === 'gitignore' ? '.gitignore' : name), text);
  }
  say(`새 게임 ${id}를 만들었습니다: ${folder}`);
  say();
  say(`  cd ${dir}`);
  say('  npx boardmadang dev     혼자 양쪽을 둬보고, 썸네일을 찍습니다');
  say('  npx boardmadang check   업로드할 때와 같은 검사');
  say('  npx boardmadang pack    올릴 zip 만들기');
}

// ---- check ----

/** 게임 모듈을 불러옵니다. index.js가 export를 쓰므로 ES 모듈로 읽혀야 합니다. */
async function loadGame(folder) {
  const file = path.join(folder, 'index.js');
  if (!fs.existsSync(file)) throw new Error(`${file}이 없습니다. 게임 폴더에서 실행하거나 폴더를 적으세요.`);
  try {
    return (await import(pathToFileURL(file).href)).default;
  } catch (e) {
    const esm = /Cannot use import statement|Unexpected token 'export'|exports is not defined/.test(e.message);
    throw new Error(`index.js를 불러오지 못했습니다: ${e.message}${esm
      ? '\n    게임 폴더에 {"type": "module"}이 든 package.json을 두세요 (npx boardmadang new가 만드는 것과 같이).'
      : ''}`);
  }
}

/** 등록 정보가 없을 때 게임 안 글자 검사에 쓸 언어: view()와 result()가 오류 없이 받는 언어 */
function workingLangs(game) {
  const ok = LANGS.filter((l) => {
    try {
      const s = game.setup(makeRng(1));
      game.view(s, 0, l);
      game.result(s, l);
      return true;
    } catch {
      return false;
    }
  });
  return ok.length ? ok : ['ko'];
}

/**
 * 업로드 검사. 문제가 있으면 problems에 쌓고, 화면에 줄마다 씁니다.
 * @returns {Promise<{ problems: string[], game: object | null, files: string[] }>}
 */
async function runCheck(folder, { games = 200 } = {}) {
  folder = path.resolve(folder);
  const problems = [];
  const fail = (s) => { problems.push(s); bad(s); };
  say(`검사: ${folder}`);

  // 파일
  const files = codeFiles(folder);
  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(folder, f)).size, 0);
  if (bytes > GAME_LIMITS.codeBytes) fail(`게임 코드가 ${(bytes / 1024).toFixed(1)}KB입니다 (상한 ${GAME_LIMITS.codeBytes / 1024}KB)`);
  else good(`코드 파일 ${files.length}개, ${(bytes / 1024).toFixed(1)}KB · 버전 ${codeVersion(folder)}`);

  let game;
  try {
    game = await loadGame(folder);
  } catch (e) {
    fail(e.message);
    return { problems, game: null, files };
  }

  // 등록 정보
  const listing = readJson(path.join(folder, 'listing.json'));
  if (listing.error) fail(`listing.json이 깨졌습니다: ${listing.error}`);
  else if (!listing.value) note('listing.json이 없습니다. 사이트 등록창에서 이름, 룰북, 언어를 입력해도 됩니다.');
  else {
    const lp = validateListing(listing.value);
    const timer = listing.value.timer;
    if (timer && (timer.minutes !== null || timer.custom) && typeof game?.turn !== 'function') lp.push({ code: 'timer.needsTurn' });
    for (const p of lp) fail(`listing.json: ${LISTING_TEXT[p.code]?.(p) ?? p.code}`);
    if (!lp.length) good('등록 정보 (listing.json)');
  }

  // 게임 실행
  const langs = listing.value && fullLangs(listing.value).length ? fullLangs(listing.value) : workingLangs(game ?? {});
  const result = checkGame(game, { n: games, langs });
  for (const p of result.problems) fail(p);
  for (const w of result.warnings) note(w);
  if (result.stats) {
    const { n, tally, avgMoves, avgMs, maxMs } = result.stats;
    if (!result.problems.length) good(`랜덤 대국 ${n}판 (언어 ${langs.join(', ')})`);
    say(`    선공 승 ${tally[0]} · 후공 승 ${tally[1]} · 무승부 ${tally.draw + tally.maxActions} (maxActions ${tally.maxActions})`
      + ` · 평균 ${avgMoves.toFixed(1)}수 · play() 평균 ${avgMs.toFixed(3)}ms, 최대 ${maxMs.toFixed(2)}ms`);
  }

  // 썸네일
  const thumb = readJson(path.join(folder, 'thumbnail.json'));
  if (thumb.error) fail(`thumbnail.json이 깨졌습니다: ${thumb.error}`);
  else if (!thumb.value) note('thumbnail.json이 없습니다. npx boardmadang dev에서 「썸네일로」를 누르면 찍힙니다. 없으면 시작 판을 보여줍니다.');
  else if (game && !result.stats) note('게임 코드에 문제가 있어 썸네일은 검사하지 않았습니다.');
  else {
    const tp = checkThumbnail(game, thumb.value);
    for (const p of tp) fail(`thumbnail.json: ${p}`);
    if (!tp.length) good(`썸네일 (플레이어 ${thumb.value.player} 화면, 기물 ${thumb.value.view.pieces.length}개)`);
  }

  say();
  say(problems.length ? `문제 ${problems.length}개를 고쳐야 올릴 수 있습니다.` : '통과했습니다.');
  return { problems, game, files };
}

// ---- pack ----

async function pack(folder, opts) {
  folder = path.resolve(folder);
  const { problems, game, files } = await runCheck(folder, opts);
  if (problems.length) return false;

  const names = [...files];
  for (const extra of ['listing.json', 'thumbnail.json']) if (fs.existsSync(path.join(folder, extra))) names.push(extra);
  const out = path.resolve(opts.out ?? path.join(folder, `${game.id}.zip`));
  const data = zip(names.map((name) => ({ name, data: fs.readFileSync(path.join(folder, ...name.split('/'))) })));
  fs.writeFileSync(out, data);
  say(`올릴 파일을 만들었습니다: ${out} (${(data.length / 1024).toFixed(1)}KB)`);
  for (const n of names) say(`    ${n}`);
  say('사이트의 게임 등록에서 이 파일을 올립니다.');
  return true;
}

// ---- dev ----

async function dev(folder, { port = 5173 } = {}) {
  folder = path.resolve(folder);
  if (!fs.existsSync(path.join(folder, 'index.js'))) throw new Error(`${folder}에 index.js가 없습니다. 게임 폴더에서 실행하거나 폴더를 적으세요.`);
  try {
    const { url, id } = await startDev({ folder, port: Number(port) });
    say(`플레이그라운드: ${url}  (게임 ${id})`);
    say('게임 코드를 고치고 새로고침하면 바로 반영됩니다. 끝내려면 Ctrl+C');
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new Error(`${port}번 포트를 다른 프로그램이 쓰고 있습니다. --port 5174 처럼 다른 포트를 적으세요.`);
    throw e;
  }
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const folder = opts._[0] ?? '.';
  switch (command) {
    case 'new':
      return newGame(opts._[0]);
    case 'dev':
      return dev(folder, opts);
    case 'check':
      return process.exit((await runCheck(folder, { games: Number(opts.games) || 200 })).problems.length ? 1 : 0);
    case 'pack':
      return process.exit((await pack(folder, { games: Number(opts.games) || 200, out: opts.out })) ? 0 : 1);
    case '--version':
    case '-v':
      return say(VERSION);
    default:
      say(HELP);
      if (command && !['help', '--help', '-h'].includes(command)) process.exit(1);
  }
}

main().catch((e) => {
  console.error(`오류: ${e.message}`);
  process.exit(1);
});
