// Chess soccer: compares rule options by playing many games. Not part of the game (it sits outside the game folder).
//   node sdk/examples/soccer-sim.js 500     → 500 games for each set of rules
//
// A turn is one piece move and, if it stepped onto the ball, kicks until the ball rests (it calls moves() and move() directly).
// The player is deliberately simple: it scores if it can, avoids moves that let the opponent score next turn,
// and otherwise sends the ball as far forward as it can (looking at about 16 of its moves, with some randomness).
// So the numbers show how easy it is to break through a careful defender, not how strong players would do.
import { makeGame } from './soccer/index.js';

const N = Number(process.argv[2] ?? 200);
const TURNS = 200; // no goal after this many turns: a draw
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => !!a && !!b && a.row === b.row && a.col === b.col;
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const pickOne = (list) => list[Math.floor(rnd() * list.length)];
const shuffled = (list) => list.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

/** The state after one move. `again`: the same player goes on */
function step(def, game, m, player) {
  const next = clone(game);
  const again = def.move(next, m, player) === 'again';
  return { next, again };
}

/** Moves that score this turn for `player` (the first line found), or null. Only moves onto the ball can */
function scoringLine(def, game, player, path = []) {
  for (const m of def.moves(game, player)) {
    if (!game.kick && !same(m.to, game.ball)) continue;
    const { next, again } = step(def, game, m, player);
    if (next.won) {
      if (next.won.winner === player) return [...path, m];
      continue;
    }
    if (again) {
      const line = scoringLine(def, next, player, [...path, m]);
      if (line) return line;
    }
  }
  return null;
}

/** Every way the rest of this turn can go: [{ state, line }] (all the ways to kick). Own goals are left out */
function endings(def, game, player, line = [], out = []) {
  for (const m of def.moves(game, player)) {
    const { next, again } = step(def, game, m, player);
    if (next.won) {
      if (next.won.winner === player) out.push({ state: next, line: [...line, m] });
    } else if (again) endings(def, next, player, [...line, m], out);
    else out.push({ state: next, line: [...line, m] });
  }
  return out;
}

/** How far the ball is toward the opponent's goal (0-8). While it is being kicked: where the kicker stands */
const progress = (state, player) => { const at = state.ball ?? state.kick.at; return player === 0 ? 9 - at.row : at.row - 1; };

const PLAYERS = {
  // Any move at all (own goals too)
  random(def, game, player) {
    const line = [];
    for (let again = true; again && !game.won;) {
      const m = pickOne(def.moves(game, player));
      ({ next: game, again } = step(def, game, m, player));
      line.push(m);
      if (again && !def.moves(game, player).length) break;
    }
    return { state: game, line };
  },
  // Scores if it can, avoids moves that concede next turn, then sends the ball as far forward as it can (with some noise)
  careful(def, game, player) {
    const goal = scoringLine(def, game, player);
    if (goal) {
      let state = game;
      for (const m of goal) state = step(def, state, m, player).next;
      return { state, line: goal };
    }
    const firsts = shuffled(def.moves(game, player));
    let best = null;
    let unsafe = null;
    let looked = 0;
    for (const m of firsts) {
      const { next, again } = step(def, game, m, player);
      const ends = again ? endings(def, next, player, [m]) : [{ state: next, line: [m] }];
      for (const e of ends) {
        if (e.state.won) continue;
        if (scoringLine(def, e.state, 1 - player)) { unsafe ??= e; continue; }
        const score = progress(e.state, player) + rnd() * 1.5;
        if (!best || score > best.score) best = { ...e, score };
      }
      if (++looked >= 16 && best) break; // it picks from about 16 moves instead of all of them
    }
    return best ?? unsafe ?? PLAYERS.random(def, game, player);
  },
};

function playGame(def, kind) {
  let game = def.setup();
  let player = 0;
  for (let turn = 1; turn <= TURNS; turn++) {
    if (!def.moves(game, player).length) return { end: 'stuck', turns: turn };
    const before = game;
    const { state, line } = PLAYERS[kind](def, game, player);
    game = state;
    if (game.won) {
      const kicks = line.filter((m) => m.row !== undefined);
      // The last kicker: the piece on the square the ball left (kicked)
      const kicker = game.grid[game.kicked.row][game.kicked.col][0];
      const first = line[0];
      return { end: game.won.winner, own: game.won.own, turns: turn, kicks: kicks.length, kicker, walked: before.grid[first.from.row][first.from.col][0] };
    }
    player = 1 - player;
  }
  return { end: 'draw', turns: TURNS };
}

const VARIANTS = [
  ['goal 3, no keeper, chip goals', { keeper: false, chipGoals: true, goalWidth: 3 }],
  ['goal 3, keeper,    chip goals', { keeper: true, chipGoals: true, goalWidth: 3 }],
  ['goal 3, no keeper, no chips  ', { keeper: false, chipGoals: false, goalWidth: 3 }],
  ['goal 3, keeper,    no chips  ', { keeper: true, chipGoals: false, goalWidth: 3 }],
  ['goal 5, no keeper, chip goals', { keeper: false, chipGoals: true, goalWidth: 5 }],
  ['goal 5, no keeper, no chips  ', { keeper: false, chipGoals: false, goalWidth: 5 }],
  ['goal 5, keeper,    no chips  ', { keeper: true, chipGoals: false, goalWidth: 5 }],
];
for (const [name, rules] of VARIANTS) {
  const def = makeGame(rules);
  const games = Array.from({ length: N }, () => playGame(def, 'careful'));
  const won = games.filter((g) => g.end === 0 || g.end === 1);
  const pct = (list, of = games) => `${of.length ? Math.round((list.length / of.length) * 100) : 0}%`.padStart(4);
  const avg = (f) => (won.length ? (won.reduce((x, g) => x + f(g), 0) / won.length).toFixed(0) : '-');
  const kickers = Object.entries(won.reduce((o, g) => ({ ...o, [g.kicker]: (o[g.kicker] ?? 0) + 1 }), {})).sort((x, y) => y[1] - x[1])
    .map(([k, n]) => `${k} ${Math.round((n / won.length) * 100)}%`).join(' ');
  console.log(`${name} | first ${pct(games.filter((g) => g.end === 0))} second ${pct(games.filter((g) => g.end === 1))} draw ${pct(games.filter((g) => g.end === 'draw'))}`
    + ` | ${avg((g) => g.turns)} turns to a goal, over by turn 20: ${pct(won.filter((g) => g.turns <= 20))}`
    + ` | goals after a pass: ${pct(won.filter((g) => g.kicks >= 2), won)} | scored by: ${kickers}`);
}
