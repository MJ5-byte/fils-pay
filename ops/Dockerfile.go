# Image for the settlement service (apps/settlement) in
# ops/docker-compose.yml. Multi-stage: build the binary with the Go
# toolchain, then ship only the binary on a small runtime base.
#
# Go 1.22 matches apps/settlement/go.mod.

# Build stage. Download modules first (cached while go.mod/go.sum are
# unchanged), then compile the single command. CGO is off so the result is
# a static binary that runs on the slim runtime base below; cmd/settlement
# already embeds the IANA zoneinfo (time/tzdata), so no OS tzdata is needed.
FROM golang:1.22-bookworm AS build
WORKDIR /src
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
RUN CGO_ENABLED=0 go build -o /out/settlement ./cmd/settlement

# Runtime stage. Only the compiled binary ships. The compose command runs
# it as ./settlement <subcommand> (daemon on the box).
FROM alpine:3.20 AS runtime
WORKDIR /app
COPY --from=build /out/settlement ./settlement
# Run as an unprivileged user; the static binary needs nothing it owns.
RUN addgroup -S app && adduser -S -G app app
USER app
CMD ["./settlement", "daemon"]
