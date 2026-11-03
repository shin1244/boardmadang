// 작은 게임의 완전 탐색. 시작 판에서 갈 수 있는 모든 판의 승패를 정확히 구합니다.
// 틱택토처럼 판 수가 상한 아래인 게임은 학습 대신 이걸로 확정 결론을 내고, 학습한 AI가 완벽한지 채점할 때도 씁니다.
//
// 가치는 선공 기준입니다 (+1 = 선공 승, 0 = 무승부, −1 = 후공 승). 판의 열쇠는 상태 JSON과 둔 수, 이번 차례에 나온 판들입니다
// (maxActions 무승부 때문에 같은 상태라도 몇 수째인지에 따라, 차례 안에서 이미 나온 판으로는 못 돌아가므로
// 차례 중간이면 거쳐 온 판에 따라 결과가 다를 수 있음).

const absolute = (winner) => (winner === null ? 0 : winner === 0 ? 1 : -1);

class TooBig extends Error {}

export const keyOf = (pos) => `${pos.moves}|${[...pos.turnHashes].sort().join(',')}|${JSON.stringify(pos.state)}`;

/**
 * @typedef {{ pos: object, value: number, toPlay: 0 | 1 | null, moves: number, best: number[] }} Solved
 *   best는 둘 차례인 쪽에게 가장 좋은 행동들, moves는 둘 수 있는 행동 수 (끝난 판은 null, 0, [])
 * @returns {{ value: number, table: Map<string, Solved> } | null} 판 수가 limit을 넘으면 null
 */
export function solve(env, start, { limit = 200_000 } = {}) {
  const table = new Map();
  // 재귀 대신 스택을 직접 씁니다. 기물 고르기는 수를 늘리지 않아서 한 길이 maxActions보다 훨씬 깊어질 수 있습니다
  const stack = [];
  /** 처음 보는 판. 끝난 판은 바로 표에 넣고, 아니면 스택에 올려 자식을 차례로 봅니다 */
  const enter = (pos, key) => {
    if (table.size + stack.length >= limit) throw new TooBig();
    const moves = env.children(pos);
    const outcome = env.outcome(pos, moves);
    if (outcome) {
      table.set(key, { pos, value: absolute(outcome.winner), toPlay: null, moves: 0, best: [] });
      return;
    }
    const toPlay = env.toPlay(pos);
    stack.push({ pos, key, moves, toPlay, sign: toPlay === 0 ? 1 : -1, next: 0, bestValue: -Infinity, best: [] });
  };
  try {
    const startKey = keyOf(start);
    enter(start, startKey);
    while (stack.length) {
      const f = stack.at(-1);
      if (f.next === f.moves.length) {
        stack.pop();
        table.set(f.key, { pos: f.pos, value: f.sign * f.bestValue, toPlay: f.toPlay, moves: f.moves.length, best: f.best });
        continue;
      }
      const m = f.moves[f.next];
      const key = keyOf(m.pos);
      const known = table.get(key);
      // 모르는 판이면 먼저 풀고, 다 풀리면 이 자리로 돌아와 셉니다
      if (!known) {
        enter(m.pos, key);
        continue;
      }
      f.next++;
      const v = f.sign * known.value;
      if (v > f.bestValue) {
        f.bestValue = v;
        f.best = [m.action];
      } else if (v === f.bestValue) f.best.push(m.action);
    }
    return { value: table.get(startKey).value, table };
  } catch (err) {
    if (err instanceof TooBig) return null;
    throw err;
  }
}
