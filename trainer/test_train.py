"""신경망 모양과 자기대국 워커와 주고받는 메시지 테스트.

    python -m unittest discover -s trainer
"""

import unittest
from pathlib import Path

import numpy as np
import torch

from net import Net
from train import Pool, Worker, fresh_loss, unpack_game

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

    def test_match_against_rollout(self):
        r = self.pool.split({"cmd": "match", "opponent": "rollout", "oppSims": 20, "games": 6, "sims": 8}, uniform)
        self.assertEqual(sum(r["first"]) + sum(r["second"]), 6)

    def test_one(self):
        self.assertEqual(self.pool.one({"cmd": "solve"})["value"], 0)


if __name__ == "__main__":
    unittest.main()
