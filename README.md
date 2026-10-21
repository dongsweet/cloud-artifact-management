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

外部交换区 API 已启用 Core 统一登录及角色权限，不再允许匿名访问业务接口。部署后通过容器交互终端创建初始 Core 系统管理员，再从页面登录；账号创建、角色分配、禁用和密码重置只允许 Core 安全管理员执行。初始化、HTTPS/Cookie 配置及下载交付方式见 [外部交换区账号及下载交付](docs/edge-accounts.md)。

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
docker compose --env-file deploy/.env -f compose.direct.yaml up -d --build
```

该命令只解除 `cam-edge` 对 Hillstone 网络命名空间的依赖，不会删除业务数据目录。

测试环境复用已有 host-network Caddy 提供 HTTPS 时，`cam-edge-web` 和 `cam-core` 仅绑定宿主机
回环地址，分别为 `127.0.0.1:8088`、`127.0.0.1:3102` 和 `127.0.0.1:8092`。将
[`deploy/caddy-cam-sites.Caddyfile`](deploy/caddy-cam-sites.Caddyfile) 中的站点块合并进现有
Caddyfile，并保留其全局 DNS Challenge 配置。浏览器入口为
`https://cam-edge.cexp.cn:24443`、`https://cam-core.cexp.cn:24443`、
`https://cam-ag1.cexp.cn:24443` 和 `https://cam-ag2.cexp.cn:24443`。两个 Agent 域名分别
反向代理到宿主机回环端口 3111、3112；Core 域名的页面请求
转发到 `cam-core-web`，API 请求转发到 `cam-core`；网闸联动 API 仍由 Core 的受控接口身份
校验。不要将 core 的 3102 端口绑定到
`0.0.0.0`。

内网审批页面由独立的 `cam-core-web` 容器提供，测试部署仅绑定 `127.0.0.1:8092`；Caddy 将
`cam-core.cexp.cn` 的页面请求转发到该容器，API 请求仍转发到 `cam-core:3102`。首次部署 Core
时，在测试机交互终端执行以下命令创建本地管理员，页面登录后必须修改初始密码：

```bash
docker compose --env-file deploy/.env -f compose.direct.yaml exec -it cam-core node apps/cam-core/src/bootstrap-admin.js
```

Core 账号和会话保存在内网 Core 自己的 SQLite 文件；Edge 不保存本地账号，只缓存 Core 下发的 Edge 授权和短期会话。AAA 接入由 Core 实时认证适配器负责，不改变审批业务页面。

`CAM_EDGE_DATA_DIR`、`CAM_CORE_DATA_DIR`、`CAM_AGENT_1_DATA_DIR` 和 `CAM_AGENT_2_DATA_DIR` 是宿主机本地目录，分别保存
各安全区的 SQLite 数据库和制品文件。两个 Agent 使用独立数据目录，容器只把这些目录绑定到 `/data`，业务数据不再存放在
Docker volume 中。升级镜像或重建容器前先执行 `sudo -E sh deploy/init-data-directories.sh`。

`cam-core` 对接统一云管时，先将 `deploy/.env.example` 复制为目标主机的 `deploy/.env`，再使用同一个环境文件启动 Compose：

Core 与 Agent 的应用接口采用双向 Ed25519 签名。首次配对时，在 Core 的“Agent 管理”页面复制“Core 服务公钥”，登录各 Agent 的“Core 身份配对”页面，在顶部“Core 对接配置”填写 Core 地址并粘贴完整 PEM 公钥，点击“保存配置”和“测试配对”。随后复制 Agent 本机公钥到 Core 登记；Agent 首次以公钥指纹发起签名请求后，Core 会返回稳定 Agent 编号并显示在 Agent 页面，无需配置部署变量；旧部署已有的编号变量只作为兼容回填，成功同步后不再依赖。两个 Agent 共用 Core 公钥；每个 Agent 的私钥仍各自保存在本机独立数据目录。缺少 Core 公钥时不会发起业务请求，签名验证失败时拒绝处理响应。

Agent 页面保存的 Core 地址和信任公钥持久化到本机 `agent.sqlite`，立即生效，重启后优先于环境变量。`CAM_CORE_URL`、`CAM_CORE_PUBLIC_KEY` / `CAM_CORE_PUBLIC_KEY_B64` 及旧公钥过渡变量保留为部署默认值；页面保存之后仅改环境变量不会覆盖已保存配置。定时刷新不会覆盖正在编辑的内容。

