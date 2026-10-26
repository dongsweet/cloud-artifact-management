# CAM 部署指南（Docker 镜像交付）

本文说明如何把 CAM 作为 Docker 镜像交付到隔离网络，并分别部署统一运维外部交换区的 Edge、统一运维内网的 Core，以及各云中心的 Agent。三个模块使用独立 Compose 文件、独立配置文件和独立数据目录；部署目标只需要 Docker Engine、Docker Compose 插件、镜像文件和部署配置，不需要源码、Node.js 或 npm。

部署文件：

| 模块 | Compose 文件 | 配置模板 | 服务入口 |
|---|---|---|---|
| Edge | `deploy/compose.edge.yaml` | `deploy/edge.env.example` | Edge Web（默认宿主机 8088），Edge API（默认仅回环 3101） |
| Core | `deploy/compose.core.yaml` | `deploy/core.env.example` | Core Web（默认宿主机 8092），Core API（默认仅回环 3102） |
| Agent | `deploy/compose.agent.yaml` | `deploy/agent.env.example` | Agent API（仅 Compose 内部 3103）+ Agent Web（默认宿主机 3111） |

根目录的 `compose.yaml` 和 `compose.direct.yaml` 保留给开发、联调和测试环境。正式分区部署不要用它们，因为它们会把多个安全区组件组合到同一 Compose 网络中。

## 交付物与版本

每次发布应固定同一个版本号，并交付目标分区实际需要的镜像、对应 Compose 文件、该模块的 `.env.example`、初始化脚本和版本校验信息。版本号使用不可变发布标签，例如 `1.2.0`，不要在正式交付中使用 `latest` 或 `dev`。

镜像清单：

| 镜像 | 用途 |
|---|---|
| `cam-edge:<版本>` | Edge API 和后台任务 |
| `cam-edge-web:<版本>` | Edge 页面和同源 API 反向代理 |
| `cam-core:<版本>` | Core API、审批适配和后台任务 |
| `cam-core-web:<版本>` | Core 页面和 Agent 页面入口反向代理 |
| `cam-agent:<版本>` | Agent API、认证、任务调度、缓存与本地数据处理 |
| `cam-agent-web:<版本>` | Agent 静态页面、Caddy、TLS/反向代理 |

生产构建在受控构建机上进行。先从可信的软件源取得并审核 Node.js、Caddy 基础镜像和 npm 依赖，再构建并测试应用镜像。示例命令在仓库根目录执行：

```bash
VERSION=1.2.0
docker build --build-arg SERVICE=cam-edge -t cam-edge:$VERSION -f Dockerfile .
docker build --build-arg SERVICE=cam-core -t cam-core:$VERSION -f Dockerfile .
docker build --build-arg SERVICE=cam-agent -t cam-agent:$VERSION -f Dockerfile .
docker build --build-arg CADDY_BASE_IMAGE=caddy:2.11.4 -t cam-agent-web:$VERSION -f agent-web.Dockerfile .
docker build --build-arg CADDY_BASE_IMAGE=caddy:2.11.4 -t cam-edge-web:$VERSION -f edge-web.Dockerfile .
docker build --build-arg CADDY_BASE_IMAGE=caddy:2.11.4 -t cam-core-web:$VERSION -f core-web.Dockerfile .
```

构建前应运行 `npm ci` 和 `npm test`。离线环境有两种镜像导入方式：由受控镜像仓库同步签名后的镜像，或将镜像归档通过批准的介质/交换流程送入目标区。离线归档示例：

```bash
docker save \
  cam-edge:$VERSION cam-edge-web:$VERSION \
  cam-core:$VERSION cam-core-web:$VERSION \
  cam-agent:$VERSION cam-agent-web:$VERSION \
  -o cam-images-$VERSION.tar
sha256sum cam-images-$VERSION.tar > cam-images-$VERSION.tar.sha256
```

在目标主机校验归档摘要后导入：

```bash
sha256sum -c cam-images-1.2.0.tar.sha256
docker load -i cam-images-1.2.0.tar
docker image inspect cam-edge:1.2.0 cam-edge-web:1.2.0
```

Compose 中的镜像名必须与已导入的完整镜像名、标签一致。若使用内部镜像仓库，给镜像加仓库前缀后，分别在模块 `.env` 中设置 `CAM_*_IMAGE`，再执行 `docker login` 并确认目标主机可访问该仓库。离线隔离区不要在 Compose 中使用 `build:`、`pull_policy: always`，也不要依赖容器启动时下载依赖。

## 目录和持久化

