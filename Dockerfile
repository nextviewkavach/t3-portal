FROM golang:1.20-alpine AS builder

# Install build dependencies
RUN apk add --no-cache gcc musl-dev

# Set working directory
WORKDIR /app

# Copy go mod and sum files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy the source code
COPY . .

# Build with CGO enabled and special build tags for SQLite on Alpine
ENV CGO_ENABLED=1
RUN go build -tags "linux,musl" -o app .

# Final stage
FROM alpine:latest

# Install runtime dependencies
RUN apk add --no-cache ca-certificates tzdata libc6-compat

# Copy binary from builder
WORKDIR /app
COPY --from=builder /app/app .

# Create directories that might be needed
RUN mkdir -p /app/data /app/data/bills /app/data/logs /app/data/backups

# Set environment variables
ENV DATA_DIR=/app/data
ENV GIN_MODE=release

# Expose the port
EXPOSE 8080

# Run the application
CMD ["./app"]
