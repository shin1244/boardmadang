// 작은 게임의 완전 탐색. 시작 판에서 갈 수 있는 모든 판의 승패를 정확히 구합니다.
// 틱택토처럼 판 수가 상한 아래인 게임은 학습 대신 이걸로 확정 결론을 내고, 학습한 AI가 완벽한지 채점할 때도 씁니다.
//
// 가치는 선공 기준입니다 (+1 = 선공 승, 0 = 무승부, −1 = 후공 승). 판의 열쇠는 상태 JSON과 상태를 바꾼 행동 수입니다
// (maxActions 무승부 때문에 같은 상태라도 몇 수째인지에 따라 결과가 다를 수 있음).

const absolute = (winner) => (winner === null ? 0 : winner === 0 ? 1 : -1);

class TooBig extends Error {}

export const keyOf = (pos) => `${pos.effective}|${JSON.stringify(pos.state)}`;

/**
 * @typedef {{ pos: object, value: number, toPlay: 0 | 1 | null, moves: number, best: number[] }} Solved
 *   best는 둘 차례인 쪽에게 가장 좋은 행동들, moves는 둘 수 있는 행동 수 (끝난 판은 null, 0, [])
 * @returns {{ value: number, table: Map<string, Solved> } | null} 판 수가 limit을 넘으면 null
 */
export function solve(env, start, { limit = 200_000 } = {}) {
  const table = new Map();
  const visit = (pos) => {
    const key = keyOf(pos);
    const known = table.get(key);
    if (known) return known.value;
    if (table.size >= limit) throw new TooBig();
    const moves = env.children(pos);
    const outcome = env.outcome(pos, moves);
    if (outcome) {
      const value = absolute(outcome.winner);
      table.set(key, { pos, value, toPlay: null, moves: 0, best: [] });
      return value;
    }
    const toPlay = env.toPlay(pos);
    const sign = toPlay === 0 ? 1 : -1;
    let bestValue = -Infinity;
    let best = [];
    for (const m of moves) {
      const v = sign * visit(m.pos);
      if (v > bestValue) {
        bestValue = v;
        best = [m.action];
      } else if (v === bestValue) best.push(m.action);
    }
    const value = sign * bestValue;
    table.set(key, { pos, value, toPlay, moves: moves.length, best });
    return value;
  };
  try {
    return { value: visit(start), table };
  } catch (err) {
    if (err instanceof TooBig) return null;
    throw err;
  }
}
