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
curl http://127.0.0.1:8088/health/live
curl http://127.0.0.1:3102/health/live
curl http://127.0.0.1:3103/health/live
```

外部交换区的 `cam-edge` 通过 `hillstone-vpn` 的网络命名空间访问研发内网。首次部署时，需要在 Hillstone 管理界面完成 VPN 登录：

```text
http://127.0.0.1:18080/       # Hillstone Web 管理入口（目标主机本地）
http://127.0.0.1:16080/       # Hillstone noVNC 入口（目标主机本地）
```

登录完成并确认 VPN 隧道建立后，再启动或重试候选制品接收。Hillstone 配置和运行数据保存在 Compose 持久化卷中，VPN 凭据不写入 Git、镜像或 SQLite。

在开发机浏览器访问测试机上的 Hillstone，可运行 `tools\hillstone-vpn.cmd start -Detach`。脚本通过 SSH 控制测试机上的 `cam-hillstone-vpn` 容器，刷新动态路由，并将测试机本地绑定的管理端口映射到开发机：默认 noVNC 为 `16081`、Web 管理入口为 `18081`、SOCKS5 为 `11081`。关闭映射和远端容器运行 `tools\hillstone-vpn.cmd stop`，重建容器并刷新路由运行 `tools\hillstone-vpn.cmd restart`，查看容器、路由和映射状态运行 `tools\hillstone-vpn.cmd status`，测试研发文件地址运行 `tools\hillstone-vpn.cmd target-test`。不带参数执行 `.cmd` 文件会进入交互菜单。如 SSH 用户、地址、端口或远端项目目录不同，可设置 `CAM_HILLSTONE_SSH_USER`、`CAM_HILLSTONE_SSH_HOST`、`CAM_HILLSTONE_SSH_PORT`、`CAM_HILLSTONE_REMOTE_DIR` 环境变量。

测试机需要安装 `deploy/cam-hillstone-route.service`。该服务调用 `deploy/cam-hillstone-route.sh`，运行时动态查询 Compose 网络 ID、对应的 `br-xxxx` 网桥和 Hillstone 容器 IP，再安装研发文件网段路由。默认只安装 `172.22.5.177/32`，可通过 `CAM_HILLSTONE_ROUTE_TARGETS` 扩展目标；不把网桥名或容器 IP 固定写入配置。安装命令为：

CAM 专用 Docker 网络默认使用 `192.168.240.0/24`，避开测试机已有的 `172.20.0.0/16`、`172.21.0.0/16` 和 `172.22.0.0/16`。如部署环境已有该网段，可在 `.env` 中设置 `CAM_DOCKER_SUBNET` 为其他未占用的专用网段。

```bash
cd cloud-artifact-management/deploy
sudo sh ./install-hillstone-route.sh
```

安装脚本同时把 legacy netfilter 模块写入 `/etc/modules-load.d/cam-hillstone-netfilter.conf` 并立即加载，保证 Hillstone 使用原生 `iptables-legacy` 入口。宿主机重启后由 `systemd-modules-load` 自动恢复这些模块。

传输核心位于 `libs/cam-transfer`，包括清单生成、分块摘要、原子写入、合并校验和 SQLite 进度恢复。
