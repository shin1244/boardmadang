// Chess soccer (work in progress): chess pieces play football on a pitch 7 squares wide and 9 long. Kick the ball into the opponent's goal to win.
// Try it: npx boardmadang dev sdk/examples/soccer
//
// The grid has 11 rows: row 0 is the top goal, rows 1-9 are the pitch, row 10 is the bottom goal. A goal is the middle 3 squares of its row.
// Player 0 sits at the bottom and shoots at the top goal; player 1 sits at the top.
// A piece is two characters: its kind (K king, R rook, B bishop, N knight, P pawn) + its owner (0, 1). For example 'R0'
//
// Rules
//   - Pieces move like chess pieces, but nothing is ever captured: pieces only block.
//   - A piece that moves onto the ball must kick it. The kick follows the piece's own pattern:
//       rook    sends the ball in a straight line       bishop  sends it diagonally
//       knight  chips it over everything, in an L       king    one square, any direction
//       pawn    one square diagonally forward
//   - A rook's or bishop's kick goes as far as the kicker likes, up to a wall or the square in front of an opponent's piece.
//   - If the ball reaches one of your own pieces, that piece kicks it on, in the same turn (each piece kicks once a turn).
//   - The ball in a goal ends the game. Kicking it into your own goal counts for the opponent.
//
// Rules that are still being tried out (options of makeGame, compared in ../soccer-sim.js)
//   keeper     (off) a sliding ball stops as soon as it is next to the opponent's king
//   chipGoals  (on)  a knight may chip the ball straight into the goal
//   goalWidth  (3)   how many squares wide a goal is
//   anyDistance (on) a rook's or bishop's kick may stop on any square on its way. Off: the ball rolls until something stops it
//   cols       (7)   how many squares wide the pitch is (it is always 9 long). 9 was the first try: half of those games had no goal

const OWN_GOAL_ROW = [10, 0]; // the goal each player defends
const inPitch = (row, col, cols) => row >= 1 && row <= 9 && col >= 0 && col < cols;
/** The columns of a goal that is `width` squares wide, in the middle of a back line of `cols` squares */
const goalCols = (width, cols) => Array.from({ length: width }, (_, i) => (cols - width) / 2 + i);
const ownerOf = (piece) => Number(piece[1]);
const same = (a, b) => a.row === b.row && a.col === b.col;

const ALL = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const STRAIGHT = ALL.filter(([dr, dc]) => dr === 0 || dc === 0);
const DIAGONAL = ALL.filter(([dr, dc]) => dr !== 0 && dc !== 0);
const JUMPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
/** Forward for a player: up the grid (smaller rows) for the bottom player */
const ahead = (player) => (player === 0 ? -1 : 1);

/** How each kind walks and how it kicks: the directions, and whether it slides until something stops it */
const WALK = {
  K: () => ({ dirs: ALL, slide: false }),
  R: () => ({ dirs: STRAIGHT, slide: true }),
  B: () => ({ dirs: DIAGONAL, slide: true }),
  N: () => ({ dirs: JUMPS, slide: false }),
  P: (player) => ({ dirs: [[ahead(player), 0], [0, -1], [0, 1]], slide: false }), // forward or sideways, never back
};
const KICK = { ...WALK, P: (player) => ({ dirs: [[ahead(player), -1], [ahead(player), 1]], slide: false }) };

