FROM oven/bun:1.3-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build:client

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3456 \
    TAPO_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3456') + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/server/index.ts"]
