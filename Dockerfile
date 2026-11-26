# 레포 루트에서 빌드합니다. 서버와 함께 화면(web/), SDK 모듈(sdk/playground/, sdk/check.js), 게임(games/),
# 브라우저 AI가 쓰는 학습 도구 두 파일(trainer/env.js, mcts.js)과 onnxruntime-web, 방문 통계의 나라 파일(DB-IP)을 넣습니다.
#   docker build -t boardmadang .
FROM golang:1.24 AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -o /out/server ./cmd/server
# 기보 폴더. 볼륨을 붙이면 이 폴더의 주인(nonroot)이 그대로 넘어가 쓸 수 있습니다.
RUN mkdir -p /out/data

# 브라우저 AI의 신경망을 돌리는 onnxruntime-web (web/vendor/package.json의 고정 버전). 레포에는 넣지 않고 빌드할 때 받습니다
FROM node:22-slim AS vendor
WORKDIR /vendor
COPY web/vendor/package.json web/vendor/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# 방문 통계의 나라별 수에 쓰는 DB-IP의 IP to Country Lite (CC BY 4.0, https://db-ip.com, server/internal/geo).
# 빌드할 때마다 그달 파일을 받습니다. 매달 초에 새 파일이 나오므로 이번 달 것이 아직 없으면 지난달 것을 받습니다.
# 받지 못해도 빌드는 계속합니다. 그러면 서버가 나라 없이 세고 운영자 화면에 그렇게 나옵니다.
FROM golang:1.24 AS geo
WORKDIR /geo
RUN for m in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"; do \
      curl -fsSL --retry 3 -o dbip-country-lite.csv.gz "https://download.db-ip.com/free/dbip-country-lite-$m.csv.gz" \
        && gzip -t dbip-country-lite.csv.gz && break; \
      rm -f dbip-country-lite.csv.gz; \
    done; \
    if [ -s dbip-country-lite.csv.gz ]; then ls -l; else echo "경고: DB-IP 나라 파일을 받지 못했습니다. 방문을 나라 없이 셉니다"; fi

# 셸도 패키지 관리자도 없는 최소 이미지라 공격 면이 작습니다.
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/server /server
COPY --from=build --chown=65532:65532 /out/data /data
# 화면과 게임 코드 (server/internal/site). 비공개 게임(games/private)은 .dockerignore로 뺍니다.
COPY web /site/web
COPY sdk/playground /site/sdk/playground
# 등록창이 올린 게임을 실행기 안에서 검사할 때 씁니다 (site.sdkModules)
COPY sdk/check.js /site/sdk/check.js
# 브라우저 AI: 실행기 안에서 학습할 때와 같은 관측과 탐색을 쓰고(site.modules), 신경망은 WebAssembly판 세 파일로 돌립니다 (site.vendorFiles)
COPY trainer/env.js trainer/mcts.js /site/trainer/
COPY --from=vendor /vendor/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs /vendor/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs /vendor/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm /site/web/vendor/node_modules/onnxruntime-web/dist/
COPY games /site/games
COPY --from=geo /geo /geo
ENV PORT=8080
ENV DATA_DIR=/data
ENV SITE_DIR=/site
ENV GEO_FILE=/geo/dbip-country-lite.csv.gz
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]