CAM 的 SQLite 数据库、密钥、下载文件、候选包和 Agent 缓存均通过绑定挂载保存在宿主机普通目录中，不依赖 Docker 命名卷。每个模块只挂载自己的数据目录：

```text
/var/lib/cloud-artifact-management/edge/   Edge 数据与制品
/var/lib/cloud-artifact-management/core/   Core 数据、审批和服务身份密钥
/var/lib/cloud-artifact-management/agent/  Agent 数据、私钥、制品和缓存
```

在各目标主机只初始化对应目录。以 Linux Docker 主机为例：

```bash
sudo CAM_EDGE_DATA_DIR=/var/lib/cloud-artifact-management/edge sh deploy/init-module-data.sh edge
sudo CAM_CORE_DATA_DIR=/var/lib/cloud-artifact-management/core sh deploy/init-module-data.sh core
sudo CAM_AGENT_DATA_DIR=/var/lib/cloud-artifact-management/agent sh deploy/init-module-data.sh agent
```

脚本会创建目录并设为容器用户 `10001:10001` 可读写。若目标主机的挂载目录需要使用其他 UID/GID，可在执行脚本时设置 `CAM_DATA_UID` 和 `CAM_DATA_GID`，并确保容器也以相同用户运行。目录必须位于本机可靠存储上，并纳入所在区域的备份和恢复策略。不要把 SQLite 数据库放到多主机共享文件系统，也不要对运行中的数据库文件做普通文件复制；备份时应停服务或使用 SQLite 一致性备份方式。日常禁止使用 `docker compose down -v`，该命令会删除 Compose 管理的命名卷；本部署使用主机绑定目录，仍应避免执行任何清理数据目录的命令。

## 配置文件准备

在目标主机把对应模板复制为模块配置文件，限制访问权限，并只编辑该模块的配置：

```bash
cp deploy/edge.env.example deploy/edge.env
cp deploy/core.env.example deploy/core.env
cp deploy/agent.env.example deploy/agent.env
chmod 600 deploy/edge.env deploy/core.env deploy/agent.env
```

实际部署时将 Compose 文件、模板、初始化脚本和实际 `.env` 放在目标机同一部署目录中。生产环境只需要部署对应模块文件；不要把 Core 的 `.env`、云管/AAA 密钥或其他区的配置复制到 Edge、Agent 主机。需要编辑的字段如下：

| 字段 | 修改要求 |
|---|---|
| `CAM_*_IMAGE` | 必须与本次导入镜像名和版本标签一致；仓库部署需包含仓库前缀 |
| `CAM_*_DATA_DIR` | 设置为目标主机本地持久化路径；Edge、Core、每台 Agent 使用互不重叠的目录。应用日志会写入对应数据目录下的 `logs/` 子目录 |
| `CAM_LOG_MAX_BYTES` / `CAM_LOG_MAX_FILES` | 应用日志单文件大小和轮转数量，默认 `52428800` / `5`；Docker `json-file` 轮转仍独立生效 |
| `CAM_LOG_COLLECTION_MAX_BYTES` | 单个 Agent 或 Core 日志归档的大小上限，默认 `104857600`（100 MiB） |
| `CAM_*_WEB_PORT` / `CAM_*_API_PORT` | 有宿主机端口冲突时调整；反代入口默认绑定 `127.0.0.1` |
| `CAM_*_WEB_BIND` / `CAM_*_API_BIND` | 有本机 HTTPS 反向代理时保持 `127.0.0.1`；确需让其他主机直连时才改成受控内网地址，并配置防火墙 |
| `CAM_DOCKER_SUBNET` | 该 Compose 项目的 Docker 子网，模板为每个模块分配不同的 `192.168.241/242/243.0/24` 网段；部署前检查不与宿主机、VPN、业务网或其他 Docker 网络冲突，冲突时修改此值 |
| `CAM_TRUST_PROXY` | 默认与本模块 Docker 子网相同，供同 Compose 内的 Caddy 或经宿主机映射的受控反代转发客户端地址；若反代拓扑不同，改成实际代理源地址/网段，不能信任所有来源 |
| `CAM_COOKIE_SECURE` | HTTPS 正式环境保持 `true`；只有隔离的 HTTP 测试可设为 `false` |
| `CAM_GATE_*_URL` | 填网闸映射服务提供的本区虚拟地址；Edge 填 Core 控制/制品传输外侧映射地址，Core 填 Edge 控制/制品回执内侧映射地址。不要填对端容器地址或自行拼接业务路径 |
| `CAM_GATE_TLS_*` | 只有映射 HTTPS 使用私有 CA 或指定证书名时设置；CA 文件须通过只读挂载等方式提供给容器，不能仅写一个容器内不存在的路径 |
| `CAM_CLOUD_*` | 仅 Core 使用。填写云管 API 基址、认证用户、密钥及当前环境工单字典/部门/处理人等值；密钥仅保存在 Core 的受限配置文件或后续 Core 配置管理中 |
| `CAM_AAA_*` | Core、Agent 各自连接 AAA 时分别配置。按模块设置 API 地址、租户、认证设备和共享密钥；证书验证保持开启，不把普通用户密码放入配置文件 |
| `CAM_AGENT_UPSTREAM` | Core Web 或其他受控反代使用，填写从反代容器可达的 Agent Web 地址。默认示例通过宿主机 `3111` 访问单台 Agent Web；多云中心按实际入口配置可路由的 Agent Web 地址 |
| `CAM_SOURCE_ALLOWLIST` | 仅 Edge 使用，配置允许拉取研发内网文件的来源地址/网段策略，按现网实际值收紧；不要照搬模板占位值 |

