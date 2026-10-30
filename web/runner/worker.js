// 게임 코드를 돌리는 Worker (web/runner/frame.js가 게임마다 하나씩 띄웁니다). 하는 일은 host.js에 있습니다.
// 뜨자마자 hello를 보내서, frame.js가 Worker가 제대로 떴는지(브라우저가 막지 않았는지) 알 수 있게 합니다.

import { createHost } from './host.js';

const handle = createHost();

self.addEventListener('message', async (e) => {
  const reply = await handle(e.data);
  if (reply) self.postMessage(reply);
});

self.postMessage({ hello: true });
