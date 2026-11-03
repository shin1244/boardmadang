"""보드마당 AlphaZero 학습 (docs/architecture.md의 "AI 학습", trainer/README.md).

    python trainer/train.py games/tictactoe --minutes 5

자기대국 → (국면, 탐색이 고른 수의 분포, 최종 승패)를 모음 → 신경망 학습 → 새 신경망으로 다시 자기대국.
게임 코드와 MCTS는 Node 워커(selfplay.js) 여러 개에서 돌고, 이 프로세스는 신경망 계산과 학습만 합니다.
학습은 "강해질 때까지"가 아니라 정해진 시간(--minutes)만큼만 돌립니다 (예산제, docs/abuse-and-limits.md).

결과는 trainer/runs/<게임 id>/에 남습니다.
    model.pt    마지막 신경망과 설정
    log.jsonl   반복마다 자기대국 통계, 손실(학습 중, 새 판), 평가
"""

import argparse
import json
import os
import queue
import struct
import subprocess
import threading
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from net import Net

HERE = Path(__file__).resolve().parent
OUTCOME = {1: "first player wins", 0: "draw", -1: "second player wins"}


class Worker:
    """selfplay.js 하나. 메시지 형식은 selfplay.js 맨 위에 있습니다."""

    def __init__(self, game_dir):
        self.proc = subprocess.Popen(
            ["node", str(HERE / "selfplay.js"), str(game_dir)], stdin=subprocess.PIPE, stdout=subprocess.PIPE
        )
        kind, self.info, _ = self.read()
        if kind != "H":
            raise RuntimeError(f"selfplay worker sent {kind!r} first")

    def write(self, kind, obj=None, data=b""):
        j = json.dumps(obj or {}).encode()
        self.proc.stdin.write(struct.pack("<IBI", 5 + len(j) + len(data), ord(kind), len(j)) + j + data)
        self.proc.stdin.flush()

    def exact(self, n):
        b = self.proc.stdout.read(n)
        if len(b) < n:
            raise RuntimeError("selfplay worker stopped (see the error above)")
        return b

    def read(self):
        length, kind, jlen = struct.unpack("<IBI", self.exact(9))
        body = self.exact(length - 5)
        return chr(kind), json.loads(body[:jlen] or b"{}"), body[jlen:]

    def run(self, cmd, infer=None, on_game=None):
        """명령 하나를 보내고 끝날 때까지 신경망 계산 부탁에 답합니다. 끝나면 통계를 돌려줍니다"""
        self.write("C", cmd)
        while True:
            kind, obj, data = self.read()
            if kind == "E":
                x = np.frombuffer(data, dtype=np.float32).copy()
                logits, values = infer(x.reshape(obj["n"], self.info["channels"], self.info["rows"], self.info["cols"]))
                self.write("R", data=np.concatenate([logits.ravel(), values.ravel()]).astype(np.float32).tobytes())
            elif kind == "G":
                on_game(obj, data)
            elif kind == "D":
                if "error" in obj:
                    raise RuntimeError(obj["error"])
                return obj

    def close(self):
        try:
            self.write("C", {"cmd": "quit"})
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


