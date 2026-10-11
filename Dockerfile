# The deploy image (compose.prod.yml): the checkout, with production
# dependencies installed. One image serves migrate, api and mcp; the compose
# file picks the entrypoint per service.
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY db ./db
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./
EXPOSE 3000 3001
CMD ["bun", "src/api/serve.ts"]
