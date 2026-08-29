# Dockerfile — 检验业务现场作业系统
#
# 多阶段 build：
#   1) deps:    装 pnpm + 依赖（better-sqlite3 在此阶段编译）
#   2) builder: tsc + vite build 产出 dist/
#   3) runner:  只复制 dist/ + package.json + qrcode.jpg + scripts/demo.sh
#
# 镜像运行：docker compose up → 容器内 listen :4000（HTTP API + 静态 SPA） → 浏览器 :4000
# 数据通过 ./data 与 ./logs 卷挂载到容器，SQLite + NDJSON 持久化到宿主机。

# ---- Stage 1: deps ----
FROM node:20-alpine AS deps
WORKDIR /app

# 启用 corepack + pnpm（与 README/package.json engines 对齐）
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# 先复制 lockfile 最大化缓存命中
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./

# 装依赖（含 dev deps，better-sqlite3 需要编译）
RUN pnpm install --frozen-lockfile --include=dev

# ---- Stage 2: builder ----
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# tsc + vite build（输出 dist/server/main.js + dist/cli/index.js + dist/app/**）
RUN pnpm run build

# ---- Stage 3: runner ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV DATABASE_PATH=data/lab.db
ENV LIS_WRITEBACK_CHANNEL=data/lis-writeback.ndjson

# 仅装 runtime 依赖（不引 dev deps，better-sqlite3 预编译二进制）
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# 复制 build 产物 + 必要文件
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/qrcode.jpg ./qrcode.jpg
COPY --from=builder /app/scripts/demo.sh ./scripts/demo.sh
COPY --from=builder /app/src/server/migrations ./src/server/migrations
COPY --from=builder /app/examples/manifests ./examples/manifests
COPY --from=builder /app/.env.example ./.env.example

# 数据目录（挂 volume 持久化）
RUN mkdir -p /app/data /app/logs
VOLUME ["/app/data", "/app/logs"]

EXPOSE 4000

# 健康检查：检查 /api/instruments 是否返回 200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4000/api/instruments || exit 1

# 入口：HTTP server（dist/server/main.js 由 tsc 编译 src/server/main.ts 产出）
# 提供 /api（REST）+ 静态 SPA；vite dev 仅用于本地开发
CMD ["sh", "-c", "node dist/server/main.js"]