class Pool:
    """자기대국 워커 여러 개. 워커마다 스레드 하나가 메시지를 주고받고,
    신경망 계산 부탁은 모든 워커 것을 모아 이 스레드에서 한 번에 계산합니다 (워커가 많을수록 묶음이 커짐)."""

    def __init__(self, game_dir, n, wait=0.005):
        self.workers = [Worker(game_dir) for _ in range(max(1, n))]
        self.info = self.workers[0].info
        self.wait = wait

    def run(self, jobs, infer=None, on_game=None):
        """jobs는 [(워커 번호, 명령)]. 모두 끝나면 결과를 같은 순서로 돌려줍니다"""
        requests = queue.Queue()
        results = [None] * len(jobs)
        errors = []

        def ask(x):
            slot = {"x": x, "done": threading.Event()}
            requests.put(slot)
            slot["done"].wait()
            if "error" in slot:
                raise slot["error"]
            return slot["out"]

        def lane(k, w, cmd):
            try:
                results[k] = self.workers[w].run(cmd, ask, on_game)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=lane, args=(k, w, cmd), daemon=True) for k, (w, cmd) in enumerate(jobs)]

        def serve():
            while any(t.is_alive() for t in threads):
                try:
                    batch = [requests.get(timeout=0.01)]
                except queue.Empty:
                    continue
                # 신경망은 한 번 부를 때 드는 시간이 커서, 다른 워커의 부탁도 잠깐(최대 wait초) 기다려 같이 계산합니다
                deadline = time.monotonic() + self.wait
                while len(batch) < sum(t.is_alive() for t in threads):
                    try:
                        batch.append(requests.get(timeout=max(0, deadline - time.monotonic())))
                    except queue.Empty:
                        break
                try:
                    logits, values = infer(np.concatenate([b["x"] for b in batch]))
                    at = 0
                    for b in batch:
                        n = len(b["x"])
                        b["out"] = (logits[at : at + n], values[at : at + n])
                        at += n
                except Exception as e:
                    for b in batch:
                        b["error"] = e
                for b in batch:
                    b["done"].set()

        for t in threads:
            t.start()
        serve()
        if errors:
            raise errors[0]
        return results

    def one(self, cmd, infer=None):
        """첫 워커에서만 돌립니다 (완전 탐색처럼 나눌 수 없는 명령)"""
        return self.run([(0, cmd)], infer)[0]

    def split(self, cmd, infer, on_game=None):
        """판 수(games)를 워커마다 나눠 돌리고 결과를 합칩니다. 시드는 판이 겹치지 않게 워커마다 밉니다"""
        n = len(self.workers)
        jobs = []
        start = 0
        for w in range(n):
            g = cmd["games"] // n + (w < cmd["games"] % n)
            if g or w == 0:  # 0판이어도 결과 모양은 있어야 합니다
                jobs.append((w, {**cmd, "games": g, "seed": cmd.get("seed", 1) + start}))
            start += g
        return merge(self.run(jobs, infer, on_game))

    def close(self):
        for w in self.workers:
            w.close()


def merge(results):
    """워커마다 나눠 돈 selfplay·match 결과를 합칩니다"""
    out = dict(results[0])
    for r in results[1:]:
        for k in ("games", "draws", "cut", "moves"):
            if k in r:
                out[k] += r[k]
        for k in ("wins", "first", "second"):
            if k in r:
                out[k] = [a + b for a, b in zip(out[k], r[k])]
        if "lost" in r:
            out["lost"] = (out["lost"] + r["lost"])[:5]
    return out


def make_infer(net, device):
    @torch.no_grad()
    def infer(x):
        net.eval()
        logits, v = net(torch.from_numpy(x).to(device))
        return logits.float().cpu().numpy(), v.float().cpu().numpy()

    return infer


def unpack_game(info, obj, data):
    """G 메시지 → (국면, 탐색 분포, 가치 정답)"""
    m = obj["positions"]
    size = info["channels"] * info["rows"] * info["cols"]
    a = info["nActions"]
    arr = np.frombuffer(data, dtype=np.float32)
    planes = arr[: m * size].reshape(m, info["channels"], info["rows"], info["cols"])
    pi = arr[m * size : m * size + m * a].reshape(m, a)
    z = arr[m * size + m * a :]
    return planes, pi, z


def train(net, opt, buffer, steps, batch, device, rng):
    planes = np.concatenate([b[0] for b in buffer])
    pis = np.concatenate([b[1] for b in buffer])
    zs = np.concatenate([b[2] for b in buffer])
    if len(zs) < 2:
        return None
    net.train()
    total = np.zeros(2)
    for _ in range(steps):
        idx = rng.integers(0, len(zs), size=min(batch, len(zs)))
        x = torch.from_numpy(planes[idx]).to(device)
        pi = torch.from_numpy(pis[idx]).to(device)
        z = torch.from_numpy(zs[idx]).to(device)
        logits, v = net(x)
        lp = -(pi * F.log_softmax(logits, 1)).sum(1).mean()
        lv = F.mse_loss(v, z)
        opt.zero_grad()
        (lp + lv).backward()
        opt.step()
        total += [lp.item(), lv.item()]
    return {"policy": total[0] / steps, "value": total[1] / steps}


