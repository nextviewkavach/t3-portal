FROM golang:1.20 AS builder

# Set working directory
WORKDIR /app

# Copy go mod and sum files
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy the source code
COPY . .

# Build with CGO enabled
ENV CGO_ENABLED=1
RUN go build -o app .

# Final stage - using Debian instead of Alpine to avoid musl libc issues
FROM debian:bullseye-slim

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

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
