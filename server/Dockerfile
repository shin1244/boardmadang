FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/server ./cmd/server
# 기보 폴더. 볼륨을 붙이면 이 폴더의 주인(nonroot)이 그대로 넘어가 쓸 수 있습니다.
RUN mkdir -p /out/data

# 셸도 패키지 관리자도 없는 최소 이미지라 공격 면이 작습니다.
FROM gcr.io/distroless/static-debian12
COPY --from=build /out/server /server
COPY --from=build --chown=65532:65532 /out/data /data
ENV PORT=8080
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/server"]
