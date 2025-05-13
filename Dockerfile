# Use a specific Bun image
FROM oven/bun:1.1.4

# Set the working directory
WORKDIR /app

# Copy only essential files first (for better caching)
COPY package.json bun.lockb /app/

# Install dependencies
RUN bun install

# Copy the rest of the application files
COPY . .

# Expose the application port
EXPOSE 8000

# Specify the default command
CMD ["bun", "m10.ts"]
