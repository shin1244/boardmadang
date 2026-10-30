# 레포 루트에서 빌드합니다. 서버와 함께 화면(web/), SDK 모듈(sdk/playground/), 게임(games/)을 넣습니다.
#   docker build -t boardmadang .
FROM golang:1.24 AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -o /out/server ./cmd/server
# 기보 폴더. 볼륨을 붙이면 이 폴더의 주인(nonroot)이 그대로 넘어가 쓸 수 있습니다.
RUN mkdir -p /out/data

# 셸도 패키지 관리자도 없는 최소 이미지라 공격 면이 작습니다.
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/server /server
COPY --from=build --chown=65532:65532 /out/data /data
# 화면과 게임 코드 (server/internal/site). 비공개 게임(games/private)은 .dockerignore로 뺍니다.
COPY web /site/web
COPY sdk/playground /site/sdk/playground
COPY games /site/games
ENV PORT=8080
ENV DATA_DIR=/data
ENV SITE_DIR=/site
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]
