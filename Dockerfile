# Stage 1: Build the Go app using Go 1.21 (Debian base)
FROM golang:1.21 AS builder

ENV CGO_ENABLED=0 \
    GOOS=linux \
    GOARCH=amd64 \
    GO111MODULE=on

WORKDIR /app

COPY go.mod go.sum ./

# Show go.mod and go.sum if download fails
RUN go mod download || (echo "--- go.mod ---" && cat go.mod && echo "--- go.sum ---" && cat go.sum && exit 1)

COPY . .

RUN go build -o main .

# Stage 2: Minimal image
FROM alpine:latest

RUN apk --no-cache add ca-certificates

RUN mkdir -p /mnt/data /mnt/logs /mnt/bills /mnt/backups

WORKDIR /root/

COPY --from=builder /app/main .

EXPOSE 8080

CMD ["./main"]
