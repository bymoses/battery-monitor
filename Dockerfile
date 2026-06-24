FROM oven/bun:1.2-slim

WORKDIR /app

COPY package.json tsconfig.json ./
RUN bun install --production

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3030 \
    HOST=0.0.0.0 \
    POLL_INTERVAL_SECONDS=30 \
    PROC_ROOT=/host/proc \
    SYS_POWER_SUPPLY=/host/sys/class/power_supply \
    DATA_DIR=/data

EXPOSE 3030

CMD ["bun", "run", "src/main.ts"]
