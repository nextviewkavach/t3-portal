# Use latest Bun image
FROM oven/bun:1.1.13

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN bun install

# Copy application code
COPY . .

# Create directory structure for the volume
RUN mkdir -p /app/data/uploads

# Set environment variables
ENV PORT=8000
ENV DATABASE_FILE_PATH=/app/data/portal.db
ENV UPLOADS_DIR=/app/data/uploads

# Expose port 8000
EXPOSE 8000

# Start the application
CMD ["bun", "run", "start"]
