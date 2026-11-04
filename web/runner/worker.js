// 게임 코드를 돌리는 Worker (web/runner/frame.js가 게임마다 하나씩 띄웁니다). 하는 일은 host.js에 있습니다.
// 뜨자마자 hello를 보내서, frame.js가 Worker가 제대로 떴는지(브라우저가 막지 않았는지) 알 수 있게 합니다.

import { createHost } from './host.js';

// 게임 코드가 Worker를 또 띄우지 못하게 합니다. 안쪽 Worker는 부모가 거는 호출 시간 제한(engine.js)에 걸리지 않아서,
// 게임 함수는 바로 돌려주고 뒤에서 무한 루프를 돌려 상대와 관전자의 CPU를 대국 내내 쓸 수 있기 때문입니다.
// 게임 규칙은 순수 함수라 Worker가 필요 없고, Worker 안에는 다른 창이 없어서 지운 생성자를 다시 얻을 길이 없습니다.
// 게임 코드는 load에서 불러오므로 이 줄이 늘 먼저 돕니다.
for (const name of ['Worker', 'SharedWorker']) delete self[name];

const handle = createHost();

self.addEventListener('message', async (e) => {
  const reply = await handle(e.data);
  if (reply) self.postMessage(reply);
});

self.postMessage({ hello: true });
