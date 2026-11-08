"""보드마당 AlphaZero 학습 (docs/architecture.md의 "AI 학습", trainer/README.md).

    python trainer/train.py games/tictactoe --minutes 5

자기대국 → (국면, 탐색이 고른 수의 분포, 최종 승패)를 모음 → 신경망 학습 → 새 신경망으로 다시 자기대국.
게임 코드와 MCTS는 Node 워커(selfplay.js) 여러 개에서 돌고, 이 프로세스는 신경망 계산과 학습만 합니다.
학습은 "강해질 때까지"가 아니라 정해진 시간(--minutes)만큼만 돌립니다 (예산제, docs/abuse-and-limits.md).

결과는 trainer/runs/<게임 id>/에 남습니다.
    model.pt        마지막 신경망과 설정
    log.jsonl       반복마다 자기대국 통계, 손실(학습 중, 새 판), 평가
    snapshots.json  학습 기록: 학습 전과 몇 분마다(--snapshot-every) 그때의 AI끼리 둔 판과 자기대국 통계.
                    운영자 화면에서 모델과 같이 올리면 제작자가 판마다 다시보기로 봅니다 (server/internal/ai/training.go)

다른 모델에서 시작하기와 두 모델 비교하기 (trainer/README.md의 "이어 학습", "모델 대 모델")
    python trainer/train.py games/tictactoe --init-from trainer/runs/old/model.pt --out trainer/runs/new
    python trainer/train.py games/tictactoe --versus trainer/runs/old/model.pt trainer/runs/new/model.pt

브라우저에서 AI와 두려면 학습한 신경망을 ONNX로 내보내 사이트에 올립니다 (trainer/README.md의 "브라우저에서 AI와 두기").
    python trainer/train.py games/tictactoe --export-onnx
    model.onnx  신경망 (입력 x [n, 채널, rows, cols] → logits [n, 행동 수], value [n])
    model.json  관측 채널 이름, 행동 수, 학습한 코드 버전, 브라우저 AI의 탐색 횟수
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
                x = x.reshape(obj["n"], self.info["channels"], self.info["rows"], self.info["cols"])
                # net은 몇 번째 신경망으로 계산할지입니다 (모델 대 모델 대국). 없으면 첫 번째
                net = obj.get("net", 0)
                logits, values = infer(x, net) if net else infer(x)
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
        """jobs는 [(워커 번호, 명령)]. 모두 끝나면 결과를 같은 순서로 돌려줍니다.
        infer는 신경망 계산 함수 하나, 또는 여러 개의 목록입니다 (모델 대 모델 대국. 워커가 몇 번째인지 알려 줌)"""
        nets = list(infer) if isinstance(infer, (list, tuple)) else [infer]
        requests = queue.Queue()
        results = [None] * len(jobs)
        errors = []

        def ask(x, net=0):
            slot = {"x": x, "net": net, "done": threading.Event()}
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
                groups = {}
                for b in batch:
                    groups.setdefault(b["net"], []).append(b)
                for k, group in groups.items():
                    try:
                        logits, values = nets[k](np.concatenate([b["x"] for b in group]))
                        at = 0
                        for b in group:
                            n = len(b["x"])
                            b["out"] = (logits[at : at + n], values[at : at + n])
                            at += n
                    except Exception as e:
                        for b in group:
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

    def split(self, cmd, infer, on_game=None, unit=1):
        """판 수(games)를 워커마다 나눠 돌리고 결과를 합칩니다. 시드는 판이 겹치지 않게 워커마다 밉니다.
        unit판씩 묶어서 나눕니다 (모델 대 모델의 한 쌍이 두 워커로 갈라지지 않게)"""
        n = len(self.workers)
        jobs = []
        start = 0
        units = cmd["games"] // unit
        for w in range(n):
            g = (units // n + (w < units % n)) * unit
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
        for k in ("games", "draws", "cut", "moves", "positions"):
            if k in r:
                out[k] += r[k]
        for k in ("wins", "first", "second"):
            if k in r:
                out[k] = [a + b for a, b in zip(out[k], r[k])]
        if "lost" in r:
            out["lost"] = (out["lost"] + r["lost"])[:5]
        if "hashes" in r:
            out["hashes"] = out.get("hashes", []) + r["hashes"]
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


def train(net, opt, buffer, steps, batch, device, rng, value_weight=1.0):
    """buffer의 항목은 (국면, 탐색 분포, 가치 정답) 또는 끝에 가치를 배울 국면 표시(0/1)가 붙은 넷입니다"""
    planes = np.concatenate([b[0] for b in buffer])
    pis = np.concatenate([b[1] for b in buffer])
    zs = np.concatenate([b[2] for b in buffer])
    keep = np.concatenate([b[3] for b in buffer]) if len(buffer[0]) > 3 else None
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
        if keep is None:
            lv = F.mse_loss(v, z)
        else:
            k = torch.from_numpy(keep[idx]).to(device)
            lv = ((v - z) ** 2 * k).sum() / k.sum().clamp(min=1)
        opt.zero_grad()
        (lp + value_weight * lv).backward()
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


# 브라우저 AI가 같은 모델을 쓸 수 있는 게임 코드인지 볼 때 맞춰 보는 칸. 코드 버전이 달라도 이것이 같으면 씁니다.
# 관측 채널(기물, 표시, observe() 채널 수)과 행동(판 크기, 특수 행동)이 같으면 신경망의 입력과 출력 모양이 같습니다.
# web/ai.js의 SHAPE와 같아야 합니다
SHAPE = ("rows", "cols", "channelNames", "specials", "nActions")
MODEL_FORMAT = 1
# model.json의 balance는 학습의 마지막 이만큼(반복 수 기준)에서 AI끼리 둔 자기대국의 결과입니다
BALANCE_SHARE = 0.2


def same_shape(a, b):
    return all(a.get(k) == b.get(k) for k in SHAPE)


def load_net(saved, device="cpu"):
    """torch.load한 model.pt → 평가 모드의 신경망"""
    net = Net(**saved["config"]).to(device)
    net.load_state_dict(saved["state"])
    return net.eval()


def init_from(net, saved, info):
    """다른 model.pt(같은 게임의 옛 버전, 비슷한 게임)의 가중치로 net을 시작합니다. 처음부터 배우는 것보다 빨리 배우려는 것입니다.

    모양이 같은 층은 그대로 옮깁니다. 첫 층의 입력 채널과 특수 행동 점수는 이름으로 맞춰 옮깁니다:
    관측 채널은 게임마다 기물 이름(piece:…)과 observe() 채널 수가 달라 자리가 밀리지만, 표시·칠한 칸·두는 쪽 같은
    채널은 이름과 뜻이 모든 게임에서 같습니다 (env.js의 channelNames). 맞는 이름이 없는 채널과 층은 새로 시작합니다.
    옮긴 것을 {"copied": 층 수, "fresh": 새로 시작한 층 이름들, "channels": 이름으로 맞춘 채널 수, "of": 채널 수}로 돌려줍니다."""
    src = saved["state"]
    src_info = saved.get("info") or {}
    state = net.state_dict()
    out = {"copied": 0, "fresh": [], "channels": 0, "of": len(info["channelNames"])}
    # 이름으로 맞출 축: 첫 층은 입력 채널(1축), 특수 행동 점수는 행동(0축).
    # 첫 층의 마지막 입력 채널은 신경망이 붙이는 "판 안"(전부 1)이라 이름을 따로 붙입니다
    named = {
        "stem.0.weight": (1, "channelNames", ["onBoard"]),
        "special.weight": (0, "specials", []),
        "special.bias": (0, "specials", []),
    }

    for key, value in state.items():
        old = src.get(key)
        if old is None:
            out["fresh"].append(key)
            continue
        axis, field, extra = named.get(key, (None, None, None))
        if axis is not None and field in src_info and src_info[field] != info[field]:
            mine, theirs = [*info[field], *extra], [*src_info[field], *extra]
            rest = [s for i, s in enumerate(value.shape) if i != axis]
            if rest == [s for i, s in enumerate(old.shape) if i != axis]:
                new = value.clone()
                hits = 0
                for i, name in enumerate(mine):
                    if name in theirs:
                        new.select(axis, i).copy_(old.select(axis, theirs.index(name)))
                        hits += 1
                if key == "stem.0.weight":
                    out["channels"] = hits - len(extra)
                if hits > len(extra):
                    state[key] = new
                    out["copied"] += 1
                    continue
            out["fresh"].append(key)
            continue
        if old.shape != value.shape:
            out["fresh"].append(key)
            continue
        state[key] = old.clone()
        out["copied"] += 1
        if key == "stem.0.weight":
            out["channels"] = out["of"]
    net.load_state_dict(state)
    return out


def versus_summary(res):
    """모델 대 모델 결과 → 첫 모델(A) 기준 승·무·패, 점수(승 1, 무 0.5)와 95% 구간, Elo 차이, 서로 다른 판 수.
    구간은 판끼리 독립이라고 보고 셉니다. 같은 판이 되풀이되면(distinct가 games보다 한참 적으면) 실제보다 좁게 나옵니다"""
    w, d, l = (res["first"][k] + res["second"][k] for k in range(3))
    n = w + d + l
    s = (w + d / 2) / n
    se = ((w * (1 - s) ** 2 + d * (0.5 - s) ** 2 + l * s**2) / n / n) ** 0.5

    def elo(p):
        p = min(max(p, 1e-3), 1 - 1e-3)
        return -400 * np.log10(1 / p - 1)

    return {
        "wins": w,
        "draws": d,
        "losses": l,
        "games": n,
        "distinct": len(set(res["hashes"])) if "hashes" in res else None,
        "score": s,
        "low": max(0.0, s - 1.96 * se),
        "high": min(1.0, s + 1.96 * se),
        "elo": float(elo(s)),
        "eloLow": float(elo(s - 1.96 * se)),
        "eloHigh": float(elo(s + 1.96 * se)),
    }


def export_onnx(saved, info, out, play_sims):
    """model.pt → 브라우저 AI의 model.onnx, model.json.

    saved는 torch.load한 model.pt, info는 지금 게임 코드의 정보(selfplay.js의 H)입니다.
    학습한 뒤에 코드가 바뀌었어도 SHAPE가 같으면 내보냅니다. model.json의 version은 학습한 코드의 버전입니다
    (이 기능 전에 학습한 model.pt에는 없어서 null). 같은 폴더에 log.jsonl이 있으면 선공 승률(balance)도 넣습니다."""
    trained = saved.get("info") or info
    if not same_shape(trained, info):
        diff = [k for k in SHAPE if trained.get(k) != info.get(k)]
        raise SystemExit(f"the game code changed since training ({', '.join(diff)} differ), so this model cannot be used")
    net = Net(**saved["config"]).eval()
    net.load_state_dict(saved["state"])
    x = torch.zeros(2, info["channels"], info["rows"], info["cols"])
    out.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        net,
        (x,),
        str(out / "model.onnx"),
        dynamo=True,
        verbose=False,
        input_names=["x"],
        output_names=["logits", "value"],
        dynamic_shapes={"x": {0: torch.export.Dim("n")}},
        external_data=False,
    )
    meta = {
        "format": MODEL_FORMAT,
        "game": trained["id"],
        "version": trained.get("version"),
        "lang": trained["lang"],
        **{k: trained[k] for k in SHAPE},
        "channels": trained["channels"],
        "sims": play_sims,
        "iteration": saved.get("iteration"),
        "net": {"blocks": saved["config"]["blocks"], "filters": saved["config"]["filters"]},
    }
    balance = balance_from_log(out / "log.jsonl", saved.get("iteration"))
    if balance:
        meta["balance"] = balance
    (out / "model.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return meta


def balance_from_log(path, upto=None):
    """log.jsonl → 학습 마지막 BALANCE_SHARE(적어도 한 반복)의 자기대국 합계 (서버 internal/site의 AIBalance).

    게임 창이 선공·후공 승률로 보여 줍니다. 처음 몇 수를 뽑아 두는 학습용 대국이라 사람끼리 둘 때와 같지는 않지만,
    한쪽이 크게 유리한 게임은 드러납니다. 같은 폴더에서 다시 학습해 이어 쓴 기록이면 다시 시작한 반복부터 봅니다.
    upto(model.pt의 반복)보다 뒤의 기록과 롤아웃 AI가 둔 반복은 뺍니다. 기록이 없으면 None."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    rows = {}  # 반복 → 자기대국 통계
    last = 0
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        it, sp = e.get("iteration"), e.get("selfplay")
        if not isinstance(it, int) or not sp:
            continue
        if it <= last:  # 이 반복부터 다시 학습했습니다
            rows = {k: v for k, v in rows.items() if k < it}
        last = it
        if (upto is None or it <= upto) and "teacher" not in e:
            rows[it] = sp
    its = sorted(rows)[-max(1, round(len(rows) * BALANCE_SHARE)) :]
    total = {"games": 0, "wins": [0, 0], "draws": 0, "cut": 0}
    for i in its:
        sp = rows[i]
        total["games"] += sp["games"]
        total["wins"] = [total["wins"][0] + sp["wins"][0], total["wins"][1] + sp["wins"][1]]
        total["draws"] += sp["draws"]
        total["cut"] += sp.get("cut", 0)
    if not total["games"]:
        return None
    return {**total, "from": its[0], "to": its[-1]}


