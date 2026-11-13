// 게임을 "둘 수 있는 수"와 "그 수를 두면"만으로 쓰는 형태. toGame()이 이것을 게임 API(setup, play, result, view, turn, legal)로 바꿉니다.
//
// 게임 API는 같은 규칙을 세 군데에 나눠 씁니다. play()는 반칙을 걸러 내고, legal()은 둘 수 있는 수를 늘어놓고,
// turn()은 누구 차례인지 말하고, 셋이 어긋나면 검사에 걸립니다. 이 형태에서는 규칙을 한 번만 씁니다.
//
//   export default {
//     id, board, pieces,               게임 API와 같습니다 (maxActions는 안 적으면 300)
//     specialActions                   판 밖의 행동(버튼). 이름 목록 ['pass']이거나, 버튼 글자까지 { pass: { en: 'Pass', ko: '넘기기' } }
//     setup(rng)                       시작 상태
//     moves(state, player)             player가 지금 둘 수 있는 수의 목록
//     move(state, m, player)           그 수를 둡니다. 받은 state를 그대로 고쳐도 됩니다. m은 moves()가 돌려준 바로 그 수입니다.
//                                      'again'을 돌려주면 차례가 넘어가지 않고 같은 플레이어가 이어서 둡니다
//     winner(state)                    0 | 1 (이긴 쪽) | 'draw' | 그 밖(아직 안 끝남). 이유를 붙이려면 { winner, reason: 글자 | 언어별 글자 }
//     view(state, player, lang)        그릴 것 (게임 API의 view()와 같은 모양)
//     noMoves: 'draw' | 'lose'         둘 수 있는 수가 없으면 무승부(기본)인지, 그 플레이어가 지는지
//     repeat: 3                        같은 판(판과 차례)이 이만큼 나오면 무승부 (안 적으면 보지 않음)
//   }
//
// 수(move)의 모양은 셋입니다.
//   { row, col }                칸 하나를 누르는 수 (틱택토, 오목)
//   { from, to }                기물을 골라서(from) 옮기는 수 (체스, 장기). 판 밖 영역의 칸에서 오면 "손에서 내려놓기"입니다
//   { special: 'pass' }         판 아래 버튼을 누르는 수 (specialActions에 적은 이름). moves()에 없을 때는 버튼이 흐려집니다
// 수에는 다른 칸을 얼마든지 붙여도 되고(잡는 기물, 승급 여부 등), move()가 그대로 돌려받습니다.
// 출발과 도착이 같은 수가 여럿이면(체스의 승급 고르기) 목록의 첫 번째를 둡니다.
//
// toGame()이 대신 하는 일
//   차례          한 수마다 번갈아 둡니다 (move()가 'again'을 돌려주면 한 번 더). 차례가 아닌 쪽의 수와 moves()에 없는 수는 무시합니다
//   이어서 두기    옮긴 기물로 이어서 둘 수 있으면 그 기물을 고른 채로 둡니다 (체커의 연속 뛰기)
//   기물 고르기    from이 있는 수는 "기물 누르기 → 갈 곳 누르기"로 받고, 다른 기물을 누르면 바꾸고, 다시 누르면 취소합니다
//   표시          고른 기물(ring), 갈 수 있는 곳(dot), 마지막 수(last-move), 방금 움직인 기물의 움직임(from)을 화면에 붙입니다
//   끝           winner(), 둘 수 없음(noMoves), 같은 판 반복(repeat)을 한 수마다 봅니다
//   안내 글자      "내 차례 / 상대 차례 / 이겼습니다 / 졌습니다 / 무승부" (view()가 message를 주면 그걸 씁니다)
//   legal()       moves()에서 만들어서, 호버 표시와 AI가 바로 씁니다
//
// 어디서 바꾸나
//   내 컴퓨터     npx boardmadang dev / check, 플레이그라운드, AI 학습 도구가 게임을 불러올 때 toGame()을 거칩니다.
//   올릴 때       npx boardmadang pack이 이 파일과 platform.js를 zip에 같이 넣고, index.js가 toGame()을 거치게 합니다 (lib/games.js의 packedCode).
//                 그래서 사이트가 받는 것은 언제나 게임 API로 된 게임이고, 사이트와 서버는 이 형태를 모릅니다.
// 올린 게임은 그때의 이 파일을 품고 있습니다. 이 파일을 나중에 고쳐도 이미 올린 게임의 대국과 기보는 달라지지 않습니다
// (게임 코드 버전에 이 파일까지 들어갑니다). 반대로 여기서 고친 것은 다시 pack해서 올려야 그 게임에 들어갑니다.
// zip에 그대로 들어가므로 이 파일은 platform.js 말고는 import하지 않습니다.

