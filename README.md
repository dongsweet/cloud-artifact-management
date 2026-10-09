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
cp deploy/.env.example deploy/.env
set -a; . deploy/.env; set +a
sudo -E sh deploy/init-data-directories.sh
docker compose build
docker compose up -d
curl http://127.0.0.1:8088/health/live
curl http://127.0.0.1:3102/health/live
curl http://127.0.0.1:3103/health/live
```

测试机暂时不使用 Hillstone 时，使用直连覆盖文件启动外部交换区页面和 API：

```bash
docker compose -f compose.direct.yaml up -d --build
```

该命令只解除 `cam-edge` 对 Hillstone 网络命名空间的依赖，不会删除业务数据目录。

`CAM_EDGE_DATA_DIR`、`CAM_CORE_DATA_DIR` 和 `CAM_AGENT_DATA_DIR` 是宿主机本地目录，分别保存
各安全区的 SQLite 数据库和制品文件。容器只把这些目录绑定到 `/data`，业务数据不再存放在
Docker volume 中。升级镜像或重建容器前先执行 `sudo -E sh deploy/init-data-directories.sh`。

SQLite 文件位于 `${CAM_EDGE_DATA_DIR}/edge/edge.sqlite`、`${CAM_CORE_DATA_DIR}/core/core.sqlite`
和 `${CAM_AGENT_DATA_DIR}/agent/agent.sqlite`。SQLite 的 WAL、SHM 和制品目录同样位于对应
本地目录中。备份时应停止写入或停止对应服务后整体备份目录，不能只复制主 `.sqlite` 文件。

外部交换区的 `cam-edge` 通过 `hillstone-vpn` 的网络命名空间访问研发内网。首次部署时，需要在 Hillstone 管理界面完成 VPN 登录：

```text
http://127.0.0.1:18080/       # Hillstone Web 管理入口（目标主机本地）
http://127.0.0.1:16080/       # Hillstone noVNC 入口（目标主机本地）
```

登录完成并确认 VPN 隧道建立后，再启动或重试候选制品接收。Hillstone 配置和运行数据保存在 Compose 持久化卷中，VPN 凭据不写入 Git、镜像或 SQLite。

在开发机浏览器访问测试机上的 Hillstone，可运行 `tools\hillstone-vpn.cmd start -Detach`。脚本通过 SSH 控制测试机上的 `cam-hillstone-vpn` 容器，刷新动态路由，并将测试机本地绑定的管理端口映射到开发机：默认 noVNC 为 `16081`、Web 管理入口为 `18081`、SOCKS5 为 `11081`。关闭映射和远端容器运行 `tools\hillstone-vpn.cmd stop`，重建容器并刷新路由运行 `tools\hillstone-vpn.cmd restart`，查看容器、路由和映射状态运行 `tools\hillstone-vpn.cmd status`，测试研发文件地址运行 `tools\hillstone-vpn.cmd target-test`。不带参数执行 `.cmd` 文件会进入交互菜单。如 SSH 用户、地址、端口或远端项目目录不同，可设置 `CAM_HILLSTONE_SSH_USER`、`CAM_HILLSTONE_SSH_HOST`、`CAM_HILLSTONE_SSH_PORT`、`CAM_HILLSTONE_REMOTE_DIR` 环境变量。

测试机需要安装 `deploy/cam-hillstone-route.service`。该服务调用 `deploy/cam-hillstone-route.sh`，运行时动态查询 Compose 网络 ID、对应的 `br-xxxx` 网桥和 Hillstone 容器 IP，再安装研发文件主机路由。默认目标为 `172.22.5.177/32` 和 `172.22.5.66/32`，须与 `CAM_SOURCE_ALLOWLIST` 中的 IP 地址保持一致；可通过 `CAM_HILLSTONE_ROUTE_TARGETS` 增减目标。不把网桥名或容器 IP 固定写入配置。安装命令为：

CAM 专用 Docker 网络默认使用 `192.168.240.0/24`，避开测试机已有的 `172.20.0.0/16`、`172.21.0.0/16` 和 `172.22.0.0/16`。如部署环境已有该网段，可在 `.env` 中设置 `CAM_DOCKER_SUBNET` 为其他未占用的专用网段。

直连测试模式下，如果宿主机其他 Docker 网络占用了研发文件服务器所在的大网段（例如 `172.22.0.0/16`），需要安装 `deploy/install-cam-source-route.sh`。该服务为 `CAM_SOURCE_ALLOWLIST` 中每个研发文件服务器 IP 安装精确 `/32` 路由，动态使用宿主机默认网关和网卡，避免被 Docker 大网段路由截获；新增 allowlist IP 时必须同步增加对应路由目标。该服务只适用于 `compose.direct.yaml`；使用 Hillstone VPN 时应使用 `cam-hillstone-route.service`，不要同时安装两套到同一目标的路由服务。

`CAM_SOURCE_ALLOWLIST` 按研发地址的主机名或 IP 匹配，忽略 URL 端口。例如 `http://172.22.5.66:9090/path/file.zip` 的 allowlist 项写 `172.22.5.66`，路由目标写 `172.22.5.66/32`；端口由 URL 和网络访问控制策略决定，不写入路由。

```bash
cd cloud-artifact-management/deploy
sudo sh ./install-hillstone-route.sh
```

安装脚本同时把 legacy netfilter 模块写入 `/etc/modules-load.d/cam-hillstone-netfilter.conf` 并立即加载，保证 Hillstone 使用原生 `iptables-legacy` 入口。宿主机重启后由 `systemd-modules-load` 自动恢复这些模块。

正式环境部署前必须确认宿主机支持 `ip_tables`、`iptable_filter`、`iptable_nat`、`iptable_mangle` 和 `/dev/net/tun`。不能只根据容器的 `healthy` 判断 VPN 在线；登录 noVNC 后还要确认 Hillstone 页面显示在线、容器内 `tun0` 为 UP，并能访问研发文件地址。

传输核心位于 `libs/cam-transfer`，包括清单生成、分块摘要、原子写入、合并校验和 SQLite 进度恢复。
