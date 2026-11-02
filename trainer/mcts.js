// AlphaZero의 탐색 (PUCT MCTS). 신경망이 준 사전 확률(어디에 둘지)과 가치(누가 유리한지)로 수를 미리 둬 봅니다.
//
// 값은 모두 선공 기준으로 쌓습니다 (+1 = 선공 승). 선택 → 이동처럼 같은 플레이어가 연달아 둘 수 있어서
// "한 수마다 부호를 뒤집는" 대신 노드마다 둘 차례인 플레이어 쪽에서 봅니다.
//
// evaluate(pos, actions)는 { policy: actions 순서의 확률, value: 둘 차례인 쪽 기준 −1~1 }을 돌려주는 async 함수입니다.
// 자기대국은 여러 판의 요청을 모아 신경망에 한 번에 넣고(selfplay.js), 나중에 브라우저 AI도 이 파일을 그대로 씁니다.

export class Node {
  constructor(pos, prior = 1, action = -1) {
    this.pos = pos; // 판. legal()을 믿고 펼친 자식은 처음 방문할 때 둬 봅니다 (그전엔 null)
    this.prior = prior;
    this.action = action; // 부모에서 이 노드로 온 행동
    this.n = 0;
    this.w = 0; // 선공 기준 가치의 합
    this.children = null; // 펼치면 Node[]
    this.toPlay = null;
    this.outcome = undefined; // 펼치면 끝난 판은 { winner }, 진행 중이면 null
    this.value = 0; // 펼칠 때 받은 선공 기준 가치 (신경망이나 결과). Gumbel 탐색이 씁니다
  }

  /** 선공 기준 평균 가치 */
  get q() {
    return this.n ? this.w / this.n : 0;
  }
}

const absolute = (winner) => (winner === null ? 0 : winner === 0 ? 1 : -1);

/** 노드를 펼치고 선공 기준 가치를 돌려줍니다. 끝난 판이면 결과, 아니면 신경망의 가치입니다 */
async function expand(env, node, evaluate) {
  const moves = env.expandable(node.pos);
  node.outcome = env.outcome(node.pos, moves);
  if (node.outcome) {
    node.children = [];
    node.value = absolute(node.outcome.winner);
    return node.value;
  }
  node.toPlay = env.toPlay(node.pos);
  const { policy, value } = await evaluate(node.pos, moves.map((m) => m.action));
  node.children = moves.map((m, k) => new Node(m.pos ?? null, policy[k], m.action));
  node.value = node.toPlay === 0 ? value : -value;
  return node.value;
}

/**
 * 아직 안 둬 본 자식의 판을 둬 봅니다. legal()에 있었지만 실제로는 무시되는 행동이면 그 자식을 지우고 false.
 * 자식이 하나도 안 남으면 부모는 둘 수 없는 판(무승부)이 됩니다.
 */
function reach(env, parent, child) {
  if (child.pos) return true;
  child.pos = env.apply(parent.pos, parent.toPlay, child.action);
  if (child.pos) return true;
  parent.children = parent.children.filter((c) => c !== child);
  if (!parent.children.length) parent.outcome = { winner: null };
  return false;
}