import { hashOf, usesMoves } from './platform.js';

const same = (a, b) => !!a && !!b && a.row === b.row && a.col === b.col;
const cell = ({ row, col }) => ({ row, col });
const clone = (v) => JSON.parse(JSON.stringify(v));
/** 수가 닿는 칸: 옮기는 수는 to, 칸 하나를 누르는 수는 그 칸 */
const target = (m) => m.to ?? m;

// 사이트는 화면 글자를 한국어와 영어로 갖고 있습니다. 다른 언어는 영어로 보입니다
const TEXT = {
  en: { mine: 'Your turn', theirs: "Opponent's turn", won: 'You won!', lost: 'You lost', draw: 'Draw', noMoves: 'No moves left', repeat: 'The same position came up again' },
  ko: { mine: '내 차례', theirs: '상대 차례', won: '이겼습니다!', lost: '졌습니다', draw: '무승부', noMoves: '둘 수 있는 수가 없음', repeat: '같은 판이 다시 나옴' },
};

/** 글자 하나이거나 언어별 글자({ en, ko, ... })에서 lang의 글자. 그 언어가 없으면 영어, 그것도 없으면 fallback */
const textIn = (value, lang, fallback) => (typeof value === 'string' ? value : value?.[lang] ?? value?.en ?? fallback);

/**
 * 이 형태로 쓴 게임을 게임 API로 바꿉니다. 이미 게임 API로 쓴 게임(play()가 있음)이면 그대로 돌려줍니다.
 * 플랫폼이 보는 상태는 { game: 게임이 쓰는 상태, turn, pick: 고른 기물의 칸, last: 마지막 수, end: 끝났으면 결과, seen: 나온 판 }입니다.
 */
