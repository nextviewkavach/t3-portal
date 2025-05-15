# Stage 1: Build the Go application using Go 1.21
FROM golang:1.21-alpine AS builder

# Set environment variables for Go build
ENV GO111MODULE=on \
    CGO_ENABLED=0 \
    GOOS=linux \
    GOARCH=amd64

# Set the working directory
WORKDIR /app

# Copy go.mod and go.sum (if they exist) and download dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy the rest of the application
COPY . .

# Build the Go binary
RUN go build -o main .

# Stage 2: Create a minimal image to run the app
FROM alpine:latest

# Install CA certificates for HTTPS support
RUN apk --no-cache add ca-certificates

# Create necessary persistent folders under /mnt (Railway persistent volume mount)
RUN mkdir -p /mnt/data /mnt/logs /mnt/bills /mnt/backups

# Set working directory for runtime
WORKDIR /root/

# Copy the compiled Go binary from builder
COPY --from=builder /app/main .

# Expose the port your app runs on
EXPOSE 8080

# Run the binary
CMD ["./main"]
