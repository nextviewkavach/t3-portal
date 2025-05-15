FROM debian:bullseye AS builder

# Install Go 1.20
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gcc \
    libc6-dev \
    make \
    && rm -rf /var/lib/apt/lists/*

# Install Go 1.20
ENV GO_VERSION=1.20.7
RUN curl -sSL https://golang.org/dl/go${GO_VERSION}.linux-amd64.tar.gz | tar -C /usr/local -xz
ENV PATH=$PATH:/usr/local/go/bin

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

# Final stage - using the same Debian version
FROM debian:bullseye

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Copy binary from builder
WORKDIR /app
COPY --from=builder /app/app .

# Create directories that might be needed
# Create data directories in both potential locations
RUN mkdir -p /data /data/bills /data/logs /data/backups
RUN mkdir -p /app/data /app/data/bills /app/data/logs /app/data/backups

# Set environment variables
ENV DATA_DIR=/data
ENV GIN_MODE=release

# Set permissions
RUN chmod -R 777 /data

# Expose the port
EXPOSE 8080

# Run the application
CMD ["./app"]
