# Use the official Bun image
FROM oven/bun:1.1.4

# Set working directory
WORKDIR /app

# Copy all project files
COPY . .

# Install dependencies (if any)
RUN bun install

# Expose the port Bun is using
EXPOSE 3000

# Start the Bun server
CMD ["bun", "m10.ts"]
