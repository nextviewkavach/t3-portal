FROM oven/bun:1.1.4

WORKDIR /app

COPY . .

# Create package.json automatically
RUN bun init -y

# Install required dependencies
RUN bun add elysia @elysiajs/cors

EXPOSE 8000

CMD ["bun", "m10.ts"]