Core 服务密钥轮换可在 Core 的 Agent 管理页面执行（接口 `POST /api/v1/agent-service-identity/rotate`），会先暂存新身份，仍由当前身份签署轮换提案。各 Agent 下次主动连接时自动验证并保存新公钥、回传签名确认；Core 收齐所有未禁用 Agent 的确认后提前切换，最多等待配置的旧身份过渡期，超时后启用新身份并跳过未上线 Agent。离线 Agent 在截止时间前恢复后继续协商；超时后重新接入的未确认 Agent 需管理员重新配对。原公钥默认只读；替换时自动保留已信任旧公钥，到期后不再接受旧签名。密钥文件必须和 Core 数据一起持久保存，丢失时按身份重置流程重新分发公钥。

```bash
cp deploy/.env.example deploy/.env
${EDITOR:-vi} deploy/.env
docker compose --env-file deploy/.env up -d --build cam-core
```

云管的接口基地址、服务身份和密钥只配置在目标主机的 `deploy/.env`；具体 EOMS 接口路径固定在 `cam-core` 代码中，不作为环境配置项。工单级别、来源、业务类型、所属中心、运维团队和审批处理人用户名在 Core 的云管对接配置页填写。管理员测试并保存配置时，`cam-core` 从当前云管环境解析名称对应的数字 ID，并将输入项和解析结果持久化到内网 SQLite；创建工单时复用已保存的 ID，同时在审批记录中留存实际使用的映射快照。云管字典或人员关系调整后，重新测试并保存配置即可刷新映射。

验证报告提交采用持久化 outbox 队列。Edge 先把审批信封原子写入 `exchange/outbox/approval-requests/` 并写入 SQLite，再通过配置的 Core 控制映射地址自动投递；请求使用当前网闸共享密钥认证，投递失败会按退避策略重试，服务重启后继续处理。Core 接收后按 `requestId` 幂等处理，并自动调用云管创建工单；云管暂时不可用时，Core 自行按持久重试计划重新提交，不依赖 Edge 查询或触发。Core 轮询到云管审批结果后，再通过受共享密钥保护的回告接口主动通知 Edge；Edge 仅显示申请是否已进入内网以及通过/驳回结果，不展示云管工单号、云管进度或 Core 内部错误。

SQLite 文件位于 `${CAM_EDGE_DATA_DIR}/edge/edge.sqlite`、`${CAM_CORE_DATA_DIR}/core/core.sqlite`
和 `${CAM_AGENT_1_DATA_DIR}/agent/agent.sqlite`、`${CAM_AGENT_2_DATA_DIR}/agent/agent.sqlite`。SQLite 的 WAL、SHM 和制品目录同样位于对应
本地目录中。备份时应停止写入或停止对应服务后整体备份目录，不能只复制主 `.sqlite` 文件。

测试机通过现有 EasyConnect 访问 VPN 内的测试云管时，`cam-core` 保持在自己的 CAM Docker
网络中，不加入 cloud-growth 网络，也不经过应用层代理。由测试机上的
`cloud-service-new-content/tools/easyconnect-vpn.ps1 route-on` 按容器源地址启用策略路由，
把 cloud-growth 与 `cam-core` 发往 `100.64.0.0/10` 的流量交给 EasyConnect。该网段已包含
测试云管地址 `100.127.2.0/24`。此配置只用于测试环境，不属于正式部署配置。

测试机更新 `cam-core` 时使用常规直连部署文件：

```bash
docker compose --env-file deploy/.env -f compose.direct.yaml up -d --build cam-core
```

容器重建或 IP 变化后，需要重新运行外部脚本的 `route-on`，更新来源 IP 规则。确认方式：

```bash
tools\\easyconnect-vpn.cmd route-status
docker exec cloud-artifact-management-cam-core-1 node -e "fetch('https://token.sgwan.cn').then(r => console.log(r.status)).catch(e => { console.error(e); process.exit(1) })"
```

外部交换区的 `cam-edge` 通过 `hillstone-vpn` 的网络命名空间访问研发内网。首次部署时，需要在 Hillstone 管理界面完成 VPN 登录：

```text
http://127.0.0.1:18080/       # Hillstone Web 管理入口（目标主机本地）
http://127.0.0.1:16080/       # Hillstone noVNC 入口（目标主机本地）
```

登录完成并确认 VPN 隧道建立后，再启动或重试候选制品接收。Hillstone 配置和运行数据保存在 Compose 持久化卷中，VPN 凭据不写入 Git、镜像或 SQLite。