/** How each kind is drawn: the letter on its tile and the directions it walks */
const TILES = { K: ['K', ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']], R: ['R', ['n', 'e', 's', 'w']], B: ['B', ['ne', 'se', 'sw', 'nw']], N: ['N', []], P: ['P', ['n', 'e', 'w']] };
const TEXT = {
  en: { kick: 'Choose where to kick the ball', goal: 'Goal!', own: 'Own goal' },
  ko: { kick: '공을 찰 곳을 고르세요', goal: '골!', own: '자책골' },
};

/** The king's square of a player, or null */
function kingOf(grid, player) {
  for (let row = 1; row <= 9; row++) {
    const col = grid[row].indexOf(`K${player}`);
    if (col >= 0) return { row, col };
  }
  return null;
}

/**
 * Where the piece at `at` can send the ball: [{ row, col, goal?, pass? }].
 * `used` holds the squares of the pieces that already kicked this turn (they block instead of receiving).
 */
function kickTargets(grid, at, used, rules) {
  const kind = grid[at.row][at.col][0];
  const player = ownerOf(grid[at.row][at.col]);
  const { dirs, slide } = KICK[kind](player);
  const guard = rules.keeper ? kingOf(grid, 1 - player) : null;
  const targets = [];
  for (const [dr, dc] of dirs) {
    let { row, col } = at;
    for (;;) {
      const next = { row: row + dr, col: col + dc };
      if ((next.row === 0 || next.row === 10) && rules.goal.includes(next.col)) {
        if (kind !== 'N' || rules.chipGoals) targets.push({ ...next, goal: true });
        break;
      }
      const there = inPitch(next.row, next.col, rules.cols) ? grid[next.row][next.col] : undefined;
      if (there === null) {
        ({ row, col } = next);
        const caught = guard && Math.abs(guard.row - row) <= 1 && Math.abs(guard.col - col) <= 1;
        const rolls = slide && !caught;
        if (!rolls || rules.anyDistance) targets.push({ row, col }); // the ball may stop here
        if (rolls) continue; // and it may keep rolling
      } else if (there && ownerOf(there) === player && !used.some((u) => same(u, next)) && kickTargets(grid, next, [...used, at], rules).length) {
        targets.push({ ...next, pass: true }); // a teammate who can kick it on
      } else if (!rules.anyDistance && (row !== at.row || col !== at.col)) {
        targets.push({ row, col }); // a wall or a piece: the ball stops in front of it
      }
      break;
    }
  }
  return targets;
}

/** The game, with the rules that are still being tried out as options */
export function makeGame({ keeper = false, chipGoals = true, goalWidth = 3, cols = 7, anyDistance = true } = {}) {
  const rules = { keeper, chipGoals, anyDistance, cols, goal: goalCols(goalWidth, cols) };
  const mid = (cols - 1) / 2; // the middle column
  return {
    id: 'chess-soccer',
    board: {
      places: 'cells', rows: 11, cols, look: 'plain', flipForPlayer: 1,
      areas: [{ side: 'top', row: 0, col: rules.goal[0], rows: 1, cols: goalWidth }, { side: 'bottom', row: 10, col: rules.goal[0], rows: 1, cols: goalWidth }],
    },
    pieces: [
      ...Object.keys(TILES).flatMap((kind) => [0, 1].map((player) => ({ name: kind + player, text: TILES[kind][0], player, arrows: TILES[kind][1] }))),
      { name: 'ball', text: '●' },
    ],
    playerPieces: ['K0', 'K1'],
    maxActions: 200,
    repeat: 3,

    setup: () => {
      const grid = Array.from({ length: 11 }, () => Array(cols).fill(null));
      // Bottom player: keeper on the back row, two pawns in front of it, then knight, rook, bishop. The top player mirrors it
      [grid[9][mid], grid[8][mid - 2], grid[8][mid + 2], grid[7][mid - 1], grid[7][mid], grid[7][mid + 1]] = ['K0', 'P0', 'P0', 'N0', 'R0', 'B0'];
      [grid[1][mid], grid[2][mid + 2], grid[2][mid - 2], grid[3][mid + 1], grid[3][mid], grid[3][mid - 1]] = ['K1', 'P1', 'P1', 'N1', 'R1', 'B1'];
      return {
        grid,
        ball: { row: 5, col: mid }, // null while a piece is about to kick it
        kicked: null, // where the ball was last kicked from (so it is shown rolling)
        kick: null, // { at: the piece that must kick now, used: the pieces that already kicked this turn }
        won: null, // { winner, own } once the ball is in a goal
      };
    },

    moves(state, player) {
      const { grid, ball, kick } = state;
      if (kick) return kickTargets(grid, kick.at, kick.used, rules);
      const list = [];
      grid.forEach((line, row) => line.forEach((piece, col) => {
        if (!piece || ownerOf(piece) !== player) return;
        const { dirs, slide } = WALK[piece[0]](player);
        for (const [dr, dc] of dirs) {
          for (let to = { row: row + dr, col: col + dc }; inPitch(to.row, to.col, cols) && grid[to.row][to.col] === null; to = { row: to.row + dr, col: to.col + dc }) {
            if (!same(to, ball)) list.push({ from: { row, col }, to });
            else if (kickTargets(withMove(grid, { row, col }, to), to, [], rules).length) list.push({ from: { row, col }, to }); // onto the ball: only if it can be kicked
            if (!slide || same(to, ball)) break; // nothing walks through the ball
          }
        }
      }));
      return list;
    },

    move(state, m, player) {
      const { grid } = state;
      if (!state.kick) {
        grid[m.to.row][m.to.col] = grid[m.from.row][m.from.col];
        grid[m.from.row][m.from.col] = null;
        if (!same(m.to, state.ball)) return undefined;
        state.ball = null;
        state.kick = { at: m.to, used: [] }; // stepped onto the ball: now kick it
        return 'again';
      }
      const { at, used } = state.kick;
      state.kicked = at;
      if (m.pass) {
        state.kick = { at: { row: m.row, col: m.col }, used: [...used, at] };
        return 'again';
      }
      state.kick = null;
      state.ball = { row: m.row, col: m.col };
      if (m.goal) {
        const scorer = m.row === OWN_GOAL_ROW[1] ? 0 : 1; // the ball is in the top goal: the bottom player scores
        state.won = { winner: scorer, own: scorer !== player };
      }
      return undefined;
    },

    winner: (state) => state.won && { winner: state.won.winner, reason: Object.fromEntries(Object.entries(TEXT).map(([lang, t]) => [lang, state.won.own ? t.own : t.goal])) },

    view(state, player, lang) {
      const { grid, ball, kick } = state;
      const pieces = [];
      grid.forEach((line, row) => line.forEach((piece, col) => {
        if (piece) pieces.push({ row, col, piece });
      }));
      if (ball) pieces.push({ ...ball, piece: 'ball', ...(state.kicked ? { from: state.kicked } : {}) });
      // The goals, in the color of the player who defends them
      const tint = [0, 1].flatMap((p) => rules.goal.map((col) => ({ row: OWN_GOAL_ROW[p], col, color: p })));
      if (!kick) return { pieces, tint };
      // A piece is on the ball: show it, and show the kicker where the ball can go
      const mine = ownerOf(grid[kick.at.row][kick.at.col]) === player;
      return {
        pieces,
        tint,
        text: [{ ...kick.at, text: '●' }],
        marks: mine ? [{ ...kick.at, type: 'ring' }, ...kickTargets(grid, kick.at, kick.used, rules).map(({ row, col }) => ({ row, col, type: 'dot' }))] : [],
        ...(mine ? { message: (TEXT[lang] ?? TEXT.en).kick } : {}),
      };
    },
  };
}

/** A copy of the grid with one piece moved */
function withMove(grid, from, to) {
  const copy = grid.map((line) => line.slice());
  copy[to.row][to.col] = copy[from.row][from.col];
  copy[from.row][from.col] = null;
  return copy;
}

export default makeGame();