业务字典、人员匹配结果、密钥轮换和网闸映射配置中，适合日常调整的内容优先使用相应管理页面；`.env` 用于部署基础参数和首次启动默认值，不作为日常业务操作界面。

## 单独部署 Edge

在统一运维外部交换区主机导入 Edge 与 Edge Web 镜像，准备 `edge.env` 和 Edge 数据目录，再运行：

```bash
docker compose --env-file deploy/edge.env -f deploy/compose.edge.yaml config
docker compose --env-file deploy/edge.env -f deploy/compose.edge.yaml up -d
docker compose --env-file deploy/edge.env -f deploy/compose.edge.yaml ps
curl -fsS http://127.0.0.1:3101/health/ready
curl -fsS http://127.0.0.1:8088/
```

外部 HTTPS 入口由所在环境的受控反向代理提供，将 Web 入口代理到 `127.0.0.1:8088`。`CAM_EDGE_API_PORT` 默认只绑定回环地址，供同机代理及网闸映射链路接入；若网闸必须从其他主机访问该监听端口，将绑定地址限制在专用内网接口，并在主机防火墙仅放行网闸映射节点。首次登录人员由 Core 统一授权，Edge 不再初始化独立人员账号。

## 单独部署 Core

在统一运维内网主机导入 Core 与 Core Web 镜像，准备 `core.env`，初始化 Core 数据目录并运行：

```bash
docker compose --env-file deploy/core.env -f deploy/compose.core.yaml config
docker compose --env-file deploy/core.env -f deploy/compose.core.yaml up -d
docker compose --env-file deploy/core.env -f deploy/compose.core.yaml ps
curl -fsS http://127.0.0.1:3102/health/ready
curl -fsS http://127.0.0.1:8092/
```

首次建立账号时，可直接使用交互终端创建安全管理员；无需预先创建系统管理员。需要系统管理员时，安全管理员可登录页面后创建：

```bash
docker compose --env-file deploy/core.env -f deploy/compose.core.yaml exec -it cam-core node apps/cam-core/src/bootstrap-admin.js
docker compose --env-file deploy/core.env -f deploy/compose.core.yaml exec -it cam-core node apps/cam-core/src/bootstrap-security-admin.js
```

初始口令在终端隐藏输入；登录后按要求修改密码。日常账号与角色管理由安全管理员完成。不要把账号密码写入 Compose 文件、镜像、命令行参数或版本库。

Core 页面中的 Agent 功能通过 `/agent/` 反代到 `CAM_AGENT_UPSTREAM`。单机联调可把 Agent Web 发布端口限制在 Core 主机回环地址，使用默认 `host.docker.internal:3111`；跨主机部署时，将 Agent Web 的 `CAM_AGENT_WEB_BIND` 改为专用内网接口地址，并在 Core `.env` 中把 `CAM_AGENT_UPSTREAM` 改为该 Agent Web 主机的内网 DNS 名称/地址和端口。主机防火墙只允许受控反代主机访问 Agent Web 端口；Agent API 端口 3103 不发布到宿主机。Core 与 Agent 无须共享 Docker 网络。

Core 的云管、AAA 和网闸地址必须从 Core 所在网络可达。云管工单配置和 Agent/Edge 间的审批状态通过 Core 后端流程完成；不要让 Edge 直接携带云管认证信息。

## 单独部署 Agent