在开发机浏览器访问测试机上的 Hillstone，可运行 `tools\hillstone-vpn.cmd start -Detach`。脚本通过 SSH 控制测试机上的 `cam-hillstone-vpn` 容器，刷新动态路由，并将测试机本地绑定的管理端口映射到开发机：默认 noVNC 为 `16081`、Web 管理入口为 `18081`、SOCKS5 为 `11081`。关闭映射和远端容器运行 `tools\hillstone-vpn.cmd stop`，重建容器并刷新路由运行 `tools\hillstone-vpn.cmd restart`，查看容器、路由和映射状态运行 `tools\hillstone-vpn.cmd status`，测试研发文件地址运行 `tools\hillstone-vpn.cmd target-test`。不带参数执行 `.cmd` 文件会进入交互菜单。如 SSH 用户、地址、端口或远端项目目录不同，可设置 `CAM_HILLSTONE_SSH_USER`、`CAM_HILLSTONE_SSH_HOST`、`CAM_HILLSTONE_SSH_PORT`、`CAM_HILLSTONE_REMOTE_DIR` 环境变量。

直连部署的路由服务读取项目 `.env` 中的 `CAM_SOURCE_ALLOWLIST`，为其中每个主机名解析出的 IPv4 地址安装精确 `/32` 路由。路由目标不再单独配置，避免 allowlist 与路由目标不一致；新增或删除来源时只需修改 `.env` 后重启服务。安装命令为：

CAM 专用 Docker 网络默认使用 `192.168.240.0/24`，避开测试机已有的 `172.20.0.0/16`、`172.21.0.0/16` 和 `172.22.0.0/16`。如部署环境已有该网段，可在 `.env` 中设置 `CAM_DOCKER_SUBNET` 为其他未占用的专用网段。

如果宿主机其他 Docker 网络占用了研发文件服务器所在的大网段（例如 `172.22.0.0/16`），需要安装 `deploy/install-cam-source-route.sh`。该服务动态使用宿主机默认网关和网卡，为 `.env` 中 `CAM_SOURCE_ALLOWLIST` 的每个地址安装精确 `/32` 路由，避免被 Docker 大网段路由截获。

`CAM_SOURCE_ALLOWLIST` 按研发地址的主机名或 IP 匹配，忽略 URL 端口。例如 `http://172.22.5.66:9090/path/file.zip` 的 allowlist 项写 `172.22.5.66`，路由目标写 `172.22.5.66/32`；端口由 URL 和网络访问控制策略决定，不写入路由。

```bash
cd cloud-artifact-management/deploy
sudo sh ./install-cam-source-route.sh
```

安装脚本同时把 legacy netfilter 模块写入 `/etc/modules-load.d/cam-hillstone-netfilter.conf` 并立即加载，保证 Hillstone 使用原生 `iptables-legacy` 入口。宿主机重启后由 `systemd-modules-load` 自动恢复这些模块。

正式环境部署前必须确认宿主机支持 `ip_tables`、`iptable_filter`、`iptable_nat`、`iptable_mangle` 和 `/dev/net/tun`。不能只根据容器的 `healthy` 判断 VPN 在线；登录 noVNC 后还要确认 Hillstone 页面显示在线、容器内 `tun0` 为 UP，并能访问研发文件地址。

传输核心位于 `libs/cam-transfer`，包括清单生成、分块摘要、原子写入、合并校验和 SQLite 进度恢复。

测试环境没有实体网闸时，使用 `tools/cam-gate-simulator.js` 模拟网闸的文件摆渡语义。它只在显式的 `outside-to-inside` 或 `inside-to-outside` 单向目录之间传输带 `manifest.json` 的 bundle，逐块校验 SHA-256，支持中断后恢复、幂等重试和 `receipt.json` 回执，并拒绝路径穿越、符号链接、清单方向错误和摘要不匹配。它不模拟网闸管理 API、病毒检测或物理隔离能力，不纳入生产 Compose：

```bash
node tools/cam-gate-simulator.js --root /tmp/cam-gate-test --direction outside-to-inside --transfer-id TR-20261013-001
```

生产环境的山石网闸按现场确认采用映射模式：只映射 CAM 指定的虚拟 IP/端口到指定服务端口，并限制源对象、目的对象、协议和方向。网闸模式调研、映射规则建议、测试目录约定和云管联调现状见 [`docs/gate-integration-and-simulator.md`](docs/gate-integration-and-simulator.md)。

跨区受控接口的共享密钥由 Core 的密钥环自动管理。初始化不注入共享密钥；双方互信身份包后，Core 生成首个密钥并通过签名、加密提案和双端确认完成建立，之后按页面配置的轮换周期自动轮换并保留短期新旧密钥过渡。密钥环保存在各安全区数据目录的 `gate-keyring.json`，不写 SQLite、交换包或日志；`.env` 中不再手工维护日常轮换值。