@torch.no_grad()
def fresh_loss(net, data, device, batch=4096):
    """아직 학습에 안 쓴 새 판에서 잰 손실. 학습 손실보다 한참 높으면 일반 규칙 대신 판을 외우고 있는 것입니다.
    zero는 가치를 늘 0이라고 답할 때의 손실이라, 가치 손실이 이보다 낮아야 승패를 조금이라도 맞히는 것입니다"""
    planes, pis, zs = data
    if len(zs) == 0:
        return None
    net.eval()
    lp = lv = 0.0
    for i in range(0, len(zs), batch):
        x = torch.from_numpy(planes[i : i + batch]).to(device)
        pi = torch.from_numpy(pis[i : i + batch]).to(device)
        z = torch.from_numpy(zs[i : i + batch]).to(device)
        logits, v = net(x)
        lp += -(pi * F.log_softmax(logits.float(), 1)).sum().item()
        lv += ((v.float() - z) ** 2).sum().item()
    return {"policy": lp / len(zs), "value": lv / len(zs), "zero": float((zs**2).mean())}


def wdl(r):
    return "/".join(str(x) for x in r)


def grade(g):
    """가장 좋은 수를 고른 비율과, 틀린 수 중 이길 판을 놓친 것과 지는 수를 둔 것"""
    if not g:
        return "-"
    return f"{g['rate']:.1%} (missed wins {g['missedWins']}, blunders {g['blunders']})"


def evaluate(pool, infer, args, solvable, rollout=False):
    """아무 수나 두는 상대와 둡니다. 완전 탐색이 되면 완벽한 상대와, rollout이면 학습 없는 롤아웃 AI와도 둡니다"""

    def match(opponent):
        cmd = {
            "cmd": "match",
            "opponent": opponent,
            "oppSims": args.rollout_sims,
            "games": args.eval_games,
            "sims": args.sims,
            "maxMoves": args.max_moves,
            "seed": 1,
        }
        return pool.split(cmd, infer)

    def wdl_line(name, r):
        cut = f"  (cut {r['cut']})" if r["cut"] else ""
        return f"  vs {name:<8}first W/D/L {wdl(r['first'])}  second {wdl(r['second'])}{cut}"

    res = {"random": match("random")}
    line = wdl_line("random", res["random"])
    if solvable:
        res["perfect"] = match("perfect")
        res["accuracy"] = pool.one({"cmd": "accuracy", "sims": args.sims}, infer)
        acc = res["accuracy"]
        line += "\n" + wdl_line("perfect", res["perfect"])
        line += (
            f"\n  best move ({acc['positions']} positions)"
            f"\n    policy {grade(acc['policy'])}"
            f"\n    search {grade(acc['search'])}"
        )
    if rollout and args.rollout_sims:
        res["rollout"] = match("rollout")
        line += "\n" + wdl_line("rollout", res["rollout"]) + f"  (rollout AI {args.rollout_sims} sims)"
    for name in ("random", "perfect", "rollout"):
        for g in res.get(name, {}).get("lost", []):
            seat = "first" if g["ai"] == 0 else "second"
            line += f"\n  lost to {name} as {seat}: actions {' '.join(map(str, g['actions']))}"
    print(line, flush=True)
    return res


