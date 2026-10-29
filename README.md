# CAM（Cloud Artifact Management）

CAM 是面向隔离网络的软件制品管理系统，负责候选包接收、固化审批、正式制品分发和云中心人工下载。

当前仓库以开发和测试联调为主。生产交付请使用独立的镜像和分区 Compose 文件，详见[部署指南](docs/deployment-guide.md)。

## 1. 系统组成

| 模块 | 主要职责 | 开发/直连测试默认入口 |
| --- | --- | --- |
| Edge | 接收候选包、保存候选轮次、提交固化申请 | Web 8088 / 控制 8101 / API 3101 |
| Core | 云管审批、正式制品目录、Edge→Core 接收、Core→Agent 调度 | Web 8092 / 控制 8201 / 传输 8202 / API 3102 |
| Agent | 云中心本地缓存、分发任务、文件校验、人工部署交付 | Web 3111 / API 3103 |

每个模块都有业务 API 容器和 Web/Caddy 容器。正式部署时，Edge、Core、每台 Agent 位于各自安全区，使用独立 Compose 项目和独立数据目录；不要把三个安全区加入同一个跨区 Docker 网络。

## 2. 业务流程

1. Edge 接收候选文件并完成摘要校验，验证人员提交固化申请。
2. Core 接收申请并调用云管审批；审批通过后，从 Edge 获取正式制品并再次校验 SHA-256。
3. Core 管理员在“Agent 分发”中选择正式版本、目标 Agent、计划时间和单文件并发线程数，创建分发任务。
4. Agent 按任务主动从 Core 拉取文件，支持分块并发、断点续传、重试和 SHA-256 校验；相同 SHA-256 文件在 Agent 本地只缓存一份。
5. 文件全部校验通过后，云中心人员在 Agent“正式制品”页面创建部署交付授权，再用浏览器或现有升级工具下载。Agent 记录授权、会话、断点和错误。

Core 是审批和分发的授权方；Agent 不能绕过 Core 直接选择或下载未授权版本。当前没有独立部署系统，Agent 的交付页面面向人工部署人员。

## 3. 开发和 Docker 联调

### 运行测试

要求 Node.js 24 LTS：

    npm ci
    npm test

直接运行 API（不包含 Web 页面）：

    npm run start:edge   # 3101
    npm run start:core   # 3102
    npm run start:agent  # 3103

各 API 提供 /health/live 和 /health/ready 健康检查。

### 准备测试配置

根目录的 compose.yaml、compose.direct.yaml 仅用于开发、测试和联调，不用于正式分区部署：

    cp deploy/.env.example deploy/.env
    # 只填写数据目录和确需覆盖的测试项；不要把真实密钥提交到 Git
    sudo env CAM_DATA_ROOT_DIR=/var/lib/cloud-artifact-management \
      sh deploy/init-data-directories.sh

有 Hillstone/VPN 模拟环境时：

    docker compose --env-file deploy/.env -f compose.yaml up -d --build
    docker compose --env-file deploy/.env -f compose.yaml ps

没有 Hillstone、只做直连联调时：

    docker compose --env-file deploy/.env -f compose.direct.yaml up -d --build
    docker compose --env-file deploy/.env -f compose.direct.yaml ps

直连 Compose 会启动 cam-agent-1 和 cam-agent-2 两个独立 Agent；它们分别挂载 `agent-1`、`agent-2` 子目录，不能共用数据目录。需要更换测试根目录时设置 `CAM_DATA_ROOT_DIR`。

停止容器但保留数据：

    docker compose --env-file deploy/.env -f compose.direct.yaml stop

不要在数据仍需保留时使用 docker compose down -v，也不要直接删除 SQLite、密钥或制品目录。

## 4. 首次初始化账号

以下命令适用于直连测试 Compose；独立分区部署时，将 Compose 文件和服务名替换为[部署指南](docs/deployment-guide.md)中的对应值。

Core 建议先创建安全管理员。安全管理员负责账号、角色和登录权限；系统管理员负责系统配置，不负责账号管理：

    docker compose --env-file deploy/.env -f compose.direct.yaml exec -it cam-core node apps/cam-core/src/bootstrap-security-admin.js

如需测试系统管理员初始化：

    docker compose --env-file deploy/.env -f compose.direct.yaml exec -it cam-core node apps/cam-core/src/bootstrap-admin.js

每个 Agent 的本地账号数据库彼此独立，按需分别初始化：

    docker compose --env-file deploy/.env -f compose.direct.yaml exec -it cam-agent-1 node apps/cam-agent/src/bootstrap-security-admin.js
    docker compose --env-file deploy/.env -f compose.direct.yaml exec -it cam-agent-2 node apps/cam-agent/src/bootstrap-security-admin.js

需要测试 Agent 系统管理员时，把脚本名替换为 bootstrap-admin.js。初始化脚本要求交互式输入至少 12 个字符的密码；首次登录后必须修改初始密码。Edge 不再维护独立的本地人员账号，Edge 的人员和角色由 Core 授权。

## 5. 身份配对

Core 与 Agent 使用 Agent 私钥和 Core 服务身份进行双向签名认证，不使用固定 Agent 令牌。首次配对在页面完成：

