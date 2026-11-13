// 십이장기를 "둘 수 있는 수" 형태로 쓴 것 (시제품, sdk/experimental/simple.js).
//
// 3×4 판에서 넷씩 가지고 둡니다. 잡은 기물은 내 것이 되어 손에 들어오고, 수를 두는 대신 빈칸에 내려놓을 수 있습니다.
// 화면은 6줄입니다: 0번 줄은 위쪽 플레이어(1)의 손, 1~4번 줄이 판, 5번 줄은 아래쪽 플레이어(0)의 손.
// 기물은 글자 두 개로 적습니다: 종류(k 왕, g 장, e 상, s 자, l 후) + 주인(0, 1). 예: 'k0'

const KINDS = { k: '王', g: '將', e: '相', s: '子', l: '侯' };
/** 기물마다 갈 수 있는 방향 (패에 삼각형으로 보이고, 규칙도 이걸로 정합니다). n이 앞입니다 */
const ARROWS = {
  k: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'],
  g: ['n', 'e', 's', 'w'],
  e: ['ne', 'se', 'sw', 'nw'],
  s: ['n'],
  l: ['n', 'ne', 'e', 's', 'w', 'nw'],
};
/** 방향 → [줄, 칸]의 변화. 아래쪽 플레이어(0) 기준이라 앞(n)이 줄 번호가 줄어드는 쪽입니다 */
const STEP = { n: [-1, 0], ne: [-1, 1], e: [0, 1], se: [1, 1], s: [1, 0], sw: [1, -1], w: [0, -1], nw: [-1, -1] };

const HAND_ROW = [5, 0]; // 플레이어마다 손이 있는 줄
const CAMP_ROW = [4, 1]; // 플레이어마다 자기 진영(맨 뒷줄)
const HAND_KINDS = ['e', 'g', 's']; // 손에 놓이는 순서 (자기 쪽에서 볼 때 왼쪽부터)
/** 손에서 그 종류가 놓이는 칸 */
const handCell = (player, kind) => ({ row: HAND_ROW[player], col: player === 0 ? HAND_KINDS.indexOf(kind) : 2 - HAND_KINDS.indexOf(kind) });

const onBoard = (row, col) => row >= 1 && row <= 4 && col >= 0 && col <= 2;
const ownerOf = (piece) => Number(piece[1]);

export default {
  id: 'twelve-simple',
  board: {
    places: 'cells', rows: 6, cols: 3, flipForPlayer: 1,
    areas: [{ side: 'top', row: 0, col: 0, rows: 1, cols: 3 }, { side: 'bottom', row: 5, col: 0, rows: 1, cols: 3 }],
  },
  pieces: Object.keys(KINDS).flatMap((kind) => [0, 1].map((player) => ({ name: kind + player, text: KINDS[kind], player, arrows: ARROWS[kind] }))),
  playerPieces: ['k0', 'k1'],
  maxActions: 300,
  noMoves: 'lose', // 둘 수 있는 수가 없으면 집니다
  repeat: 3, // 같은 판이 세 번 나오면 무승부

  setup: () => ({
    // grid[줄][칸] = 기물 | null. 판은 1~4번 줄만 씁니다
    grid: [
      [null, null, null],
      ['g1', 'k1', 'e1'],
      [null, 's1', null],
      [null, 's0', null],
      ['e0', 'k0', 'g0'],
      [null, null, null],
    ],
    hands: [{ e: 0, g: 0, s: 0 }, { e: 0, g: 0, s: 0 }],
    entered: null, // 왕이 방금 상대 진영에 들어간 플레이어. 상대가 다음 수에 못 잡으면 이깁니다
    won: null,
  }),

  moves(state, player) {
    const list = [];
    const forward = player === 0 ? 1 : -1; // 위쪽 플레이어는 방향이 반대입니다
    state.grid.forEach((line, row) => line.forEach((piece, col) => {
      if (!onBoard(row, col)) return;
      // 내 기물: 방향마다 한 칸. 내 기물이 있는 칸으로는 못 갑니다
      if (piece && ownerOf(piece) === player) {
        for (const dir of ARROWS[piece[0]]) {
          const to = { row: row + STEP[dir][0] * forward, col: col + STEP[dir][1] * forward };
          const there = onBoard(to.row, to.col) ? state.grid[to.row][to.col] : undefined;
          if (there === null || (there && ownerOf(there) !== player)) list.push({ from: { row, col }, to });
        }
      }
      // 손의 기물: 상대 진영이 아닌 빈칸에 내려놓습니다
      if (!piece && row !== CAMP_ROW[1 - player]) {
        for (const kind of HAND_KINDS) if (state.hands[player][kind] > 0) list.push({ from: handCell(player, kind), to: { row, col }, drop: kind });
      }
    }));
    return list;
  },

  move(state, m, player) {
    const { grid, hands } = state;
    const waiting = state.entered; // 지난 수에 왕을 내 진영에 넣은 상대
    state.entered = null;
    if (m.drop) {
      hands[player][m.drop] -= 1;
      grid[m.to.row][m.to.col] = m.drop + player;
    } else {
      const piece = grid[m.from.row][m.from.col];
      const taken = grid[m.to.row][m.to.col];
      if (taken?.[0] === 'k') state.won = player; // 왕을 잡으면 이깁니다
      else if (taken) hands[player][taken[0] === 'l' ? 's' : taken[0]] += 1; // 잡은 후는 자로 돌아옵니다
      grid[m.from.row][m.from.col] = null;
      const inCamp = m.to.row === CAMP_ROW[1 - player];
      grid[m.to.row][m.to.col] = piece[0] === 's' && inCamp ? `l${player}` : piece; // 자가 상대 진영에 닿으면 후
      if (piece[0] === 'k' && inCamp) state.entered = player;
    }
    // 상대의 왕이 내 진영에 들어왔는데 이번 수에 못 잡았으면 상대가 이깁니다
    if (waiting !== null && state.won === null) state.won = waiting;
  },

  winner: (state) => state.won,

  view(state) {
    const pieces = [];
    const text = [];
    state.grid.forEach((line, row) => line.forEach((piece, col) => {
      if (piece) pieces.push({ row, col, piece });
    }));
    for (const player of [0, 1]) {
      for (const kind of HAND_KINDS) {
        const n = state.hands[player][kind];
        if (n > 0) pieces.push({ ...handCell(player, kind), piece: kind + player });
        if (n > 1) text.push({ ...handCell(player, kind), text: String(n) });
      }
    }
    // 진영: 맨 뒷줄을 그 플레이어 색으로
    const tint = [0, 1].flatMap((player) => [0, 1, 2].map((col) => ({ row: CAMP_ROW[player], col, color: player })));
    return { pieces, text, tint };
  },
};
