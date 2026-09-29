# Cloud Artifact Management

当前实现从传输核心和三个服务骨架开始。服务使用 Node.js 24 LTS、Fastify、原生 ES Modules 和 Node.js 内置 SQLite。

## 本地验证

```bash
npm ci
npm test
```

## 启动服务

```bash
npm run start:edge   # 3101
npm run start:core   # 3102
npm run start:agent  # 3103
```

健康检查：`/health/live` 和 `/health/ready`。

## Docker 验证

```bash
docker compose build
docker compose up -d
curl http://127.0.0.1:3101/health/live
curl http://127.0.0.1:3102/health/live
curl http://127.0.0.1:3103/health/live
```

传输核心位于 `libs/cam-transfer`，包括清单生成、分块摘要、原子写入、合并校验和 SQLite 进度恢复。