1. Agent 页面生成并展示本机公钥。
2. Core“Agent 管理”登记 Agent 公钥。
3. 将 Core 公钥复制到 Agent“Core 身份配对”页面，填写 Core 地址并测试。
4. Agent 首次成功请求后，Core 返回稳定 Agent 编号。

Core 与 Edge 的网闸对接同样使用双方身份签名。密钥、身份文件和轮换状态只保存在各自持久化数据目录，不写入镜像、普通日志或 Git。日常配对、轮换和网闸地址配置优先使用页面；.env 只提供部署初始值。

## 6. 配置和数据边界

- deploy/*.env：镜像名、绑定地址、端口、数据目录、网闸/云管/AAA 的部署连接参数和秘密。实际文件应限制权限（建议 chmod 600），不得提交。
- Core 页面：云管业务字典、AAA 配置、Agent 管理、网闸映射、审批和分发调度。
- Agent 页面：Core 地址与公钥、正式制品缓存、任务监控、人工下载授权。
- 持久化目录：SQLite、日志、密钥、Edge 候选包、Core 正式制品和 Agent 缓存。

默认数据目录：

    /var/lib/cloud-artifact-management/edge
    /var/lib/cloud-artifact-management/core
    /var/lib/cloud-artifact-management/agent       # 独立 Agent 部署
    /var/lib/cloud-artifact-management/agent-1     # 直连测试 Agent 1
    /var/lib/cloud-artifact-management/agent-2     # 直连测试 Agent 2

SQLite 运行时会同时产生 -wal 和 -shm 文件。备份应使用 SQLite 一致性备份，或停对应服务后整体备份数据目录；不能只复制正在运行的 .sqlite 主文件。

## 7. 正式分区部署

正式环境只部署目标安全区需要的镜像和 Compose 文件，不使用根目录组合式 Compose：

| 模块 | Compose | 配置模板 |
| --- | --- | --- |
| Edge | deploy/compose.edge.yaml | deploy/edge.env.example |
| Core | deploy/compose.core.yaml | deploy/core.env.example |
| Agent | deploy/compose.agent.yaml | deploy/agent.env.example |

每个目标主机只复制对应模块的配置：

    MODULE=edge                         # edge、core 或 agent
    cp deploy/${MODULE}.env.example deploy/${MODULE}.env
    chmod 600 deploy/${MODULE}.env
    set -a; . deploy/${MODULE}.env; set +a
    sudo -E sh deploy/init-module-data.sh ${MODULE}
    docker compose --env-file deploy/${MODULE}.env -f deploy/compose.${MODULE}.yaml config
    docker compose --env-file deploy/${MODULE}.env -f deploy/compose.${MODULE}.yaml up -d

生产镜像应在受控构建机上生成并通过批准的镜像仓库或离线介质交付；目标机不应依赖 Compose 在线构建或下载依赖。

正式分区部署使用各自 Compose 内嵌的 Caddy 直接发布页面：Edge 页面为宿主机 `80/443`、网闸控制/API 为 `8101`；Core 页面为 `80/443`、控制/API 为 `8201`、数据传输为 `8202`；Agent 页面为 `80/443`。三个后端 API 端口 `3101/3102/3103` 只在各自 Compose 网络内可达。镜像构建、离线导入、回退、端口、网闸映射和备份要求见[部署指南](docs/deployment-guide.md)。

## 8. 更新和排障

    # 查看服务和最近日志
    docker compose --env-file deploy/${MODULE}.env -f deploy/compose.${MODULE}.yaml ps
    docker compose --env-file deploy/${MODULE}.env -f deploy/compose.${MODULE}.yaml logs --tail=200 <service>

    # 测试环境更新指定 Web 模块
    docker compose --env-file deploy/.env -f compose.direct.yaml up -d --build cam-core-web cam-edge-web

更新前确认磁盘空间、数据目录和镜像版本。传输失败优先在 Core“传输监测”和 Agent“分发任务”查看任务级错误、尝试次数和重试时间，再决定是否重试。不要用删除数据目录的方式解决容器问题。

## 9. 文档索引

- [部署指南](docs/deployment-guide.md)：镜像交付、独立分区 Compose、银河麒麟离线安装 Docker/Compose、配置、升级和备份。
- [技术方案](docs/technical-solution.md)：架构、权限、身份、传输和安全约束。
- [系统设计](docs/system-design.md)：业务对象和流程设计。
- [Core–Agent 制品接口](docs/core-agent-artifact-api.md)：分发、缓存、授权和下载接口。
- [Edge 账号与下载交付](docs/edge-accounts.md)：Edge 登录、授权、Range 续传和审计。
- [网闸集成与模拟器](docs/gate-integration-and-simulator.md)：网闸映射模式及测试模拟器。
- [评估与范围说明](docs/assessment-overview.md)：建设目标、边界和后续演进。

## 10. 当前边界

- 当前阶段面向人工部署人员，没有独立部署系统。
- Agent 只缓存经过 Core 授权并校验通过的正式制品，不执行实际部署。
- 暂不自动清理缓存；清理必须另行设计并考虑版本、任务和审计引用。
- AAA 当前采用实时认证，不做用户目录同步；账号角色仍在 CAM 内配置。
