# FilsPay settlement daemon (Go), multi-stage.
#
# Build in a full toolchain image, run in a slim base. cmd/settlement/main.go
# imports "time/tzdata", so the final stage needs no system tzdata package and
# the binary can run on distroless-style bases. The compose file launches the
# binary as ./settlement daemon, so it is installed at WORKDIR /app/settlement.

FROM golang:1.27-alpine AS build

# The module root is apps/settlement itself (go.mod lives there) — make it
# the WORKDIR so `go build ./cmd/settlement` resolves in-tree.
WORKDIR /src/apps/settlement

# Cache module downloads first (go.mod/go.sum only), then build.
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download

COPY apps/settlement ./

RUN CGO_ENABLED=0 go build -o /out/settlement ./cmd/settlement

FROM alpine:3.20

WORKDIR /app
COPY --from=build /out/settlement /app/settlement

CMD ["./settlement", "daemon"]