# snapshots.json의 format (server/internal/ai의 TrainingFormat)과 스냅샷 수 상한 (MaxSnapshots)
SNAPSHOT_FORMAT = 1
MAX_SNAPSHOTS = 40


def eval_summary(res):
    """평가 결과에서 학습 기록에 남길 것만 (서버 internal/ai의 Eval). 없으면 None"""
    if not res:
        return None
    out = {}
    for name in ("random", "perfect"):
        r = res.get(name)
        if r and "first" in r:
            out[name] = {"first": r["first"], "second": r["second"]}
    acc = res.get("accuracy") or {}
    if acc.get("policy") and acc.get("search"):
        out["accuracy"] = {"policy": acc["policy"]["rate"], "search": acc["search"]["rate"]}
    return out or None


class Snapshots:
    """학습 기록 (snapshots.json, 서버 internal/ai의 Training).

    학습 전과 --snapshot-every분마다 그때의 신경망으로 AI끼리 --snapshot-games판을 두고(selfplay.js의 showcase),
    앞 스냅샷부터 그때까지의 자기대국 통계와 마지막 평가를 같이 남깁니다. 제작자는 이것으로 학습이 되고 있는지,
    AI가 규칙의 허점이나 꼼수(한쪽만 이김, 같은 판 되풀이)를 찾았는지 봅니다. 찍을 때마다 파일을 새로 씁니다."""

    def __init__(self, path, info, args):
        self.path = path
        self.args = args
        self.data = {
            "format": SNAPSHOT_FORMAT,
            "game": info["id"],
            "version": info.get("version"),
            "lang": info["lang"],
            "minutes": args.minutes,
            "snapshots": [],
        }
        self.base = 0.0  # 이어서 학습하면(--resume) 앞 기록의 마지막 분부터 셉니다
        if args.resume and path.exists():
            try:
                old = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                old = {}
            if old.get("game") == info["id"] and old.get("snapshots"):
                self.data["snapshots"] = old["snapshots"]
                self.data["minutes"] = old.get("minutes", 0) + args.minutes
                self.base = old["snapshots"][-1]["minute"]
        self.since = None  # 앞 스냅샷부터의 자기대국 통계
        self.next = 0.0  # 다음에 찍을 때 (분)

    @property
    def empty(self):
        return not self.data["snapshots"]

    def add_selfplay(self, stats):
        s = self.since or {"games": 0, "wins": [0, 0], "draws": 0, "cut": 0, "moves": 0}
        s["games"] += stats["games"]
        s["wins"] = [s["wins"][0] + stats["wins"][0], s["wins"][1] + stats["wins"][1]]
        s["draws"] += stats["draws"]
        s["cut"] += stats["cut"]
        s["moves"] += stats["moves"]
        self.since = s

    def due(self, minute):
        return self.args.snapshot_every > 0 and minute >= self.next

    def take(self, pool, infer, minute, iteration, evaluated=None):
        if self.args.snapshot_every <= 0:
            return
        cmd = {
            "cmd": "showcase",
            "games": self.args.snapshot_games,
            "sims": self.args.sims,
            "maxMoves": self.args.max_moves,
            "seed": self.args.seed,
        }
        res = pool.one(cmd, infer)
        if "error" in res:
            print(f"snapshot failed: {res['error']}", flush=True)
            return
        snap = {
            "minute": round(self.base + minute, 1),
            "iteration": iteration,
            "selfplay": self.since,
            "games": res["games"],
        }
        ev = eval_summary(evaluated)
        if ev:
            snap["eval"] = ev
        snaps = self.data["snapshots"]
        snaps.append(snap)
        # 너무 많으면 학습 전 것은 두고 그다음 것부터 버립니다 (서버의 상한)
        while len(snaps) > MAX_SNAPSHOTS:
            del snaps[1]
        self.since = None
        while self.next <= minute:
            self.next += self.args.snapshot_every
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)
        results = ", ".join(
            f"{'draw' if g['winner'] is None else ('first' if g['winner'] == 0 else 'second') + ' wins'} in {len(g['moves'])}"
            + ("" if g["reason"] == "result" else f" ({g['reason']})")
            for g in res["games"]
        )
        print(f"snapshot at {snap['minute']:g} min: {results}", flush=True)


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


