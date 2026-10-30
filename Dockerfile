# 보드마당 서버 이미지. 레포 루트에서 빌드합니다: docker build -t boardmadang .
# 서버 하나가 API, 웹소켓, 화면(web/), 게임 코드(games/), SDK(sdk/)를 모두 맡습니다.
FROM golang:1.24 AS build
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/server ./cmd/server
# 기보 폴더. 볼륨을 붙이면 이 폴더의 주인(nonroot)이 그대로 넘어가 쓸 수 있습니다.
RUN mkdir -p /out/data

# 셸도 패키지 관리자도 없는 최소 이미지라 공격 면이 작습니다.
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/server /server
COPY --from=build --chown=65532:65532 /out/data /data
# 화면과 게임 코드. 서버는 이 세 폴더만 보여줍니다 (internal/site).
COPY web/ /site/web/
COPY sdk/ /site/sdk/
COPY games/ /site/games/
ENV PORT=8080
ENV DATA_DIR=/data
ENV SITE_DIR=/site
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]
