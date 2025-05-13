# Use official Bun image
FROM oven/bun:1.1.4

# Set working directory inside the container
WORKDIR /app

# Copy all project files into container
COPY . .

# Generate package.json automatically
RUN bun init -y

# Install elysia (Bun web framework)
RUN bun add elysia

# Optional: Install other dependencies here, e.g.
# RUN bun add another-package

# Expose port used in your Bun app (match this to Bun.serve port)
EXPOSE 3000

# Start the Bun app
CMD ["bun", "m10.ts"]