def play_versus(args):
    """--versus A B: 두 모델을 서로 두게 하고 A 기준 결과를 찍습니다. 정답을 모르는 게임에서 두 모델을 비교할 때 씁니다
    (학습 시간별 중간 모델, 이어 학습과 처음부터 학습, 탐색 횟수). 판 둘이 한 쌍이라 판 수는 짝수로 맞춥니다"""
    pool = Pool(args.game, args.workers)
    try:
        info = pool.info
        nets = []
        for path in args.versus:
            saved = torch.load(path, map_location=args.device)
            trained = saved.get("info") or info
            if not same_shape(trained, info):
                diff = [k for k in SHAPE if trained.get(k) != info.get(k)]
                raise SystemExit(f"{path} does not fit this game's code ({', '.join(diff)} differ)")
            nets.append(make_infer(load_net(saved, args.device), args.device))
        games = max(2, args.eval_games + args.eval_games % 2)
        cmd = {
            "cmd": "match",
            "opponent": "network",
            "games": games,
            "parallel": args.parallel,
            "sims": args.sims,
            "maxMoves": args.max_moves,
            "seed": args.seed,
            "openingMoves": args.opening_moves,
        }
        res = pool.split(cmd, nets, unit=2)
    finally:
        pool.close()
    v = versus_summary(res)
    a, b = args.versus
    cut = f", {res['cut']} cut by the training draw rule" if res["cut"] else ""
    print(
        f"{a} vs {b}: {v['games']} games ({v['distinct']} distinct), {args.sims} sims, "
        f"first {args.opening_moves} moves random{cut}\n"
        f"  A as first W/D/L {wdl(res['first'])}  second {wdl(res['second'])}\n"
        f"  A scores {v['score']:.1%} ({v['low']:.1%}-{v['high']:.1%}), "
        f"Elo {v['elo']:+.0f} ({v['eloLow']:+.0f} to {v['eloHigh']:+.0f}, 95%)",
        flush=True,
    )
    if v["distinct"] is not None and v["distinct"] < v["games"] / 2:
        print(
            "  many games repeat, so the range above is too narrow: "
            "raise --opening-moves for more varied games (each extra random move multiplies the openings)",
            flush=True,
        )
    return v


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
    ap.add_argument("--blocks", type=int, default=None, help="residual blocks (default 4, or the --init-from model's)")
    ap.add_argument("--filters", type=int, default=None, help="channels per layer (default 64, or the --init-from model's)")
    ap.add_argument(
        "--init-from",
        default=None,
        help="start from another model.pt (an older version of this game, or a similar game): layers of the same shape "
        "are copied, input channels and special actions are matched by name, the rest start fresh",
    )
    ap.add_argument(
        "--save-every",
        type=float,
        default=0,
        help="also keep the network every N minutes in checkpoints/ (for learning curves; 0 = off)",
    )
    ap.add_argument(
        "--versus",
        nargs=2,
        metavar=("A", "B"),
        default=None,
        help="only play model A against model B (two model.pt files): each pair of games starts the same and swaps "
        "sides; --eval-games games, --sims simulations per move for both. Prints A's result",
    )
    ap.add_argument(
        "--opening-moves",
        type=int,
        default=2,
        help="with --versus: the first N moves of each pair of games are random, so the games differ. "
        "Too many hide the difference on small boards (default 2)",
    )
    ap.add_argument("--steps", type=int, default=100, help="training steps per iteration")
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--window", type=int, default=20, help="train on the last N iterations of self-play")
    ap.add_argument("--value-weight", type=float, default=1.0, help="weight of the value loss (default 1)")
    ap.add_argument(
        "--value-keep",
        type=float,
        default=1.0,
        help="share of positions whose game result is a value target; the rest train only the policy (default 1)",
    )
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
    ap.add_argument(
        "--fast-sims",
        type=int,
        default=0,
        help="playout cap randomization (KataGo): most moves search only this many times and are not trained on; "
        "--full-prob of the moves search --sims times and become training data (0 = off, every move uses --sims)",
    )
    ap.add_argument(
        "--full-prob",
        type=float,
        default=0.25,
        help="with --fast-sims: the share of moves that search --sims times and become training data (default 0.25)",
    )
    ap.add_argument("--out", default=None, help="output folder (default trainer/runs/<game id>)")
    ap.add_argument("--resume", action="store_true", help="continue from model.pt in the output folder")
    ap.add_argument("--eval-only", action="store_true", help="only evaluate model.pt in the output folder")
    ap.add_argument(
        "--export-onnx",
        action="store_true",
        help="only write model.onnx and model.json for the browser AI from model.pt in the output folder",
    )
    ap.add_argument(
        "--play-sims", type=int, default=100, help="with --export-onnx: MCTS simulations per move of the browser AI"
    )
    ap.add_argument(
        "--snapshot-every",
        type=float,
        default=10,
        help="every N minutes, save games the AI plays against itself to snapshots.json (0 = off, default 10)",
    )
    ap.add_argument("--snapshot-games", type=int, default=2, help="games per snapshot (default 2)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    if args.export_onnx:
        # 지금 게임 코드의 모양과 버전만 알면 되므로 워커는 하나만 띄웁니다
        worker = Worker(args.game)
        worker.close()
        info = worker.info
        out = Path(args.out) if args.out else HERE / "runs" / info["id"]
        if not (out / "model.pt").exists():
            raise SystemExit(f"no model to export: {out / 'model.pt'}")
        saved = torch.load(out / "model.pt", map_location="cpu")
        meta = export_onnx(saved, info, out, args.play_sims)
        same = "same code version" if meta["version"] == info["version"] else "trained on another code version"
        print(f"exported iteration {meta['iteration']} ({same}): {out / 'model.onnx'}, {out / 'model.json'}")
        if b := meta.get("balance"):
            print(
                f"balance (self-play, iterations {b['from']}-{b['to']}, {b['games']} games): "
                f"first wins {b['wins'][0] / b['games']:.1%}, second wins {b['wins'][1] / b['games']:.1%}, "
                f"draws {b['draws'] / b['games']:.1%}"
            )
        return

    if args.versus:
        play_versus(args)
        return
    if args.init_from and (args.resume or args.eval_only):
        raise SystemExit("--init-from starts a new run, so it cannot go with --resume or --eval-only")

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
        f"{args.search} search"
        + (
            f", {args.full_prob:.0%} of moves with {args.sims} sims (trained on), the rest {args.fast_sims}"
            if args.fast_sims
            else ""
        ),
        flush=True,
    )

    solved = pool.one({"cmd": "solve", "limit": args.solve_limit})
    solvable = not solved.get("tooBig")
    if solvable:
        print(f"solved exactly ({solved['positions']} positions): {OUTCOME[solved['value']]} with perfect play")
    else:
        print("too big to solve exactly, so only the random opponent is used for evaluation")

    init = torch.load(args.init_from, map_location="cpu") if args.init_from else None
    size = init["config"] if init else {}
    blocks = args.blocks or size.get("blocks", 4)
    filters = args.filters or size.get("filters", 64)
    net = Net(info["channels"], len(info["specials"]), blocks, filters)
    if init:
        r = init_from(net, init, info)
        same = "same game" if (init.get("info") or {}).get("id") == info["id"] else (init.get("info") or {}).get("id", "?")
        print(
            f"started from {args.init_from} ({same}, iteration {init.get('iteration')}): {r['copied']} layers copied, "
            f"{r['channels']}/{r['of']} input channels matched by name"
            + (f", fresh: {', '.join(r['fresh'])}" if r["fresh"] else ""),
            flush=True,
        )
    net = net.to(args.device)
    opt = torch.optim.Adam(net.parameters(), lr=args.lr, weight_decay=1e-4)
    first = 1
    prior = None  # 이어서 학습하면(--resume) 앞 학습까지의 분 (model.pt의 minutes)
    if args.eval_only and not (out / "model.pt").exists():
        pool.close()
        raise SystemExit(f"no model to evaluate: {out / 'model.pt'}")
    if (args.resume or args.eval_only) and (out / "model.pt").exists():
        saved = torch.load(out / "model.pt", map_location=args.device)
        net = Net(**saved["config"]).to(args.device)
        net.load_state_dict(saved["state"])
        opt = torch.optim.Adam(net.parameters(), lr=args.lr, weight_decay=1e-4)
        first = saved["iteration"] + 1
        prior = saved.get("minutes")
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
    if init:
        log.write(json.dumps({"initFrom": str(args.init_from), "init": r}) + "\n")
    last = first - 1  # 마지막으로 끝낸 반복
    evaluated = None
    snaps = Snapshots(out / "snapshots.json", info, args)
    since_eval = None  # 앞 스냅샷부터의 마지막 평가
    minutes = lambda: (time.monotonic() - t0) / 60  # noqa: E731
    # model.pt와 중간 모델의 분은 앞 학습에 이어서 셉니다 (이름이 분 순서로 정렬되게).
    # minutes가 없는 옛 model.pt면 학습 기록의 마지막 분으로 어림합니다
    base = prior if prior is not None else snaps.base
    total = lambda: base + minutes()  # noqa: E731
    # 다음에 중간 모델을 남길 때 (분)
    next_save = (int(base / args.save_every) + 1) * args.save_every if args.save_every > 0 else 0
    try:
        # 학습 전의 AI (무작위 신경망 + 탐색). 이어서 학습하면 앞 기록에 이어 붙입니다
        if snaps.empty:
            snaps.take(pool, infer, 0, last)
        else:
            snaps.next = args.snapshot_every
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
                # 롤아웃 AI가 두는 워밍업에는 쓰지 않습니다
                "fastSims": 0 if warmup else args.fast_sims,
                "fullProb": args.full_prob,
            }
            stats = pool.split(cmd, infer, on_game=lambda obj, data: games.append(unpack_game(info, obj, data)))
            new = tuple(np.concatenate([g[k] for g in games]) for k in range(3))
            fresh = fresh_loss(net, new, args.device)  # 버퍼에 넣기 전에 잽니다
            if args.value_keep < 1:
                # 한 판의 국면은 모두 같은 승패를 정답으로 가져서, 다 배우면 판을 외우기 쉽습니다. 일부만 가치를 배웁니다
                new = new + ((rng.random(len(new[2])) < args.value_keep).astype(np.float32),)
            buffer.append(new)
            buffer = buffer[-args.window :]
            loss = train(net, opt, buffer, args.steps, args.batch, args.device, rng, args.value_weight)
            n = sum(len(b[2]) for b in buffer)
            print(
                f"iter {it:3d}  first/second/draw {stats['wins'][0]}/{stats['wins'][1]}/{stats['draws']}"
                + (f" (cut {stats['cut']})" if stats["cut"] else "")
                + f"  moves {stats['moves'] / args.games:.1f}"
                + (f"  kept {stats['positions']}" if args.fast_sims and not warmup else "")
                + f"  loss p {loss['policy']:.3f} v {loss['value']:.3f}"
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
                evaluated = since_eval = entry["eval"] = evaluate(pool, infer, args, solvable)
            log.write(json.dumps(entry) + "\n")
            log.flush()
            m = total()
            torch.save(
                {"config": net.config, "state": net.state_dict(), "iteration": it, "info": info, "minutes": m},
                out / "model.pt",
            )
            if args.save_every > 0 and m >= next_save:
                # 학습 곡선용 중간 모델. 이름이 분 순서로 정렬됩니다
                (out / "checkpoints").mkdir(exist_ok=True)
                torch.save(
                    {"config": net.config, "state": net.state_dict(), "iteration": it, "info": info, "minutes": m},
                    out / "checkpoints" / f"{m:06.1f}min-iter{it}.pt",
                )
                next_save = (int(m / args.save_every) + 1) * args.save_every
            last = it
            snaps.add_selfplay(stats)
            if snaps.due(minutes()):
                snaps.take(pool, infer, minutes(), it, since_eval)
                since_eval = None
        # 마지막 평가는 롤아웃 AI와도 둡니다 (학습 없이 공짜로 만드는 AI보다 나아졌는지)
        if last >= first and (evaluated is None or args.rollout_sims):
            print("final evaluation")
            since_eval = evaluate(pool, infer, args, solvable, rollout=True)
            log.write(json.dumps({"iteration": last, "eval": since_eval}) + "\n")
        # 마지막 AI도 남깁니다 (올리는 모델과 같은 신경망)
        if not snaps.empty and snaps.data["snapshots"][-1]["iteration"] != last:
            snaps.take(pool, infer, minutes(), last, since_eval)
    finally:
        log.close()
        pool.close()
    print(f"done in {time.monotonic() - t0:.0f}s: {out / 'model.pt'}")
    if not snaps.empty:
        print(f"training record ({len(snaps.data['snapshots'])} snapshots): {snaps.path}")


if __name__ == "__main__":
    main()
