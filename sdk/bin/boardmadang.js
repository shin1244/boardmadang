#!/usr/bin/env node
// 보드마당 게임 제작 도구. 게임 폴더 안에서 씁니다 (폴더를 따로 적어도 됩니다).
//
// 화면에 나오는 글은 영어가 기본입니다 (npm으로 여러 나라 제작자가 씁니다). 한국어 안내는 README.ko.md.
//
//   npx boardmadang new <folder>   새 게임 틀 (틱택토에서 시작)
//   npx boardmadang dev            플레이그라운드: 혼자 양쪽을 두고, "Use as thumbnail"로 게임 목록에 보일 판을 찍습니다
//   npx boardmadang check          업로드할 때와 같은 검사
//   npx boardmadang pack           검사를 통과하면 올릴 zip을 만듭니다 (<id>.zip)
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

const HELP = `boardmadang ${VERSION}: make 1-vs-1 board games for boardmadang.com

  npx boardmadang new <folder>     make a new game (starts as tic-tac-toe)
  npx boardmadang dev [folder]     open the playground (--port 5173)
  npx boardmadang check [folder]   run the same checks as the upload (--games 200)
  npx boardmadang pack [folder]    if the checks pass, make the zip to upload

[folder] defaults to the current folder. Guide: https://github.com/shin1244/boardmadang/blob/main/sdk/README.md`;

/** 등록 정보 검사 결과(code)를 글로. 사이트 등록창과 같은 뜻입니다. */
const LISTING_TEXT = {
  'languages.none': () => 'pick at least one language.',
  'languages.needFull': () => "at least one language must be 'full', so your in-game text has a language to show in.",
  'languages.invalid': () => "unknown language or level (use 'full' or 'rulebook').",
  'difficulty.invalid': () => "difficulty must be 'easy', 'normal', or 'hard'.",
  'timer.invalid': (p) => `timer.minutes must be a whole number from ${p.min} to ${p.max} or null, and timer.custom must be true or false.`,
  'timer.needsTurn': () => 'a timer needs turn() in your game code.',
  'text.missing': (p) => `${p.field}.${p.lang} is empty.`,
  'text.tooLong': (p) => `${p.field}.${p.lang} can be at most ${p.max} characters.`,
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
  if (!dir) throw new Error('Name the folder to create: npx boardmadang new my-game');
  const folder = path.resolve(dir);
  const id = path.basename(folder);
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`The folder name becomes the game id, so use only lowercase letters, numbers, and - (got: ${id})`);
  if (fs.existsSync(folder) && fs.readdirSync(folder).length) throw new Error(`${dir} is not empty`);
  fs.mkdirSync(folder, { recursive: true });
  const template = path.join(SDK, 'template');
  for (const name of fs.readdirSync(template)) {
    const text = fs.readFileSync(path.join(template, name), 'utf8').replaceAll('__ID__', id);
    // npm은 패키지 안의 .gitignore를 빼 버려서 gitignore로 넣어 두고 여기서 이름을 바꿉니다
    fs.writeFileSync(path.join(folder, name === 'gitignore' ? '.gitignore' : name), text);
  }
  say(`Made a new game "${id}" in ${folder}`);
  say();
  say(`  cd ${dir}`);
  say('  npx boardmadang dev     play both sides and take a thumbnail');
  say('  npx boardmadang check   run the same checks as the upload');
  say('  npx boardmadang pack    make the zip to upload');
}

// ---- check ----