export function toGame(def) {
  if (!usesMoves(def)) return def;
  const { setup, moves, move, winner, view, noMoves = 'draw', repeat = 0, observe, specialActions, ...rest } = def;
  const movesOf = (st) => (st.end ? [] : moves(st.game, st.turn) ?? []);
  // 특수 행동: 이름 목록이거나, 이름 → 버튼 글자 (글자 하나, 또는 언어별 글자)
  const specials = Array.isArray(specialActions) ? specialActions : Object.keys(specialActions ?? {});
  const labelOf = (kind, lang) => (Array.isArray(specialActions) ? kind : textIn(specialActions[kind], lang, kind));

  /** 시작할 때와 한 수를 둔 뒤: 끝났으면 st.end에 적습니다 */
  function settle(st) {
    const w = winner?.(st.game);
    const who = w !== null && typeof w === 'object' ? w.winner : w; // 이유를 붙인 { winner, reason }도 됩니다
    if (who === 0 || who === 1) st.end = { winner: who };
    else if (who === 'draw') st.end = { winner: null };
    if (st.end && w?.reason !== undefined) st.end.reason = w.reason;
    if (!st.end && repeat) {
      // 판마다 해시 두 개를 이어 붙여 셉니다 (상태에 판을 통째로 쌓으면 64KB를 넘습니다)
      const key = hashOf([0, st.game, st.turn]) + hashOf([1, st.game, st.turn]);
      st.seen[key] = (st.seen[key] ?? 0) + 1;
      if (st.seen[key] >= repeat) st.end = { winner: null, why: 'repeat' };
    }
    if (!st.end && !movesOf(st).length) st.end = { winner: noMoves === 'lose' ? 1 - st.turn : null, why: 'noMoves' };
    return st;
  }

  return {
    maxActions: 300,
    ...rest,
    ...(specials.length ? { specialActions: specials } : {}),

    setup: (rng) => settle({ game: setup(rng), turn: 0, pick: null, last: null, end: null, ...(repeat ? { seen: {} } : {}) }),

    turn: (st) => (st.end ? null : st.turn),

    play(st, player, action) {
      if (st.end || player !== st.turn) return st;
      const at = action?.kind === 'click' ? { row: action.row, col: action.col } : null;
      const all = movesOf(st);
      // 버튼이면 그 특수 행동, 칸이면 고른 기물의 갈 곳이거나 칸 하나를 누르는 수
      const m = all.find((x) => (!at ? x.special !== undefined && x.special === action?.kind
        : x.from ? same(x.from, st.pick) && same(x.to, at) : same(x, at)));
      if (m) {
        const next = { ...clone(st), pick: null, last: m.special !== undefined ? null : m.from ? { from: cell(m.from), to: cell(m.to) } : { to: cell(m) } };
        const again = move(next.game, clone(m), player) === 'again';
        // 이어서 두겠다고 했어도 둘 수가 없으면 차례를 넘깁니다
        if (!again || !(moves(next.game, player) ?? []).length) next.turn = 1 - player;
        settle(next);
        // 방금 옮긴 기물로 이어서 두는 것이면 그 기물을 고른 채로 둡니다
        if (next.turn === player && m.to && movesOf(next).some((x) => same(x.from, m.to))) next.pick = cell(m.to);
        return next;
      }
      if (!at) return st;
      // 기물 고르기: 다시 누르면 취소, 다른 기물을 누르면 바꿉니다. 차례는 그대로입니다
      if (same(st.pick, at)) return { ...st, pick: null };
      if (all.some((x) => same(x.from, at))) return { ...st, pick: at };
      return st;
    },

    legal(st, player) {
      if (player !== st.turn) return [];
      const all = movesOf(st);
      const cells = all.filter((m) => m.special === undefined).map((m) => (!m.from || !same(m.from, st.pick) ? m.from ?? m : m.to));
      return [
        ...cells.filter((c, i) => cells.findIndex((x) => same(x, c)) === i).map((c) => ({ kind: 'click', row: c.row, col: c.col })),
        ...specials.filter((kind) => all.some((m) => m.special === kind)).map((kind) => ({ kind })),
      ];
    },

    result(st, lang) {
      if (!st.end) return null;
      // 게임이 붙인 이유(글자 하나 또는 언어별 글자)이거나, 둘 수 없음 · 같은 판 반복의 기본 글자
      const reason = st.end.reason !== undefined ? textIn(st.end.reason, lang) : (TEXT[lang] ?? TEXT.en)[st.end.why];
      return reason ? { winner: st.end.winner, reason } : { winner: st.end.winner };
    },

    view(st, player, lang) {
      const v = view(st.game, player, lang) ?? {};
      const text = TEXT[lang] ?? TEXT.en;
      const marks = [...(v.marks ?? [])];
      // 방금 움직인 기물은 온 칸에서 미끄러져 옵니다
      const pieces = (v.pieces ?? []).map((p) => (st.last?.from && same(p, st.last.to) ? { ...p, from: st.last.from } : p));
      if (st.last) marks.push({ ...st.last.to, type: 'last-move' });
      if (st.pick && player === st.turn) {
        marks.push({ ...st.pick, type: 'ring' });
        for (const m of movesOf(st)) if (same(m.from, st.pick)) marks.push({ ...cell(m.to), type: 'dot' });
      }
      const message = st.end
        ? (st.end.winner === null ? text.draw : st.end.winner === player ? text.won : text.lost)
        : (player === st.turn ? text.mine : text.theirs);
      // 버튼을 늘 알려 줘야 플랫폼이 지금 못 누르는 버튼(legal()에 없는 것)을 흐리게 보여 줍니다
      const buttons = specials.length ? { buttons: v.buttons ?? specials.map((kind) => ({ kind, label: labelOf(kind, lang) })) } : {};
      return { ...v, ...buttons, pieces, marks, message: v.message ?? message };
    },

    ...(observe ? { observe: (st, player) => observe(st.game, player) } : {}),
  };
}