def main():
    ap = argparse.ArgumentParser(description="Train an AlphaZero AI for a boardmadang game.")
    ap.add_argument("game", help="game folder with index.js (and listing.json)")
    ap.add_argument("--minutes", type=float, default=10, help="training budget (default 10)")
    ap.add_argument("--iterations", type=int, default=1000, help="stop after this many iterations")
    ap.add_argument("--games", type=int, default=100, help="self-play games per iteration")
    ap.add_argument("--sims", type=int, default=50, help="MCTS simulations per move")
    ap.add_argument("--parallel", type=int, default=64, help="games played at once in each worker")
    ap.add_argument(
        "--workers", type=int, default=os.cpu_count() or 1, help="self-play worker processes (default: CPU threads)"
    )
    ap.add_argument(
        "--temp-moves", type=int, default=None, help="self-play samples the first N moves (default: board cells, up to 30)"
    )
    ap.add_argument(
        "--max-moves", type=int, default=512, help="end a training game as a draw after this many moves (default 512)"
    )
    ap.add_argument("--solve-limit", type=int, default=50_000, help="solve exactly if the game has fewer positions")
    ap.add_argument("--blocks", type=int, default=4)
    ap.add_argument("--filters", type=int, default=64)
    ap.add_argument("--steps", type=int, default=100, help="training steps per iteration")
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--window", type=int, default=20, help="train on the last N iterations of self-play")
    ap.add_argument("--eval-every", type=int, default=5)
    ap.add_argument("--eval-games", type=int, default=40)
    ap.add_argument(
        "--rollout-sims", type=int, default=200, help="the final evaluation also plays an untrained rollout AI (0 = skip)"
    )
    ap.add_argument(
        "--warmup-minutes",
        type=float,
        default=0,
        help="for the first N minutes, self-play with the untrained rollout AI instead of the network (default 0)",
    )
    ap.add_argument("--warmup-sims", type=int, default=50, help="rollout AI simulations per move during warm-up")
    ap.add_argument(
        "--search",
        choices=["puct", "gumbel"],
        default="puct",
        help="self-play search: AlphaZero's PUCT, or Gumbel AlphaZero that learns with fewer simulations",
    )
    ap.add_argument(
        "--value-mix",
        type=float,
        default=0,
        help="mix this much of the search's value into the value target (0 = game result only)",
    )
    ap.add_argument("--out", default=None, help="output folder (default trainer/runs/<game id>)")
    ap.add_argument("--resume", action="store_true", help="continue from model.pt in the output folder")
    ap.add_argument("--eval-only", action="store_true", help="only evaluate model.pt in the output folder")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    t0 = time.monotonic()
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    pool = Pool(args.game, args.workers)
    info = pool.info
    out = Path(args.out) if args.out else HERE / "runs" / info["id"]
    out.mkdir(parents=True, exist_ok=True)
    # 자기대국에서 처음 몇 수는 방문 수에 비례해 뽑아 여러 판을 둬 봅니다. AlphaZero는 30수였고,
    # 작은 판은 한 판 전체를 뽑는 쪽이 낫습니다 (틱택토에서 3수만 뽑을 때보다 상대가 이상하게 둔 뒤의 판을 더 잘 배움)
    temp_moves = args.temp_moves if args.temp_moves is not None else min(30, info["rows"] * info["cols"])
    print(
        f"{info['id']}: {info['rows']}x{info['cols']} board, {info['nActions']} actions, "
        f"{info['channels']} input channels, lang {info['lang']}, device {args.device}, {len(pool.workers)} workers, "
        f"{args.search} search",
        flush=True,
    )

    solved = pool.one({"cmd": "solve", "limit": args.solve_limit})
    solvable = not solved.get("tooBig")
    if solvable:
        print(f"solved exactly ({solved['positions']} positions): {OUTCOME[solved['value']]} with perfect play")
    else:
        print("too big to solve exactly, so only the random opponent is used for evaluation")

    net = Net(info["channels"], len(info["specials"]), args.blocks, args.filters).to(args.device)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr, weight_decay=1e-4)
    first = 1
    if args.eval_only and not (out / "model.pt").exists():
        pool.close()
        raise SystemExit(f"no model to evaluate: {out / 'model.pt'}")
    if (args.resume or args.eval_only) and (out / "model.pt").exists():
        saved = torch.load(out / "model.pt", map_location=args.device)
        net = Net(**saved["config"]).to(args.device)
        net.load_state_dict(saved["state"])
        opt = torch.optim.Adam(net.parameters(), lr=args.lr, weight_decay=1e-4)
        first = saved["iteration"] + 1
        print(f"loaded iteration {saved['iteration']}")
    infer = make_infer(net, args.device)
    if args.eval_only:
        try:
            evaluate(pool, infer, args, solvable, rollout=True)
        finally:
            pool.close()
        return

    buffer = []
    log = open(out / "log.jsonl", "a", encoding="utf-8")
    last = first - 1  # 마지막으로 끝낸 반복
    evaluated = None
    try:
        for it in range(first, first + args.iterations):
            if time.monotonic() - t0 > args.minutes * 60:
                break
            games = []
            # 처음 몇 분은 학습 없는 롤아웃 AI끼리 둔 판으로 가르칩니다. 무작위 신경망끼리 둔 판보다 배울 게 많습니다
            warmup = time.monotonic() - t0 < args.warmup_minutes * 60
            cmd = {
                "cmd": "selfplay",
                "games": args.games,
                "parallel": args.parallel,
                "sims": args.warmup_sims if warmup else args.sims,
                "tempMoves": temp_moves,
                "maxMoves": args.max_moves,
                "noise": {"eps": 0.25},
                "seed": args.seed * 1_000_000 + it * args.games,
                "teacher": "rollout" if warmup else None,
                "method": args.search,
                "valueMix": args.value_mix,
            }
            stats = pool.split(cmd, infer, on_game=lambda obj, data: games.append(unpack_game(info, obj, data)))
            new = tuple(np.concatenate([g[k] for g in games]) for k in range(3))
            fresh = fresh_loss(net, new, args.device)  # 버퍼에 넣기 전에 잽니다
            buffer.append(new)
            buffer = buffer[-args.window :]
            loss = train(net, opt, buffer, args.steps, args.batch, args.device, rng)
            n = sum(len(b[2]) for b in buffer)
            print(
                f"iter {it:3d}  first/second/draw {stats['wins'][0]}/{stats['wins'][1]}/{stats['draws']}"
                + (f" (cut {stats['cut']})" if stats["cut"] else "")
                + f"  moves {stats['moves'] / args.games:.1f}  loss p {loss['policy']:.3f} v {loss['value']:.3f}"
                + (
                    f"  new games p {fresh['policy']:.3f} v {fresh['value']:.3f} (always 0: {fresh['zero']:.3f})"
                    if fresh
                    else ""
                )
                + f"  buffer {n}  {time.monotonic() - t0:.0f}s"
                + ("  (rollout AI)" if warmup else ""),
                flush=True,
            )
            entry = {
                "iteration": it,
                "selfplay": stats,
                "loss": loss,
                "fresh": fresh,
                "buffer": n,
                "seconds": time.monotonic() - t0,
            }
            if warmup:
                entry["teacher"] = "rollout"
            evaluated = None
            if it % args.eval_every == 0:
                evaluated = entry["eval"] = evaluate(pool, infer, args, solvable)
            log.write(json.dumps(entry) + "\n")
            log.flush()
            torch.save({"config": net.config, "state": net.state_dict(), "iteration": it, "info": info}, out / "model.pt")
            last = it
        # 마지막 평가는 롤아웃 AI와도 둡니다 (학습 없이 공짜로 만드는 AI보다 나아졌는지)
        if last >= first and (evaluated is None or args.rollout_sims):
            print("final evaluation")
            log.write(json.dumps({"iteration": last, "eval": evaluate(pool, infer, args, solvable, rollout=True)}) + "\n")
    finally:
        log.close()
        pool.close()
    print(f"done in {time.monotonic() - t0:.0f}s: {out / 'model.pt'}")


if __name__ == "__main__":
    main()