/** 게임 모듈을 불러옵니다. index.js가 export를 쓰므로 ES 모듈로 읽혀야 합니다. */
async function loadGame(folder) {
  const file = path.join(folder, 'index.js');
  if (!fs.existsSync(file)) throw new Error(`${file} not found. Run this in your game folder, or name the folder.`);
  try {
    return (await import(pathToFileURL(file).href)).default;
  } catch (e) {
    const esm = /Cannot use import statement|Unexpected token 'export'|exports is not defined/.test(e.message);
    throw new Error(`Couldn't load index.js: ${e.message}${esm
      ? '\n    Add a package.json with {"type": "module"} to your game folder (npx boardmadang new makes one).'
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
  say(`Checking ${folder}`);

  // 파일
  const files = codeFiles(folder);
  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(folder, f)).size, 0);
  if (bytes > GAME_LIMITS.codeBytes) fail(`game code is ${(bytes / 1024).toFixed(1)}KB (limit ${GAME_LIMITS.codeBytes / 1024}KB)`);
  else good(`${files.length} code file${files.length === 1 ? '' : 's'}, ${(bytes / 1024).toFixed(1)}KB · version ${codeVersion(folder)}`);

  let game;
  try {
    game = await loadGame(folder);
  } catch (e) {
    fail(e.message);
    return { problems, game: null, files };
  }

  // 등록 정보
  const listing = readJson(path.join(folder, 'listing.json'));
  if (listing.error) fail(`listing.json is not valid JSON: ${listing.error}`);
  else if (!listing.value) note("no listing.json. That's OK: you can fill in the name, rules, and languages on the site.");
  else {
    const lp = validateListing(listing.value);
    const timer = listing.value.timer;
    if (timer && (timer.minutes !== null || timer.custom) && typeof game?.turn !== 'function') lp.push({ code: 'timer.needsTurn' });
    for (const p of lp) fail(`listing.json: ${LISTING_TEXT[p.code]?.(p) ?? p.code}`);
    if (!lp.length) good('listing.json');
  }

  // 게임 실행
  const langs = listing.value && fullLangs(listing.value).length ? fullLangs(listing.value) : workingLangs(game ?? {});
  const result = checkGame(game, { n: games, langs });
  for (const p of result.problems) fail(p);
  for (const w of result.warnings) note(w);
  if (result.stats) {
    const { n, tally, avgMoves, avgMs, maxMs } = result.stats;
    if (!result.problems.length) good(`${n} random games (languages: ${langs.join(', ')})`);
    say(`    first player won ${tally[0]} · second player won ${tally[1]} · draws ${tally.draw + tally.maxActions} (hit maxActions ${tally.maxActions})`
      + ` · ${avgMoves.toFixed(1)} moves on average · play() ${avgMs.toFixed(3)}ms average, ${maxMs.toFixed(2)}ms max`);
  }

  // 썸네일
  const thumb = readJson(path.join(folder, 'thumbnail.json'));
  if (thumb.error) fail(`thumbnail.json is not valid JSON: ${thumb.error}`);
  else if (!thumb.value) note('no thumbnail.json, so the game list will show the starting position. Take one with "Use as thumbnail" in npx boardmadang dev.');
  else if (game && !result.stats) note('skipped the thumbnail check because the game code has problems.');
  else {
    const tp = checkThumbnail(game, thumb.value);
    for (const p of tp) fail(`thumbnail.json: ${p}`);
    if (!tp.length) good(`thumbnail.json (player ${thumb.value.player}'s board, ${thumb.value.view.pieces.length} pieces)`);
  }

  say();
  say(problems.length ? `Fix ${problems.length} problem${problems.length === 1 ? '' : 's'} before uploading.` : 'All checks passed.');
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
  say(`Made ${out} (${(data.length / 1024).toFixed(1)}KB)`);
  for (const n of names) say(`    ${n}`);
  say('Upload this file on boardmadang.com (game uploads are opening soon).');
  return true;
}

// ---- dev ----

async function dev(folder, { port = 5173 } = {}) {
  folder = path.resolve(folder);
  if (!fs.existsSync(path.join(folder, 'index.js'))) throw new Error(`No index.js in ${folder}. Run this in your game folder, or name the folder.`);
  try {
    const { url, id } = await startDev({ folder, port: Number(port) });
    say(`Playground: ${url}  (game: ${id})`);
    say('Edit your game code and refresh the page to see changes. Press Ctrl+C to stop.');
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use. Try another one, like --port 5174.`);
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
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
