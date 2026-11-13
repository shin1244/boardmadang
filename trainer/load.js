// 게임 폴더(index.js, listing.json)를 불러와 학습 환경을 만듭니다 (Node 전용).
//
// 주의: 게임 코드를 이 프로세스에서 그대로 돌립니다. 지금은 레포의 게임과 내 컴퓨터의 게임에만 씁니다.
// 서버에서 올린 게임을 학습할 때는 네트워크가 없고 시간·메모리를 제한한 컨테이너 안에서 돌려야 합니다.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toGame } from '../sdk/playground/moves.js';
import { Env } from './env.js';

/** listing.json에서 완전 번역한 첫 언어. 없으면 'en' */
async function gameLang(dir) {
  try {
    const listing = JSON.parse(await readFile(path.join(dir, 'listing.json'), 'utf8'));
    const full = Object.entries(listing.languages ?? {}).find(([, v]) => v === 'full');
    return full?.[0] ?? 'en';
  } catch {
    return 'en';
  }
}

export async function loadEnv(dir) {
  // moves()와 move()로 쓴 게임이면 게임 API로 바꿉니다 (사이트에서 받은 코드 zip은 이미 바뀌어 있어 그대로 지나갑니다)
  const game = toGame((await import(pathToFileURL(path.resolve(dir, 'index.js')).href)).default);
  return new Env(game, { lang: await gameLang(dir) });
}
