"""정책·가치 신경망 (AlphaZero).

완전 합성곱 구조라 보드 크기와 상관없이 같은 코드를 씁니다.
- 입력: selfplay.js가 펼친 [채널][rows][cols]에 "판 안" 채널(전부 1)을 하나 더 붙입니다. 가장자리를 알아보게 하려고요.
- 정책: 칸마다 1x1 합성곱으로 클릭 점수, 특수 행동은 판 전체를 평균·최댓값으로 모은 특징에서 점수.
- 가치: 판 전체를 모은 특징 → 둘 차례인 쪽 기준 -1~1.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F


class ResBlock(nn.Module):
    def __init__(self, filters):
        super().__init__()
        self.c1 = nn.Conv2d(filters, filters, 3, padding=1, bias=False)
        self.b1 = nn.BatchNorm2d(filters)
        self.c2 = nn.Conv2d(filters, filters, 3, padding=1, bias=False)
        self.b2 = nn.BatchNorm2d(filters)

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return F.relu(x + y)


def head(filters, out):
    return nn.Sequential(nn.Conv2d(filters, out, 1, bias=False), nn.BatchNorm2d(out), nn.ReLU())


def pool(x):
    """판 전체를 평균과 최댓값으로 모읍니다 (보드 크기와 상관없는 특징)"""
    return torch.cat([x.mean((2, 3)), x.amax((2, 3))], 1)


class Net(nn.Module):
    def __init__(self, channels, specials, blocks=4, filters=64):
        super().__init__()
        self.config = {"channels": channels, "specials": specials, "blocks": blocks, "filters": filters}
        self.stem = nn.Sequential(
            nn.Conv2d(channels + 1, filters, 3, padding=1, bias=False), nn.BatchNorm2d(filters), nn.ReLU()
        )
        self.trunk = nn.Sequential(*[ResBlock(filters) for _ in range(blocks)])
        self.policy = head(filters, 32)
        self.click = nn.Conv2d(32, 1, 1)
        self.special = nn.Linear(64, specials) if specials else None
        self.value = head(filters, 32)
        self.value_fc = nn.Sequential(nn.Linear(64, 64), nn.ReLU(), nn.Linear(64, 1))

    def forward(self, x):
        x = torch.cat([x, torch.ones_like(x[:, :1])], 1)
        h = self.trunk(self.stem(x))
        p = self.policy(h)
        logits = self.click(p).flatten(1)  # row * cols + col 순서 (selfplay.js의 행동 번호와 같음)
        if self.special is not None:
            logits = torch.cat([logits, self.special(pool(p))], 1)
        v = torch.tanh(self.value_fc(pool(self.value(h)))).squeeze(1)
        return logits, v
