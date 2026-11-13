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
//   check { n, langs, thumbnail }        등록창의 자동 검사 (sdk/check.js의 checkGame, checkThumbnail)
//   ai    { lang }                       AI 대국 준비. 학습 도구의 게임 어댑터(trainer/env.js)를 만들고 관측과 행동의 모양을 돌려줍니다
//   think { sims }                       지금 판에서 AI의 탐색(trainer/mcts.js)을 새로 시작합니다
//   answer { logits, value }             think나 answer가 부탁한 신경망 계산의 결과를 넘기고 탐색을 이어 갑니다
// look = { players: [0, 1], lang, legalFor: 0 | 1 | null }
//
// AI 대국: 탐색은 한 수마다 play()를 수백 번 부르므로 게임 코드 옆인 여기서 돌고, 신경망은 사이트 쪽 Worker(web/ai-net.js)에서 돕니다.
// 이 안에서는 WebAssembly와 네트워크가 막혀 있어서 신경망을 돌릴 수 없습니다 (실행기 CSP). 그래서 탐색이 신경망을 부를 때마다
// think/answer가 { need: { planes } }로 돌아가고, 화면이 그 관측을 신경망에 넣어 answer로 결과를 돌려줍니다.
// 탐색이 끝나면 { done: { action } | null }입니다 (둘 수가 없으면 null). 부를 때마다 시간 제한이 따로 걸립니다.
// 관측은 학습할 때와 같은 코드(trainer/env.js의 encode)로 만들어서 학습한 신경망이 본 것과 한 글자도 다르지 않습니다.

import { hashOf, makeRng, usesMoves } from '../../sdk/playground/platform.js';

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
  // AI 탐색이 쓰는 판 정보 (trainer/env.js의 Position): 둔 수(차례가 넘어간 행동 수)와 이번 차례에 나온 판의 해시들
  let moves = 0;
  let turnHashes = [];
  let ai = null; // { env, mcts } (ai를 부른 뒤)
  let thinking = null; // 진행 중인 탐색 { reply: 지금 think/answer의 { resolve, reject }, give: 신경망 결과를 받을 함수 }

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
      // moves()와 move()로 쓴 게임은 npx boardmadang pack이 게임 API로 바꾸는 코드를 zip에 같이 넣습니다. 폴더를 그냥 압축해 올리면 여기서 걸립니다
      if (usesMoves(game)) throw new Error('this game is written with moves() and move(): upload the zip that "npx boardmadang pack" makes');
      for (const k of ['setup', 'play', 'result', 'view']) {
        if (typeof game[k] !== 'function') throw new Error(`${k}() is missing`);
      }
      return {
        id: game.id,
        board: plain(game.board),
        pieces: plain(game.pieces),
        specialActions: plain(game.specialActions ?? []),
        maxActions: game.maxActions,
        playerPieces: plain(game.playerPieces),
        turn: typeof game.turn === 'function',
        legal: typeof game.legal === 'function',
      };
    },

    start({ seed, keep = false, look }) {
      state = game.setup(makeRng(seed));
      hash = hashOf(state);
      history = keep ? [state] : null;
      moves = 0;
      turnHashes = [hash];
      thinking = null;
      return { hash, turn: turnOf(state), look: lookAt(state, look) };
    },

    play({ moves: actions, look }) {
      const steps = [];
      for (const { player, action } of actions) {
        let next = state;
        let h = hash;
        try {
          next = game.play(state, player, action);
          h = hashOf(next);
        } catch {
          next = state; // 무시된 행동
          h = hash;
        }
        const turn = turnOf(next);
        steps.push({ hash: h, changed: h !== hash, turn });
        if (h !== hash) {
          // 차례가 넘어갔으면 한 수입니다 (trainer/env.js의 apply와 같은 규칙)
          if (turn !== player) {
            moves += 1;
            turnHashes = [h];
          } else if (!turnHashes.includes(h)) {
            turnHashes.push(h);
          }
        }
        state = next;
        hash = h;
        history?.push(state);
      }
      thinking = null;
      return { steps, look: lookAt(state, look) };
    },

    look({ at = null, look }) {
      const s = at === null ? state : history?.[at];
      if (s === undefined) throw new Error('no such move');
      return lookAt(s, look);
    },

    // 검사 코드는 게임 코드와 같은 Worker에서 돕니다. 게임 코드가 결과를 바꿀 수도 있으므로
    // 등록창은 이 결과를 올린 사람에게 보여 주기만 하고, 서버는 믿지 않습니다.
    async check({ n = 100, langs = ['en'], thumbnail = null }) {
      const { checkGame, checkThumbnail } = await import('../../sdk/check.js');
      const r = checkGame(game, { n, langs });
      return plain({ ...r, thumbnail: thumbnail ? checkThumbnail(game, thumbnail) : null });
    },

    // 학습 도구는 AI와 둘 때만 불러옵니다. lang은 학습할 때 쓴 언어입니다 (view()가 언어에 따라 다를 수 있음)
    async ai({ lang = 'en' }) {
      const [{ Env }, mcts] = await Promise.all([import('../../trainer/env.js'), import('../../trainer/mcts.js')]);
      const env = new Env(game, { lang });
      ai = { env, mcts };
      thinking = null;
      return {
        rows: env.rows,
        cols: env.cols,
        channels: env.channels,
        channelNames: env.channelNames(),
        specials: plain(env.specials),
        nActions: env.nActions,
      };
    },

    think({ sims = 100 }) {
      if (!ai) throw new Error('call ai first');
      const { env, mcts } = ai;
      const pos = { state, hash, moves, turnHashes: [...turnHashes] };
      const run = { reply: null, give: null };
      thinking = run; // 앞서 하던 탐색은 버립니다
      const evaluate = (p, actions) => new Promise((give) => {
        run.give = ({ logits, value }) => give({ policy: mcts.networkPolicy(logits, actions), value: Number(value) || 0 });
        run.reply.resolve({ need: { planes: env.encode(p) } });
      });
      return new Promise((resolve, reject) => {
        run.reply = { resolve, reject };
        (async () => {
          const root = await mcts.search(env, new mcts.Node(pos), evaluate, { sims: Math.max(1, Math.min(5000, sims | 0)) });
          const child = root.outcome ? null : mcts.pick(env, root, 0);
          return child && { action: plain(env.actionOf(child.action)) };
        })().then(
          (done) => {
            if (thinking === run) thinking = null;
            run.reply.resolve({ done });
          },
          (err) => {
            if (thinking === run) thinking = null;
            run.reply.reject(err);
          },
        );
      });
    },

    answer({ logits, value }) {
      const run = thinking;
      if (!run?.give) throw new Error('nothing to answer');
      const give = run.give;
      run.give = null;
      return new Promise((resolve, reject) => {
        run.reply = { resolve, reject };
        give({ logits, value });
      });
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
