// 브라우저 AI의 신경망 (web/ai.js가 띄우는 Worker). 사이트 출처에서 돕니다.
//
// 탐색은 게임 코드 옆인 실행기 Worker(web/runner/host.js의 think)에서 돌고, 신경망만 여기서 돕니다.
// 실행기는 출처 없는 샌드박스라 WebAssembly(CSP에 wasm-unsafe-eval 없음)와 네트워크(connect-src 'none')가 막혀 있어서
// onnxruntime-web을 그 안에서 돌릴 수 없고, 그 정책은 풀지 않습니다. 학습할 때 selfplay.js와 train.py가 나눠 일하는 것과 같은 모양입니다.
// 주고받는 것은 관측(Float32Array)과 결과(행동 점수, 가치)뿐이라 게임 코드는 이 Worker에 다른 것을 시킬 수 없습니다.
//
// 메시지
//   화면 → 여기  { type: 'load', model: '/ai/<게임>/<해시>.onnx', shape: [채널, rows, cols] } → { type: 'ready' } 또는 { type: 'error', error }
//                { type: 'run', id, planes: Float32Array }                                → { id, logits: Float32Array, value } 또는 { id, error }
//
// onnxruntime-web은 web/vendor/package.json으로 받습니다 (npm --prefix web/vendor ci). WebAssembly판만 쓰고 스레드는 하나입니다
// (여러 스레드는 사이트가 cross-origin isolated여야 해서). 모델 파일 이름이 내용의 해시라 브라우저가 오래 캐시합니다.

import * as ort from './vendor/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs';

const MODEL_PATH = /^\/ai\/[a-z0-9-]{1,40}\/[0-9a-f]{16}\.onnx$/;

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let session = null;
let size = 0; // 관측 길이 (채널 × rows × cols)
let dims = null;
let queue = Promise.resolve(); // 계산은 하나씩

async function load(model, shape) {
  if (typeof model !== 'string' || !MODEL_PATH.test(model)) throw new Error('bad model path');
  if (!Array.isArray(shape) || shape.length !== 3 || !shape.every((n) => Number.isInteger(n) && n > 0 && n <= 256)) throw new Error('bad shape');
  const res = await fetch(model);
  if (!res.ok) throw new Error(`model: HTTP ${res.status}`);
  session = await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  dims = [1, ...shape];
  size = shape[0] * shape[1] * shape[2];
}

async function run(planes) {
  if (!session) throw new Error('no model');
  if (!(planes instanceof Float32Array) || planes.length !== size) throw new Error('bad observation');
  const out = await session.run({ x: new ort.Tensor('float32', planes, dims) });
  return { logits: Float32Array.from(out.logits.data), value: Number(out.value.data[0]) };
}

self.addEventListener('message', (e) => {
  const m = e.data;
  if (m?.type === 'load') {
    queue = queue.then(() => load(m.model, m.shape)).then(
      () => self.postMessage({ type: 'ready' }),
      (err) => self.postMessage({ type: 'error', error: String(err?.message ?? err) }),
    );
  } else if (m?.type === 'run') {
    queue = queue.then(() => run(m.planes)).then(
      (r) => self.postMessage({ id: m.id, ...r }, [r.logits.buffer]),
      (err) => self.postMessage({ id: m.id, error: String(err?.message ?? err) }),
    );
  }
});
