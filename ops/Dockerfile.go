# FilsPay settlement daemon (Go), multi-stage.
#
# Build in a full toolchain image, run in a slim base. cmd/settlement/main.go
# imports "time/tzdata", so the final stage needs no system tzdata package and
# the binary can run on distroless-style bases. The compose file launches the
# binary as ./settlement daemon, so it is installed at WORKDIR /app/settlement.

FROM golang:1.27-alpine AS build

WORKDIR /src

# Cache module downloads first (go.mod/go.sum only), then build.
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download

COPY apps/settlement ./apps/settlement

RUN CGO_ENABLED=0 go build -o /out/settlement ./apps/settlement/cmd/settlement

FROM alpine:3.20

WORKDIR /app
COPY --from=build /out/settlement /app/settlement

CMD ["./settlement", "daemon"]