每台 Agent 主机独立部署一份 Compose 实例、一份 `.env` 和一个专属数据目录。将该实例的 `agent.env.example` 复制为 `agent.env`，设置 `CAM_AGENT_DATA_DIR` 和该中心的 AAA 参数后启动；Core 地址、公钥和轮换状态在 Agent 页面保存到 `agent.sqlite`。主机绑定目录同时保存 `identity.json`（Agent 私钥，权限 `0600`），不得改为临时卷或容器内部路径：

```bash
docker compose --env-file deploy/agent.env -f deploy/compose.agent.yaml config
docker compose --env-file deploy/agent.env -f deploy/compose.agent.yaml up -d
docker compose --env-file deploy/agent.env -f deploy/compose.agent.yaml ps
curl -fsS http://127.0.0.1:3111/
```

首次登录前，可直接交互式创建 Agent 安全管理员；不需要预先创建系统管理员。需要系统管理员时，再由安全管理员登录页面创建。也可以按运维安排独立初始化系统管理员：

```bash
docker compose --env-file deploy/agent.env -f deploy/compose.agent.yaml exec -it cam-agent node apps/cam-agent/src/bootstrap-admin.js
docker compose --env-file deploy/agent.env -f deploy/compose.agent.yaml exec -it cam-agent node apps/cam-agent/src/bootstrap-security-admin.js
```

Agent 由两个容器组成：`cam-agent` 只监听 Compose 内部的 3103，负责 API、认证、任务调度、缓存和传输；`cam-agent-web` 负责直接提供构建时生成的静态页面，并承担 Caddy、TLS/反向代理和外部访问，默认发布到宿主机回环地址 3111。Caddy 只将 `/api/*` 和 `/health/*` 反代到 Agent API，其余请求由静态文件服务处理。由云中心已有 HTTPS 入口发布页面；Core Web 如果需要代用户打开该 Agent 页面，必须把 `CAM_AGENT_UPSTREAM` 配置成 Core Web 可达的 Agent Web 地址。Agent 本身直接连接 AAA；Core 负责 Agent 身份注册、授权和正式制品分发，不代理 Agent 用户登录。

Core 与 Agent 完成双向服务身份配对后，再验证 Agent 在线、任务领取和文件摘要校验。若 Agent 经由外部反代连接 Core，需确保反代完整转发 Agent 身份认证请求头、响应签名头及二进制分块响应，并关闭会改变请求路径/响应正文的代理功能。

## 更新、回退和运维

更新只替换目标模块的镜像标签和对应 Compose 文件，不删除或覆盖数据目录。先备份模块数据库、密钥及文件，再导入新镜像、修改 `.env` 中镜像版本并重建容器。联网且已推送到内部仓库时，可先拉取镜像：

```bash
docker compose --env-file deploy/edge.env -f deploy/compose.edge.yaml pull
docker compose --env-file deploy/edge.env -f deploy/compose.edge.yaml up -d
```

对于离线镜像，先 `docker load`，然后直接执行 `up -d`（不要执行 `pull`）。若需回退，恢复旧镜像标签并重新 `up -d`；数据库 schema 迁移若不可逆，必须按本次版本说明恢复一致的数据备份，不能只切回旧镜像。

常用检查：

```bash
docker compose --env-file deploy/core.env -f deploy/compose.core.yaml logs --tail=200
docker compose --env-file deploy/core.env -f deploy/compose.core.yaml ps
docker inspect cam-core
```

日志由 Docker `json-file` 驱动按大小轮转。定期检查 Docker 主机可用空间、各模块数据目录增长和备份结果。升级与排障时不得将数据库、私钥、下载令牌、云管密钥或 AAA 共享密钥复制到普通日志、工单或未经批准的区间。

## 网络与安全要求

- Edge、Core、每台 Agent 的 Compose 项目和 Docker 网络相互独立；不要为了服务发现而把三个安全区加入同一个跨区 Docker 网络。
- 对外的 HTTPS 由各自安全区的受控反向代理终止。CAM Web/API 的宿主机端口默认绑定回环地址；需要网闸或同机反代访问时，按最小范围调整监听地址和防火墙。
- `CAM_TRUST_PROXY` 只填写实际可信反代网段。Cookie Secure 保持开启；不要在生产环境用明文 HTTP 暴露登录页面。
- 容器以非 root 用户运行，根文件系统只读，临时写入使用受限 tmpfs；只有模块数据目录可持久写入。
- 正式部署文件不包含 Hillstone、网闸模拟器或任何测试 VPN 服务。网闸负责映射和隔离策略，CAM 只配置网闸给出的本侧映射地址。
- 逐个分区导入并核对镜像摘要、配置版本、初始化记录和健康状态。镜像传输与配置文件传输分别走批准的交付通道。
