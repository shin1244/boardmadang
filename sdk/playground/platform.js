// 플랫폼이 게임에 주는 도구. 플레이그라운드와 실제 대국 화면이 같이 씁니다.
// 양쪽 브라우저가 같은 결과를 내야 하므로 이 파일을 고치면 대국 중인 두 사람의 버전이 같아야 합니다.

/** 시드로 만드는 결정적 난수 (mulberry32). 게임의 setup(rng)에 넘깁니다. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n) };
}

/** 상태 해시 (FNV-1a 32비트). 서버가 양쪽 화면이 같은지와 무시된 행동을 판단할 때 씁니다. */
export function hashOf(state) {
  const s = JSON.stringify(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
