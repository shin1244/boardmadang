// 게임 코드를 돌리는 쪽 (web/engine.js의 실행기). 보통은 Worker(worker.js) 안에서,
// Worker를 띄울 수 없는 브라우저에서는 샌드박스 iframe(frame.js) 안에서 바로 돌립니다. 어느 쪽이든 출처가 없고 CSP에 갇혀 있습니다.
// 판 상태는 여기에만 있고, 사이트 화면은 "이 수를 둬라", "지금 판을 보여 달라"고 부탁해서 결과만 받습니다.
//
// 해시와 시드 난수는 대국 화면이 쓰던 platform.js 그대로라서, 두 플레이어의 브라우저가 같은 결과를 냅니다.
// 게임 함수가 오류를 던지면 예전처럼 다룹니다: play()면 무시된 행동(상태 그대로), view()면 빈 판, result()면 진행 중.
// 상대 브라우저에서도 같은 오류가 나므로(결정적) 판이 어긋나지 않습니다.
//
// 메시지: { id, method, args } → { id, ok: true, value } 또는 { id, ok: false, error }
//   load  { module }                     게임 모듈을 불러오고 판 설정 같은 정보를 돌려줍니다
//   start { seed, keep, look }           새 판. keep이면 다시보기용으로 모든 상태를 남깁니다
//   play  { moves: [{ player, action }], look }   행동을 차례로 적용하고 행동마다 해시, 상태를 바꿨는지, 차례를 돌려줍니다
//   look  { at, look }                   지금(또는 at번째 행동 뒤) 판의 결과, 화면, 둘 수 있는 수
// look = { players: [0, 1], lang, legalFor: 0 | 1 | null }

import { hashOf, makeRng } from '../../sdk/playground/platform.js';

/** 구조화 복사로 보낼 수 없는 값(함수, 클래스)을 걸러 낸 JSON 복사본 */
const plain = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function attempt(f, fallback) {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/** 게임 하나. 메시지를 받아 답을 돌려주는 함수를 만듭니다. */
export function createHost() {
  let game = null;
  let state = null;
  let hash = '';
  let history = null; // keep이면 [처음 상태, 행동 1 뒤, …]

  function turnOf(s) {
    if (typeof game.turn !== 'function') return null;
    const t = attempt(() => game.turn(s), null);
    return t === 0 || t === 1 ? t : null;
  }

  function lookAt(s, { players = [], lang = 'en', legalFor = null } = {}) {
    const views = {};
    for (const p of players) views[p] = attempt(() => plain(game.view(s, p, lang)), null);
    return {
      result: attempt(() => plain(game.result(s, lang)), null),
      views,
      legal: legalFor !== null && typeof game.legal === 'function' ? attempt(() => plain(game.legal(s, legalFor)), null) : null,
    };
  }

  const methods = {
    async load({ module }) {
      game = (await import(module)).default;
      if (!game || typeof game !== 'object') throw new Error('index.js needs a default export');
      for (const k of ['setup', 'play', 'result', 'view']) {
        if (typeof game[k] !== 'function') throw new Error(`${k}() is missing`);
      }
      return {
        id: game.id,
        board: plain(game.board),
        pieces: plain(game.pieces),
        specialActions: plain(game.specialActions ?? []),
        maxActions: game.maxActions,
        turn: typeof game.turn === 'function',
        legal: typeof game.legal === 'function',
      };
    },

    start({ seed, keep = false, look }) {
      state = game.setup(makeRng(seed));
      hash = hashOf(state);
      history = keep ? [state] : null;
      return { hash, turn: turnOf(state), look: lookAt(state, look) };
    },

    play({ moves, look }) {
      const steps = [];
      for (const { player, action } of moves) {
        let next = state;
        let h = hash;
        try {
          next = game.play(state, player, action);
          h = hashOf(next);
        } catch {
          next = state; // 무시된 행동
          h = hash;
        }
        steps.push({ hash: h, changed: h !== hash, turn: turnOf(next) });
        state = next;
        hash = h;
        history?.push(state);
      }
      return { steps, look: lookAt(state, look) };
    },

    look({ at = null, look }) {
      const s = at === null ? state : history?.[at];
      if (s === undefined) throw new Error('no such move');
      return lookAt(s, look);
    },
  };

  /** 메시지 하나를 처리합니다. 모르는 메시지면 null */
  return async function handle(msg) {
    const { id, method, args } = msg ?? {};
    if (!Object.hasOwn(methods, method)) return null;
    try {
      return { id, ok: true, value: await methods[method](args ?? {}) };
    } catch (err) {
      return { id, ok: false, error: String(err?.message ?? err) };
    }
  };
}
