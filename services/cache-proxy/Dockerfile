# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /src

# Copy go.mod first. go.sum is intentionally NOT copied here because it is not
# committed to the repository. go mod tidy (run below after all source is
# present) generates go.sum from scratch and verifies the module graph.
# Once go.sum has been committed to source control, restore the canonical form:
#   COPY go.mod go.sum ./
#   RUN go mod download
COPY go.mod ./

# Copy the full source tree so go mod tidy can resolve all import paths.
COPY . .

# Generate go.sum and download verified module zips in one step.
# -e: continue past errors for packages that can't be resolved (tolerant mode).
RUN go mod tidy && go mod download

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w -X main.version=4.0.0" \
    -o /bin/cache-proxy ./cmd/server

# ── Stage 2: minimal runtime ──────────────────────────────────────────────────
FROM scratch

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /bin/cache-proxy /cache-proxy

EXPOSE 4000

ENTRYPOINT ["/cache-proxy"]
