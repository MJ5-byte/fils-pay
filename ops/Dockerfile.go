# Image for apps/settlement (Go settlement worker and CLI).
# Build context is the repository root (see ops/docker-compose.yml), e.g.:
#   docker build -f ops/Dockerfile.go -t filspay-settlement .
# Run: docker run --rm -e DATABASE_URL=... -e SETTLEMENT_INTERNAL_TOKEN=... filspay-settlement
# Other subcommands: docker run --rm ... filspay-settlement ./settlement <subcommand>

FROM golang:1.22-alpine AS build
WORKDIR /src

# Download modules first so they are cached across source-only changes.
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download

COPY apps/settlement/ ./
# Static binary: no cgo, so it runs on a distroless base. Asia/Bahrain tzdata
# is compiled in by cmd/settlement (import _ "time/tzdata").
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/settlement /app/settlement
USER nonroot:nonroot
# Internal API (SETTLEMENT_INTERNAL_PORT); only `daemon` serves it.
EXPOSE 8091
# No ENTRYPOINT: docker-compose.yml overrides with ["./settlement", "daemon"].
CMD ["./settlement", "daemon"]
