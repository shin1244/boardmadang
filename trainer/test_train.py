"""신경망 모양, 자기대국 워커와 주고받는 메시지, 학습 기록(스냅샷), 브라우저 AI용 ONNX 내보내기 테스트.

    python -m unittest discover -s trainer
"""

import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch

from net import Net
from train import (
    Pool,
    Snapshots,
    Worker,
    balance_from_log,
    eval_summary,
    export_onnx,
    fresh_loss,
    init_from,
    train,
    unpack_game,
    versus_summary,
)

TICTACTOE = Path(__file__).resolve().parent.parent / "games" / "tictactoe"


def uniform(x):
    """모든 행동에 같은 점수, 가치 0"""
    return np.zeros((len(x), 9), np.float32), np.zeros(len(x), np.float32)


class NetTest(unittest.TestCase):
    def test_shapes(self):
        net = Net(channels=14, specials=0, blocks=1, filters=8).eval()
        logits, v = net(torch.zeros(5, 14, 3, 3))
        self.assertEqual(tuple(logits.shape), (5, 9))
        self.assertEqual(tuple(v.shape), (5,))
        # 특수 행동은 클릭 뒤에 붙습니다
        net = Net(channels=14, specials=2, blocks=1, filters=8).eval()
        logits, _ = net(torch.zeros(3, 14, 5, 4))
        self.assertEqual(tuple(logits.shape), (3, 5 * 4 + 2))

    def test_fresh_loss(self):
        torch.manual_seed(0)
        net = Net(channels=14, specials=0, blocks=1, filters=8)
        planes = np.random.default_rng(0).random((7, 14, 3, 3), dtype=np.float32)
        pis = np.full((7, 9), 1 / 9, np.float32)
        zs = np.array([1, -1, 0, 1, 1, -1, 0.5], np.float32)
        # 여러 묶음으로 나눠 재도 한 번에 잰 것과 같아야 합니다
        got = fresh_loss(net, (planes, pis, zs), "cpu", batch=3)
        with torch.no_grad():
            logits, v = net.eval()(torch.from_numpy(planes))
        pi = torch.from_numpy(pis)
        self.assertAlmostEqual(got["value"], float(((v - torch.from_numpy(zs)) ** 2).mean()), places=5)
        self.assertAlmostEqual(got["policy"], float(-(pi * torch.log_softmax(logits, 1)).sum(1).mean()), places=5)
        self.assertAlmostEqual(got["zero"], float((zs**2).mean()), places=6)
        self.assertIsNone(fresh_loss(net, (planes[:0], pis[:0], zs[:0]), "cpu"))

    def test_value_options(self):
        """--value-weight 0이나 가치를 배울 국면이 없으면 가치 머리의 끝(value_fc)은 그대로, 아니면 바뀝니다"""
        rng = np.random.default_rng(0)
        planes = rng.random((32, 14, 3, 3), dtype=np.float32)
        pis = np.full((32, 9), 1 / 9, np.float32)
        zs = rng.choice([-1.0, 1.0], 32).astype(np.float32)

        def moved(buffer, **kw):
            torch.manual_seed(0)
            net = Net(channels=14, specials=0, blocks=1, filters=8)
            before = [p.detach().clone() for p in net.value_fc.parameters()]
            opt = torch.optim.SGD(net.parameters(), lr=0.1)
            loss = train(net, opt, buffer, 3, 16, "cpu", np.random.default_rng(1), **kw)
            self.assertTrue(np.isfinite(loss["value"]))
            return any(not torch.equal(a, b) for a, b in zip(before, net.value_fc.parameters()))

        self.assertTrue(moved([(planes, pis, zs)]))
        self.assertFalse(moved([(planes, pis, zs)], value_weight=0.0))
        self.assertFalse(moved([(planes, pis, zs, np.zeros(32, np.float32))]))
        self.assertTrue(moved([(planes, pis, zs, (np.arange(32) % 4 == 0).astype(np.float32))]))


class WorkerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = Worker(TICTACTOE)

    @classmethod
    def tearDownClass(cls):
        cls.worker.close()

    def test_info(self):
        info = self.worker.info
        self.assertEqual((info["id"], info["rows"], info["cols"], info["nActions"]), ("tictactoe", 3, 3, 9))

    def test_solve(self):
        self.assertEqual(self.worker.run({"cmd": "solve"})["value"], 0)

    def test_selfplay(self):
        games = []
        stats = self.worker.run(
            {"cmd": "selfplay", "games": 3, "parallel": 3, "sims": 8, "tempMoves": 2},
            uniform,
            on_game=lambda obj, data: games.append(unpack_game(self.worker.info, obj, data)),
        )
        self.assertEqual(len(games), 3)
        self.assertEqual(sum(stats["wins"]) + stats["draws"], 3)
        planes, pi, z = games[0]
        self.assertEqual(planes.shape[1:], (14, 3, 3))
        self.assertEqual(len(planes), len(pi))
        np.testing.assert_allclose(pi.sum(1), 1, rtol=1e-5)
        self.assertTrue(set(np.unique(z)) <= {-1.0, 0.0, 1.0})

    def test_match(self):
        r = self.worker.run({"cmd": "match", "opponent": "perfect", "games": 4, "sims": 8}, uniform)
        self.assertEqual(sum(r["first"]) + sum(r["second"]), 4)

    def test_unknown_command(self):
        with self.assertRaises(RuntimeError):
            self.worker.run({"cmd": "nope"})


class PoolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pool = Pool(TICTACTOE, 3)

    @classmethod
    def tearDownClass(cls):
        cls.pool.close()

    def test_selfplay_is_split_and_merged(self):
        games = []
        stats = self.pool.split(
            {"cmd": "selfplay", "games": 7, "sims": 8, "tempMoves": 9, "seed": 5},
            uniform,
            on_game=lambda obj, data: games.append(unpack_game(self.pool.info, obj, data)),
        )
        self.assertEqual(len(games), 7)
        self.assertEqual(stats["games"], 7)
        self.assertEqual(sum(stats["wins"]) + stats["draws"], 7)
        self.assertEqual(stats["moves"], sum(len(g[2]) for g in games))
        self.assertEqual(stats["positions"], stats["moves"], "without fastSims every move is kept")

    def test_selfplay_with_playout_cap(self):
        def run(full_prob, method="puct"):
            games = []
            stats = self.pool.split(
                {"cmd": "selfplay", "games": 6, "sims": 8, "tempMoves": 9, "method": method, "fastSims": 2, "fullProb": full_prob},
                uniform,
                on_game=lambda obj, data: games.append(unpack_game(self.pool.info, obj, data)),
            )
            self.assertEqual(len(games), 6)
            self.assertEqual(stats["positions"], sum(len(g[2]) for g in games))
            pi = np.concatenate([g[1] for g in games])
            if len(pi):
                np.testing.assert_allclose(pi.sum(1), 1, rtol=1e-5)
            return stats

        # 모두 깊게 탐색하면 모든 수가 남고, 모두 얕게 탐색하면 아무 수도 남지 않습니다 (판은 끝까지 둡니다)
        for method in ("puct", "gumbel"):
            every = run(1, method)
            self.assertEqual(every["positions"], every["moves"])
            none = run(0, method)
            self.assertEqual(none["positions"], 0)
            self.assertGreater(none["moves"], 0)
        some = run(0.5)
        self.assertLess(some["positions"], some["moves"])

    def test_selfplay_with_rollout_teacher(self):
        # 롤아웃 AI가 두므로 신경망은 부르지 않습니다 (infer가 None이면 부를 때 오류)
        games = []
        stats = self.pool.split(
            {"cmd": "selfplay", "games": 4, "sims": 16, "tempMoves": 9, "teacher": "rollout"},
            None,
            on_game=lambda obj, data: games.append(unpack_game(self.pool.info, obj, data)),
        )
        self.assertEqual(stats["games"], 4)
        np.testing.assert_allclose(np.concatenate([g[1] for g in games]).sum(1), 1, rtol=1e-5)

    def test_selfplay_with_gumbel_and_value_mix(self):
        games = []
        self.pool.split(
            {"cmd": "selfplay", "games": 4, "sims": 8, "method": "gumbel", "valueMix": 0.5},
            uniform,
            on_game=lambda obj, data: games.append(unpack_game(self.pool.info, obj, data)),
        )
        self.assertEqual(len(games), 4)
        pi = np.concatenate([g[1] for g in games])
        np.testing.assert_allclose(pi.sum(1), 1, rtol=1e-5)
        z = np.concatenate([g[2] for g in games])
        self.assertTrue(np.all(np.abs(z) <= 1))
        self.assertFalse(set(np.unique(z)) <= {-1.0, 0.0, 1.0}, "the search value is mixed in")

    def test_versus_asks_both_networks(self):
        calls = [0, 0]

        def counted(k):
            def infer(x):
                calls[k] += len(x)
                return uniform(x)

            return infer

        cmd = {"cmd": "match", "opponent": "network", "games": 8, "sims": 4, "openingMoves": 1}
        r = self.pool.split(cmd, [counted(0), counted(1)], unit=2)
        self.assertEqual(sum(r["first"]) + sum(r["second"]), 8)
        self.assertEqual((sum(r["first"]), sum(r["second"])), (4, 4))
        self.assertEqual(len(r["hashes"]), 8)
        self.assertGreater(calls[0], 0)
        self.assertGreater(calls[1], 0)

    def test_match_against_rollout(self):
        r = self.pool.split({"cmd": "match", "opponent": "rollout", "oppSims": 20, "games": 6, "sims": 8}, uniform)
        self.assertEqual(sum(r["first"]) + sum(r["second"]), 6)

    def test_one(self):
        self.assertEqual(self.pool.one({"cmd": "solve"})["value"], 0)

    def test_snapshots(self):
        """학습 기록: AI끼리 둔 판은 기보처럼 시드와 { player, action }이고, 앞 스냅샷부터의 자기대국 통계가 붙습니다"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "snapshots.json"
            args = SimpleNamespace(
                snapshot_every=10, snapshot_games=3, sims=8, max_moves=512, seed=1, minutes=60, resume=False
            )
            snaps = Snapshots(path, self.pool.info, args)
            self.assertTrue(snaps.empty)
            self.assertTrue(snaps.due(0))
            snaps.take(self.pool, uniform, 0, 0)
            self.assertFalse(snaps.due(9.9))
            self.assertTrue(snaps.due(10))
            snaps.add_selfplay({"games": 4, "wins": [2, 1], "draws": 1, "cut": 1, "moves": 30})
            snaps.add_selfplay({"games": 4, "wins": [0, 1], "draws": 3, "cut": 0, "moves": 31})
            evaluated = {"random": {"first": [3, 0, 0], "second": [2, 1, 0], "cut": 0, "lost": []}}
            snaps.take(self.pool, uniform, 10.04, 7, evaluated)

            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["format"], 1)
            self.assertEqual(data["game"], "tictactoe")
            self.assertEqual(data["version"], self.pool.info["version"])
            self.assertEqual(data["minutes"], 60)
            first, second = data["snapshots"]
            self.assertEqual((first["minute"], first["iteration"], first["selfplay"]), (0, 0, None))
            self.assertNotIn("eval", first)
            self.assertEqual((second["minute"], second["iteration"]), (10, 7))
            self.assertEqual(second["selfplay"], {"games": 8, "wins": [2, 2], "draws": 4, "cut": 1, "moves": 61})
            self.assertEqual(second["eval"], {"random": {"first": [3, 0, 0], "second": [2, 1, 0]}})
            for snap in data["snapshots"]:
                self.assertEqual(len(snap["games"]), 3)
                for g in snap["games"]:
                    self.assertEqual(g["seed"], 1)
                    self.assertIn(g["reason"], ("result", "maxActions", "cut"))
                    self.assertIn(g["winner"], (0, 1, None))
                    # 틱택토는 번갈아 두고, 칸마다 한 번만 둡니다
                    self.assertEqual([m["player"] for m in g["moves"]], [i % 2 for i in range(len(g["moves"]))])
                    cells = [(m["action"]["row"], m["action"]["col"]) for m in g["moves"]]
                    self.assertEqual(len(set(cells)), len(cells))
                    self.assertTrue(all(m["action"]["kind"] == "click" for m in g["moves"]))
            # 같은 신경망이면 첫 판(가장 좋은 수만)은 같습니다
            self.assertEqual(first["games"][0], second["games"][0])

            # 이어서 학습하면 앞 기록에 붙이고 분은 이어서 셉니다
            args.resume = True
            again = Snapshots(path, self.pool.info, args)
            self.assertEqual(len(again.data["snapshots"]), 2)
            self.assertEqual(again.data["minutes"], 120)
            again.take(self.pool, uniform, 5, 9)
            self.assertEqual(again.data["snapshots"][-1]["minute"], 15)

    def test_eval_summary(self):
        self.assertIsNone(eval_summary(None))
        res = {
            "random": {"first": [1, 2, 3], "second": [4, 5, 6], "cut": 0, "lost": []},
            "accuracy": {"positions": 10, "policy": {"rate": 0.5, "missedWins": 1}, "search": {"rate": 0.9}},
        }
        self.assertEqual(
            eval_summary(res),
            {"random": {"first": [1, 2, 3], "second": [4, 5, 6]}, "accuracy": {"policy": 0.5, "search": 0.9}},
        )


class InitFromTest(unittest.TestCase):
    """--init-from: 다른 모델의 가중치로 시작"""

    MARKS = ["mark:dot", "mark:ring", "mark:last-move", "mark:danger", "mark:ghost", "mark:blocked", "mark:frame"]
    COMMON = [*MARKS, "tint:0", "tint:1", "tint:other", "text", "toPlay"]

    def model(self, pieces, specials, observe=0, seed=0):
        names = [f"piece:{p}" for p in pieces] + self.COMMON + [f"observe:{i}" for i in range(observe)]
        torch.manual_seed(seed)
        net = Net(len(names), len(specials), blocks=1, filters=8)
        info = {"id": "g", "channelNames": names, "specials": specials}
        return net, info

    def test_same_game_copies_everything(self):
        src, info = self.model(["x", "o"], [])
        dst, _ = self.model(["x", "o"], [], seed=1)
        r = init_from(dst, {"state": src.state_dict(), "info": info}, info)
        self.assertEqual(r["fresh"], [])
        self.assertEqual((r["channels"], r["of"]), (14, 14))
        for k, v in src.state_dict().items():
            self.assertTrue(torch.equal(v, dst.state_dict()[k]), k)

    def test_other_game_matches_channels_and_specials_by_name(self):
        src, src_info = self.model(["x", "o"], ["pass", "swap"])
        # 기물 이름이 하나 겹치고(o), 기물 수와 observe() 채널 수가 달라 공통 채널의 자리가 밀립니다
        dst, info = self.model(["o", "red", "blue"], ["swap"], observe=1, seed=1)
        before = {k: v.clone() for k, v in dst.state_dict().items()}
        r = init_from(dst, {"state": src.state_dict(), "info": src_info}, info)
        self.assertEqual((r["channels"], r["of"]), (13, 16))  # o와 공통 12개
        self.assertEqual(r["fresh"], [])
        old, new = src.state_dict()["stem.0.weight"], dst.state_dict()["stem.0.weight"]
        for i, name in enumerate([*info["channelNames"], "onBoard"]):
            theirs = [*src_info["channelNames"], "onBoard"]
            if name in theirs:
                self.assertTrue(torch.equal(new[:, i], old[:, theirs.index(name)]), name)
            else:
                self.assertTrue(torch.equal(new[:, i], before["stem.0.weight"][:, i]), name)  # 새로 시작
        # 특수 행동 swap은 원래 모델의 두 번째 줄에서
        self.assertTrue(torch.equal(dst.state_dict()["special.weight"][0], src.state_dict()["special.weight"][1]))
        self.assertTrue(torch.equal(dst.state_dict()["trunk.0.c1.weight"], src.state_dict()["trunk.0.c1.weight"]))

    def test_other_size_starts_fresh(self):
        src, info = self.model(["x", "o"], ["pass"])
        torch.manual_seed(1)
        dst = Net(14, 0, blocks=1, filters=16)  # 채널 수가 달라 몸통은 옮길 수 없음
        r = init_from(dst, {"state": src.state_dict(), "info": info}, {**info, "specials": []})
        for key in ("stem.0.weight", "trunk.0.c1.weight", "policy.0.weight", "value.0.weight"):
            self.assertIn(key, r["fresh"])
        self.assertEqual(r["channels"], 0)

    def test_more_blocks_keeps_the_first_ones(self):
        src, info = self.model(["x", "o"], [])
        torch.manual_seed(1)
        dst = Net(14, 0, blocks=2, filters=8)
        r = init_from(dst, {"state": src.state_dict(), "info": info}, info)
        self.assertTrue(torch.equal(dst.state_dict()["trunk.0.c1.weight"], src.state_dict()["trunk.0.c1.weight"]))
        self.assertIn("trunk.1.c1.weight", r["fresh"])


# 판이 커서 신경망 답 하나가 파이프 버퍼(Linux 64KB, Windows 4KB)보다 큰 게임. 네 수를 두면 끝납니다
BIG_GAME = """
const N = 32;
const at = (i) => ({ row: Math.floor(i / N), col: i % N });
export default {
  id: 'big-board',
  board: { places: 'cells', rows: N, cols: N },
  pieces: 'xo',
  maxActions: 8,
  setup: () => ({ cells: [], turn: 0 }),
  play(s, p, a) {
    const i = a.row * N + a.col;
    if (s.cells.length >= 4 || p !== s.turn || a.kind !== 'click' || s.cells.includes(i)) return s;
    return { cells: [...s.cells, i], turn: 1 - s.turn };
  },
  turn: (s) => (s.cells.length >= 4 ? null : s.turn),
  result: (s) => (s.cells.length >= 4 ? { winner: s.cells[0] % 2 } : null),
  view: (s) => ({ pieces: s.cells.map((i, k) => ({ ...at(i), piece: k % 2 ? 'o' : 'x' })) }),
  legal: (s, p) => (s.cells.length >= 4 || p !== s.turn ? []
    : Array.from({ length: N * N }, (_, i) => i).filter((i) => !s.cells.includes(i)).map((i) => ({ kind: 'click', ...at(i) }))),
};
"""


class VersusPipeTest(unittest.TestCase):
    def test_two_networks_with_big_replies(self):
        """모델 대 모델에서 워커가 신경망 요청 둘을 겹쳐 보내면, train.py가 첫 답을 쓰는 동안 워커는 둘째 요청을 쓰느라
        서로 기다리며 멈췄습니다 (답이 파이프 버퍼보다 클 때. Windows에서는 스플체스 크기로도 멈춤)"""
        with tempfile.TemporaryDirectory() as d:
            game = Path(d) / "big-board"
            game.mkdir()
            (game / "index.js").write_text(BIG_GAME, encoding="utf-8")
            (game / "package.json").write_text('{"type": "module"}', encoding="utf-8")
            pool = Pool(game, 1)
            try:
                n = pool.info["nActions"]

                def infer(x):
                    return np.zeros((len(x), n), np.float32), np.zeros(len(x), np.float32)

                cmd = {"cmd": "match", "opponent": "network", "games": 64, "sims": 2, "openingMoves": 0}
                out = {}
                t = threading.Thread(target=lambda: out.update(r=pool.split(cmd, [infer, infer], unit=2)), daemon=True)
                t.start()
                t.join(60)
                self.assertFalse(t.is_alive(), "the versus match got stuck")
                self.assertEqual(sum(out["r"]["first"]) + sum(out["r"]["second"]), 64)
            finally:
                # 멈췄으면 quit을 보낼 수도 없으니 바로 끄고 파이프를 닫습니다
                for w in pool.workers:
                    w.proc.kill()
                    w.proc.communicate()


class VersusTest(unittest.TestCase):
    def test_summary(self):
        v = versus_summary({"first": [6, 2, 2], "second": [2, 2, 6], "hashes": ["a", "b", "b"]})
        self.assertEqual((v["wins"], v["draws"], v["losses"], v["games"], v["distinct"]), (8, 4, 8, 20, 2))
        self.assertAlmostEqual(v["score"], 0.5)
        self.assertAlmostEqual(v["elo"], 0, places=6)
        self.assertLess(v["low"], 0.5)
        self.assertGreater(v["high"], 0.5)
        strong = versus_summary({"first": [9, 1, 0], "second": [8, 1, 1]})
        self.assertGreater(strong["elo"], 200)
        self.assertIsNone(strong["distinct"])

    def test_cli(self):
        # 중간 모델 남기기 → 그 모델에서 이어 학습 → 둘을 서로 두게 하기
        script = Path(__file__).resolve().parent / "train.py"
        small = ["--blocks", "1", "--filters", "8", "--games", "4", "--sims", "4", "--steps", "2", "--workers", "1"]
        quiet = ["--solve-limit", "0", "--rollout-sims", "0", "--snapshot-every", "0", "--eval-games", "4"]

        def run(*args):
            out = subprocess.run([sys.executable, str(script), str(TICTACTOE), *args], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            return out.stdout

        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d) / "a", Path(d) / "b"
            run("--iterations", "2", "--save-every", "1e-9", "--out", str(a), *small, *quiet)
            ckpts = sorted((a / "checkpoints").iterdir())
            self.assertEqual(len(ckpts), 2)
            self.assertEqual(torch.load(ckpts[0])["iteration"], 1)
            # 이어 학습하면 분을 앞 학습에 이어서 셉니다 (0분부터 다시 세면 앞 중간 모델들과 섞임)
            before = torch.load(a / "model.pt")["minutes"]
            run("--iterations", "1", "--resume", "--save-every", "1e-9", "--out", str(a), *small, *quiet)
            resumed = [torch.load(p) for p in (a / "checkpoints").iterdir() if p not in ckpts]
            self.assertEqual([c["iteration"] for c in resumed], [3])
            self.assertGreater(resumed[0]["minutes"], before)
            self.assertGreater(torch.load(a / "model.pt")["minutes"], before)
            got = run("--iterations", "1", "--init-from", str(ckpts[0]), "--out", str(b), *small, *quiet)
            self.assertIn("14/14 input channels matched by name", got)
            got = run("--versus", str(ckpts[0]), str(b / "model.pt"), "--eval-games", "6", "--sims", "2", "--workers", "2")
            self.assertIn("6 games", got)
            self.assertIn("A scores", got)


class ExportTest(unittest.TestCase):
    """브라우저 AI가 쓰는 ONNX 내보내기. onnxruntime으로 돌린 결과가 PyTorch와 같아야 합니다"""

    @classmethod
    def setUpClass(cls):
        worker = Worker(TICTACTOE)
        worker.close()
        cls.info = worker.info
        torch.manual_seed(0)
        net = Net(cls.info["channels"], 0, blocks=1, filters=8)
        # BatchNorm의 기본 통계(평균 0, 분산 1)면 그 층이 하는 일이 없어서, 학습한 것처럼 바꿔 둡니다
        for m in net.modules():
            if isinstance(m, torch.nn.BatchNorm2d):
                m.running_mean.uniform_(-0.5, 0.5)
                m.running_var.uniform_(0.5, 2)
        cls.net = net.eval()
        cls.saved = {"config": net.config, "state": net.state_dict(), "iteration": 7, "info": cls.info}

    def test_onnx_matches_torch(self):
        import onnxruntime

        with tempfile.TemporaryDirectory() as d:
            meta = export_onnx(self.saved, self.info, Path(d), 123)
            self.assertNotIn("balance", meta)  # 학습 기록(log.jsonl)이 없으면 넣지 않습니다
            session = onnxruntime.InferenceSession(str(Path(d) / "model.onnx"))
            saved_meta = json.loads((Path(d) / "model.json").read_text(encoding="utf-8"))
        self.assertEqual(saved_meta, meta)
        self.assertEqual([i.name for i in session.get_inputs()], ["x"])
        self.assertEqual([o.name for o in session.get_outputs()], ["logits", "value"])
        # 브라우저는 한 판씩, 나중에 묶어서 넣을 수도 있으므로 묶음 크기를 바꿔 봅니다
        for n in (1, 5):
            x = np.random.default_rng(n).random((n, self.info["channels"], 3, 3), dtype=np.float32)
            logits, value = session.run(None, {"x": x})
            with torch.no_grad():
                want_logits, want_value = self.net(torch.from_numpy(x))
            np.testing.assert_allclose(logits, want_logits.numpy(), atol=1e-5)
            np.testing.assert_allclose(value, want_value.numpy(), atol=1e-5)

        self.assertEqual(meta["format"], 1)
        self.assertEqual((meta["game"], meta["version"], meta["lang"]), ("tictactoe", self.info["version"], "ko"))
        self.assertRegex(meta["version"], r"^[0-9a-f]{16}$")
        self.assertEqual(meta["channelNames"], self.info["channelNames"])
        self.assertEqual((meta["rows"], meta["cols"], meta["nActions"], meta["specials"]), (3, 3, 9, []))
        self.assertEqual((meta["sims"], meta["iteration"], meta["net"]), (123, 7, {"blocks": 1, "filters": 8}))

    def test_balance(self):
        # 자기대국 기록이 있으면 마지막 5분의 1 반복의 결과를 model.json에 넣습니다
        def row(it, wins, draws=0, **extra):
            sp = {"games": wins[0] + wins[1] + draws, "wins": wins, "draws": draws, "cut": 0, "moves": 50}
            return json.dumps({"iteration": it, "selfplay": sp, **extra})

        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "log.jsonl"
            self.assertIsNone(balance_from_log(log))
            lines = [row(1, [9, 1]), row(2, [9, 1])]  # 앞서 학습하다 그만둔 기록
            lines += [row(1, [0, 10], teacher="rollout")]  # 다시 시작. 롤아웃 AI가 둔 반복은 빼고
            lines += [row(i, [6, 3], 1) for i in range(2, 10)]
            lines += [json.dumps({"iteration": 9, "eval": {}}), "not json"]
            lines += [row(10, [1, 1])]  # model.pt(반복 9)보다 뒤
            log.write_text("\n".join(lines) + "\n", encoding="utf-8")
            # 반복 2~9의 여덟 개 중 마지막 둘 (8, 9)
            want = {"games": 20, "wins": [12, 6], "draws": 2, "cut": 0, "from": 8, "to": 9}
            self.assertEqual(balance_from_log(log, 9), want)
            self.assertEqual(export_onnx({**self.saved, "iteration": 9}, self.info, Path(d), 50)["balance"], want)
            self.assertEqual(balance_from_log(log, 2)["from"], 2)  # 하나뿐이어도 그 반복

    def test_old_model_with_same_shape(self):
        # 코드가 바뀌어도 모양이 같으면 내보내고, version은 학습한 코드의 것입니다 (없던 시절의 model.pt면 null)
        old = {**self.saved, "info": {k: v for k, v in self.info.items() if k != "version"}}
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(export_onnx(old, self.info, Path(d), 50)["version"])

    def test_refuses_other_shape(self):
        other = {**self.saved, "info": {**self.info, "channelNames": self.info["channelNames"][::-1]}}
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit):
                export_onnx(other, self.info, Path(d), 50)
            self.assertFalse((Path(d) / "model.onnx").exists())


if __name__ == "__main__":
    unittest.main()
