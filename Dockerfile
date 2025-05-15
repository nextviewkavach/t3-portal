# Start from the official Go image
FROM golang:1.21-alpine

# Set environment variables
ENV GO111MODULE=on \
    CGO_ENABLED=0 \
    GOOS=linux \
    GOARCH=amd64

# Set the working directory inside the container
WORKDIR /app

# Copy go.mod and go.sum first (for caching dependencies)
COPY go.mod ./
COPY go.sum ./

# Download dependencies
RUN go mod download

# Copy the rest of the application
COPY . .

# Build the Go app
RUN go build -o main .

# Use a minimal base image to run the application
FROM alpine:latest  
RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binary from builder
COPY --from=0 /app/main .

# Expose port (if applicable)
EXPOSE 8080

# Command to run the application
CMD ["./main"]
