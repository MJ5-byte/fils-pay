# Multi-stage build of apps/settlement (see ops/README.md).
# Build context is the repo root (docker-compose.yml uses `context: ..`).
FROM golang:1.22 AS build

WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download

COPY apps/settlement/ ./
# Static binary so it runs on a tiny base image. main.go imports time/tzdata,
# so Asia/Bahrain works without OS timezone files.
RUN CGO_ENABLED=0 go build -o /out/settlement ./cmd/settlement

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/settlement ./settlement
# docker-compose.yml runs: ./settlement daemon
CMD ["./settlement", "daemon"]