function select(node, cPuct) {
  const sign = node.toPlay === 0 ? 1 : -1;
  const sq = Math.sqrt(node.n);
  let best = null;
  let bestScore = -Infinity;
  for (const c of node.children) {
    const score = (c.n ? sign * c.q : 0) + (cPuct * c.prior * sq) / (1 + c.n);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** 감마 분포 (Marsaglia–Tsang). 디리클레 잡음에 씁니다 */
function gamma(alpha, random) {
  if (alpha < 1) return gamma(alpha + 1, random) * random() ** (1 / alpha);
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      // 표준 정규분포 (Box–Muller)
      x = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** 뿌리의 사전 확률에 디리클레 잡음을 섞어 자기대국이 여러 수를 둬 보게 합니다 */
function addNoise(root, { alpha, eps }, random) {
  const k = root.children.length;
  if (k < 2) return;
  const a = alpha ?? Math.min(1, 10 / k);
  const g = root.children.map(() => gamma(a, random));
  const sum = g.reduce((x, y) => x + y, 0) || 1;
  root.children.forEach((c, i) => {
    c.prior = (1 - eps) * c.prior + (eps * g[i]) / sum;
  });
}

/**
 * 신경망 없이 쓰는 evaluate (롤아웃). 사전 확률은 고르게 주고, 가치는 그 판에서 아무 수나 끝까지 둬 본 결과입니다.
 * 학습하지 않은 AI이고, 학습한 AI가 그보다 나은지 재는 기준 상대로도 씁니다. cap번 둬도 안 끝나면 무승부로 봅니다.
 */
export function rolloutEvaluator(env, random = Math.random, cap = 300) {
  const randomMove = (pos) => {
    const player = env.toPlay(pos);
    if (player === null) return null;
    const actions = env.candidates(pos, player);
    while (actions.length) {
      const k = Math.floor(random() * actions.length);
      const next = env.apply(pos, player, actions[k]);
      if (next) return next;
      actions.splice(k, 1);
    }
    return null;
  };
  return async (pos, actions) => {
    const me = env.toPlay(pos);
    let winner = null;
    for (let p = pos, i = 0; p && i < cap; i++, p = randomMove(p)) {
      const out = env.outcome(p);
      if (out) {
        winner = out.winner;
        break;
      }
    }
    return { policy: actions.map(() => 1 / actions.length), value: winner === null ? 0 : winner === me ? 1 : -1 };
  };
}

/**
 * root에서 sims번 탐색합니다. root는 이전 탐색의 자식을 그대로 써도 됩니다 (트리 재사용).
 * @param {{ sims?: number, cPuct?: number, noise?: { alpha?: number, eps: number } | null, random?: () => number }} [opts]
 */
export async function search(env, root, evaluate, { sims = 50, cPuct = 1.5, noise = null, random = Math.random } = {}) {
  if (!root.children) {
    root.w += await expand(env, root, evaluate);
    root.n += 1;
  }
  if (root.outcome) return root;
  if (noise) addNoise(root, noise, random);
  for (let i = 0; i < sims; i++) {
    let node = root;
    const path = [root];
    while (node.children && !node.outcome) {
      const child = select(node, cPuct);
      if (!reach(env, node, child)) continue; // 무시되는 행동이었으면 지우고 다시 고릅니다
      node = child;
      path.push(node);
    }
    const v = node.children ? absolute(node.outcome.winner) : await expand(env, node, evaluate);
    for (const n of path) {
      n.n += 1;
      n.w += v;
    }
  }
  return root;
}

/** 방문 수 → 행동 분포 (학습의 정답). 길이 nActions */
export function visitPolicy(env, root) {
  const pi = new Float32Array(env.nActions);
  const total = root.children.reduce((s, c) => s + c.n, 0);
  for (const c of root.children) pi[c.action] = total ? c.n / total : 1 / root.children.length;
  return pi;
}

/**
 * 둘 자식을 고릅니다. temperature가 0이면 가장 많이 방문한 수(같으면 사전 확률이 큰 수),
 * 1이면 방문 수에 비례해서 뽑습니다. 둘 수 있는 자식이 없으면 null.
 */
export function pick(env, root, temperature, random = Math.random) {
  while (root.children.length) {
    const c = choose(root.children, temperature, random);
    if (reach(env, root, c)) return c;
  }
  return null;
}

function choose(kids, temperature, random) {
  if (temperature === 0 || kids.every((c) => c.n === 0)) {
    return kids.reduce((a, b) => (b.n > a.n || (b.n === a.n && b.prior > a.prior) ? b : a));
  }
  const total = kids.reduce((s, c) => s + c.n, 0);
  let r = random() * total;
  for (const c of kids) {
    r -= c.n;
    if (r < 0) return c;
  }
  return kids[kids.length - 1];
}

// ---- Gumbel AlphaZero (Danihelka 외, "Policy improvement by planning with Gumbel", 2022) ----
//
// 탐색 횟수가 적어도(16번 안팎) 학습이 되도록 뿌리에서 수를 고르는 방식을 바꿉니다.
//   뿌리   Gumbel 잡음 + 사전 확률로 후보 m개를 뽑고, 탐색을 나눠 주며 반씩 떨어뜨립니다 (sequential halving).
//          남은 수가 둘 수이고, 잡음이 탐험을 대신하므로 디리클레 잡음과 온도는 쓰지 않습니다.
//   그 아래 개선된 정책과 방문 수의 차이가 가장 큰 자식을 고릅니다 (결정적).
//   정답   방문 수 대신 개선된 정책 softmax(logit + σ(완성된 Q))를 배웁니다. 안 둬 본 수도 정답이 생깁니다.

const C_VISIT = 50;
const C_SCALE = 0.1;

/** 둘 차례인 쪽 기준 0~1 가치. q와 value는 선공 기준 −1~1입니다 */
const norm = (node, v) => ((node.toPlay === 0 ? v : -v) + 1) / 2;

/**
 * 자식마다 "완성된 Q"에 σ를 씌운 값. 방문한 자식은 평균 가치, 안 한 자식은 부모의 가치 추정(v_mix)을 씁니다.
 * σ(q) = (c_visit + 가장 많은 방문 수) × c_scale × q
 */
function sigmaQ(node) {
  const kids = node.children;
  let visits = 0;
  let mass = 0;
  let sum = 0;
  let most = 0;
  for (const c of kids) {
    if (!c.n) continue;
    visits += c.n;
    mass += c.prior;
    sum += c.prior * norm(node, c.q);
    most = Math.max(most, c.n);
  }
  const own = norm(node, node.value);
  const vmix = visits ? (own + (visits / (mass || 1)) * sum) / (1 + visits) : own;
  const scale = (C_VISIT + most) * C_SCALE;
  return kids.map((c) => scale * (c.n ? norm(node, c.q) : vmix));
}

const logit = (c) => Math.log(c.prior + 1e-12);

/** 개선된 정책: softmax(logit + σ(완성된 Q)). node.children 순서 */
function improvedPolicy(node) {
  const s = sigmaQ(node);
  const x = node.children.map((c, i) => logit(c) + s[i]);
  const top = Math.max(...x);
  const e = x.map((v) => Math.exp(v - top));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

/** 뿌리 아래에서 고를 자식: 개선된 정책에 비해 덜 방문한 자식 */
function selectGumbel(node) {
  const pi = improvedPolicy(node);
  const total = node.children.reduce((s, c) => s + c.n, 0);
  let best = 0;
  for (let i = 1; i < pi.length; i++) {
    if (pi[i] - node.children[i].n / (1 + total) > pi[best] - node.children[best].n / (1 + total)) best = i;
  }
  return node.children[best];
}

/** 뿌리의 자식 child에서 시작하는 탐색 한 번 */
async function simulate(env, root, child, evaluate) {
  const path = [root, child];
  let node = child;
  while (node.children && !node.outcome) {
    const next = selectGumbel(node);
    if (!reach(env, node, next)) continue;
    node = next;
    path.push(node);
  }
  const v = node.children ? absolute(node.outcome.winner) : await expand(env, node, evaluate);
  for (const n of path) {
    n.n += 1;
    n.w += v;
  }
}

/**
 * Gumbel 탐색. 둘 자식(chosen)과 학습의 정답(policy, 길이 nActions)을 돌려줍니다. 끝난 판이면 null.
 * random이 null이면 잡음 없이 가장 좋은 수를 고릅니다.
 * @param {{ sims?: number, m?: number, random?: (() => number) | null }} [opts]
 */
export async function gumbelSearch(env, root, evaluate, { sims = 16, m = 16, random = Math.random } = {}) {
  if (!root.children) {
    root.w += await expand(env, root, evaluate);
    root.n += 1;
  }
  if (root.outcome) return null;
  const gumbel = new Map(root.children.map((c) => {
    if (!random) return [c, 0];
    const u = Math.min(Math.max(random(), 1e-12), 1 - 1e-12);
    return [c, -Math.log(-Math.log(u))];
  }));
  const base = (c) => gumbel.get(c) + logit(c);
  const ranked = (kids) => {
    const q = sigmaQ(root);
    const s = new Map(root.children.map((c, i) => [c, q[i]]));
    return [...kids].sort((a, b) => base(b) + s.get(b) - (base(a) + s.get(a)));
  };

  // 후보 m개에 탐색을 나눠 주고, 한 바퀴마다 좋은 절반만 남깁니다
  let left = [...root.children].sort((a, b) => base(b) - base(a)).slice(0, Math.min(m, root.children.length));
  const rounds = Math.max(1, Math.ceil(Math.log2(left.length)));
  let used = 0;
  while (used < sims && left.length) {
    const each = Math.max(1, Math.floor(sims / (rounds * left.length)));
    for (const c of [...left]) {
      for (let j = 0; j < each && used < sims; j++) {
        if (!reach(env, root, c)) {
          left = left.filter((x) => x !== c); // 무시되는 행동이었습니다
          break;
        }
        await simulate(env, root, c, evaluate);
        used++;
      }
    }
    if (root.outcome) return null; // 둘 수 있는 수가 하나도 없었습니다
    if (left.length > 1) left = ranked(left).slice(0, Math.ceil(left.length / 2));
  }

  let chosen = null;
  while (!chosen && root.children.length) {
    const c = ranked(left.length ? left : root.children)[0];
    if (reach(env, root, c)) chosen = c;
    else left = left.filter((x) => x !== c);
  }
  if (!chosen) return null;
  const policy = new Float32Array(env.nActions);
  improvedPolicy(root).forEach((p, i) => {
    policy[root.children[i].action] = p;
  });
  return { chosen, policy };
}
