# Stage 1: Build the Go app using Go 1.21
FROM golang:1.21-alpine AS builder

# Set environment variables for Go build
ENV CGO_ENABLED=0 \
    GOOS=linux \
    GOARCH=amd64 \
    GO111MODULE=on

# Set the working directory
WORKDIR /app

# Copy module files first (for caching dependencies)
COPY go.mod go.sum ./

# Download dependencies (fail with debug info if needed)
RUN go mod download || (cat go.mod && cat go.sum && exit 1)

# Copy the rest of the application source code
COPY . .

# Build the Go binary
RUN go build -o main .

# Stage 2: Minimal runtime image
FROM alpine:latest

# Install CA certificates for HTTPS support
RUN apk --no-cache add ca-certificates

# Create necessary persistent folders in Railway's mounted volume
RUN mkdir -p /mnt/data /mnt/logs /mnt/bills /mnt/backups

# Set working directory
WORKDIR /root/

# Copy binary from builder
COPY --from=builder /app/main .

# Expose the port your app runs on
EXPOSE 8080

# Command to run the app
CMD ["./main"]
