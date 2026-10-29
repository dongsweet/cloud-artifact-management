# CAM 部署指南（Docker 镜像交付）

本文说明如何把 CAM 作为 Docker 镜像交付到隔离网络，并分别部署统一运维外部交换区的 Edge、统一运维内网的 Core，以及各云中心的 Agent。三个模块使用独立 Compose 文件、独立配置文件和独立数据目录；部署目标只需要 Docker Engine、Docker Compose 插件、镜像文件和部署配置，不需要源码、Node.js 或 npm。银河麒麟等不能联网的主机，先按离线 Docker 部署步骤安装并验证 Docker、Compose v2 和 CLI 插件。

部署文件：

| 模块 | Compose 文件 | 配置模板 | 服务入口 |
|---|---|---|---|
| Edge | `deploy/compose.edge.yaml` | `deploy/edge.env.example` | 嵌入式 Caddy 页面（宿主机 80/443），控制/API（8101），API（仅 Compose 内部 3101） |
| Core | `deploy/compose.core.yaml` | `deploy/core.env.example` | 嵌入式 Caddy 页面（宿主机 80/443），控制/API（8201），数据传输（8202），API（仅 Compose 内部 3102） |
| Agent | `deploy/compose.agent.yaml` | `deploy/agent.env.example` | Agent API（仅 Compose 内部 3103）+ 嵌入式 Caddy 页面（宿主机 80/443） |

根目录的 `compose.yaml` 和 `compose.direct.yaml` 保留给开发、联调和测试环境。正式分区部署不要用它们，因为它们会把多个安全区组件组合到同一 Compose 网络中。

## 部署账号

正式主机使用专用普通用户 `sugon` 部署，不在 `root` 家目录下保存或运行 CAM。以下账号创建命令由 root 执行；当前通过堡垒机使用口令登录，不加入 `docker` 组：

```bash
useradd --create-home --user-group --shell /bin/bash sugon
passwd sugon
id sugon
```

为 `sugon` 设置每台主机独立的高强度口令，并由堡垒机或密码保险箱管理。Docker、Compose 和系统服务操作在完成离线安装后，统一使用经过审计的 `sudo`；本节不提前执行 Docker 检查。

不要把 `sugon` 加入 `docker`、`wheel` 或其他管理员组；`docker` 组本身具备接近 root 的主机控制能力。配置文件放在 `/opt/cloud-artifact-management/<module>/`，应用数据放在 `/var/lib/cloud-artifact-management/<module>/`，接收中的交付包按版本放在 `/home/sugon/work/cam-deploy/<版本>/`。

## 银河麒麟离线主机准备

以下步骤用于不能联网的银河麒麟主机。磁盘、Docker、systemd 和 SELinux 操作由 root 或具备相应 sudo 权限的管理员执行；CAM 日常操作仍由 `sugon` 执行。

### 确认系统和数据盘

先做只读检查：

```bash
uname -m
cat /etc/os-release
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL,SERIAL
fdisk -l
```

下面以确认 `/dev/vdb` 是空的 2T 数据盘为例。`/dev/vdb` 只是示例，必须根据 `lsblk` 结果确认，不能直接照搬。格式化前再次检查：

```bash
wipefs -n /dev/vdb
fdisk -l /dev/vdb
```

只有确认没有需要保留的数据后，才执行分区和格式化：

```bash
parted -s /dev/vdb mklabel gpt
parted -s -a optimal /dev/vdb mkpart primary ext4 1MiB 100%
partprobe /dev/vdb
udevadm settle
mkfs.ext4 -L cam-data /dev/vdb1
tune2fs -m 1 /dev/vdb1
```

按模块挂载到对应目录；Edge、Core、Agent 通常使用各自独立主机和数据盘：

```bash
mkdir -p /var/lib/cloud-artifact-management/<module>
mount /dev/vdb1 /var/lib/cloud-artifact-management/<module>
df -h /var/lib/cloud-artifact-management/<module>
blkid /dev/vdb1
```

记录 UUID 后写入 `/etc/fstab`，并验证：

```text
UUID=实际UUID  /var/lib/cloud-artifact-management/<module>  ext4  defaults,noatime  0  2
```

```bash
umount /var/lib/cloud-artifact-management/<module>
mount -a
findmnt /var/lib/cloud-artifact-management/<module>
```

Docker 自身的镜像和容器数据默认位于 `/var/lib/docker`；不要未经设计就把 Docker data-root 和 CAM 数据目录混用。

### 离线安装 Docker 二进制

将与 `uname -m` 匹配的 Docker 压缩包和校验文件通过受控介质复制到主机，校验并查看内容：

```bash
sha256sum docker-<版本>.tgz
tar -tzf docker-<版本>.tgz
tar -xzf docker-<版本>.tgz
install -m 0755 docker/* /usr/bin/
file /usr/bin/docker /usr/bin/dockerd
docker --version
dockerd --version
```

如果出现 `exec format error`，说明二进制架构不匹配，应重新准备对应架构的离线包。

### 配置 Docker systemd 服务

如果系统没有可用的 Docker 服务，创建 `/usr/lib/systemd/system/docker.service`：

```ini
[Unit]
Description=Docker Application Container Engine
Documentation=https://docs.docker.com
After=network-online.target firewalld.service
Wants=network-online.target

[Service]
Type=notify
ExecStart=/usr/bin/dockerd
ExecReload=/bin/kill -s HUP $MAINPID
LimitNOFILE=infinity
LimitNPROC=infinity
TimeoutStartSec=0
Delegate=yes
KillMode=process
Restart=on-failure
StartLimitBurst=3
StartLimitInterval=60s

[Install]
WantedBy=multi-user.target
```

加载并启动：

```bash
systemctl daemon-reload
systemctl enable docker
systemctl start docker
systemctl --no-pager --full status docker
docker version
docker info
```

若系统已有 Docker 服务，先执行 `systemctl cat docker.service`，避免两个 dockerd 同时运行。

### 安装 Docker Compose v2

将匹配主机架构的 Compose v2 二进制放到 `/usr/bin/docker-compose`，再注册 Docker CLI 插件：

```bash
install -m 0755 docker-compose /usr/bin/docker-compose
mkdir -p /usr/local/lib/docker/cli-plugins
install -m 0755 /usr/bin/docker-compose \
  /usr/local/lib/docker/cli-plugins/docker-compose
docker-compose version
docker compose version
docker compose ls
```

正式环境使用系统级插件目录，不要只安装到某个用户的 `$HOME` 下。

完成 Docker 和 Compose 安装、并由 root 验证服务正常后，再切换到 `sugon` 验证日常操作权限：

```bash
su - sugon
sudo docker version
sudo docker compose version
```

如果 `sugon` 没有必要的 sudo 权限，应由系统管理员按安全策略授予最小命令范围；不要因此把用户加入 `docker` 组。

### SELinux

当前 CAM 离线部署方案要求按所在安全基线处理 SELinux。若确认正式环境允许禁用，执行：

```bash
getenforce
sed -i 's/^SELINUX=.*/SELINUX=disabled/' /etc/selinux/config
reboot
```

重启后确认 `getenforce` 输出为 `Disabled`。禁用 SELinux 会降低主机强制访问控制能力；如果安全基线不允许禁用，应先完成兼容性验证，不能直接照搬此步骤。

### Docker 网络规划

每个 Compose 项目使用独立的 `/24` bridge 网段：

```text
Edge：CAM_DOCKER_SUBNET=192.168.241.0/24
Core：CAM_DOCKER_SUBNET=192.168.242.0/24
Agent：CAM_DOCKER_SUBNET=192.168.243.0/24
```

正式 Compose 已固定项目名和默认网络名：Edge 为 `cam-edge_default`，Core 为 `cam-core_default`，Agent 为 `cam-agent_default`，不随 `current` 软链接目录名变化。这些网段只用于容器内部网络，不是网闸控制/传输地址。部署前必须确认不与宿主机业务网、管理网、VPN、路由表或其他 Docker 网络重叠；冲突时在模块 `.env` 中改成未占用的 `192.168.X.0/24`。修改已有网络网段需安排维护窗口执行对应 Compose 项目的 `sudo docker compose down` 和 `sudo docker compose up -d`，不要使用 `down -v`。

## 部署前置交付物

现场部署前，应从受控交付渠道收到目标模块对应的一组镜像包和配置包。部署文档只负责接收、校验、导入和启动，不负责镜像构建或发布包制作。包中的版本号必须一致，禁止使用 `latest` 或 `dev`。

Edge 主机需要：

```text
cam-edge-images-<版本>.tar
cam-edge-images-<版本>.tar.sha256
cam-edge-config-<版本>.tar
cam-edge-config-<版本>.tar.sha256
```

Core、Agent 分别将文件名中的 `edge` 替换为 `core`、`agent`。镜像包包含共用的 `cam-backend:<版本>` 和对应 Web/Caddy 镜像；配置包包含对应 Compose、`.env` 模板、初始化脚本和版本文件。配置包不应包含测试机配置、真实云管密钥或 AAA 密钥。

目标主机接收文件时，使用 `sugon` 用户按版本建立目录。例如首次部署 `v0.2.4`：

```bash
mkdir -p /home/sugon/work/cam-deploy/v0.2.4
chmod 700 /home/sugon/work/cam-deploy/v0.2.4
cd /home/sugon/work/cam-deploy/v0.2.4
```

将对应模块的镜像包、镜像校验文件、配置包和配置校验文件传到这个目录。该目录只是接收和校验区，不作为 Compose 工作目录；校验通过后，配置包解到 `/opt/cloud-artifact-management/<module>/releases/<版本>/`，镜像包直接用 `sudo docker load` 导入。不要把真实密钥放进接收目录的归档或版本库。

配置包解包命令（Edge 的 `v0.2.4` 示例；Core、Agent 替换模块名和文件名）：

```bash
MODULE=edge
VERSION=0.2.4
ROOT=/home/sugon/work/cam-deploy/v$VERSION
WEB_IMAGE=cam-$MODULE-web

sha256sum -c "$ROOT/cam-$MODULE-config-$VERSION.tar.sha256"
mkdir -p "$ROOT/extracted"
tar -xf "$ROOT/cam-$MODULE-config-$VERSION.tar" -C "$ROOT/extracted"
sudo install -d -o sugon -g sugon -m 0750 \
  "/opt/cloud-artifact-management/$MODULE/releases/$VERSION"
sudo cp -a "$ROOT/extracted/cam-$MODULE-config-$VERSION/." \
  "/opt/cloud-artifact-management/$MODULE/releases/$VERSION/"
sudo chown -R sugon:sugon \
  "/opt/cloud-artifact-management/$MODULE/releases/$VERSION"
sudo chmod 600 \
  "/opt/cloud-artifact-management/$MODULE/releases/$VERSION/$MODULE.env"
sudo ln -sfn "releases/$VERSION" \
  "/opt/cloud-artifact-management/$MODULE/current"
```

`$ROOT/extracted` 只是接收目录下的临时解包区；Compose 和初始化操作都使用 `/opt/cloud-artifact-management/<module>/current/`，不要从 `extracted` 目录直接启动。

配置包安装完成后，初始化对应模块的数据目录。以下是 Edge 示例；Core、Agent 分别替换环境变量名和模块名：

```bash
sudo env CAM_DATA_DIR=/var/lib/cloud-artifact-management/$MODULE \
  sh /opt/cloud-artifact-management/$MODULE/current/init-module-data.sh $MODULE
```

Core、Agent 只需将 `MODULE` 改为 `core`、`agent`，并将 `CAM_DATA_DIR` 改为对应数据目录。该脚本会设置容器用户 `10001:10001` 的访问权限。

部署时使用的镜像：

| 镜像 | 用途 |
|---|---|
| `cam-backend:<版本>` | Core、Edge、Agent 共用的 API 和后台任务镜像；由 Compose 的 `SERVICE` 选择运行模式 |
| `cam-edge-web:<版本>` | Edge 页面和同源 API 反向代理 |
| `cam-core-web:<版本>` | Core 页面和 Agent 页面入口反向代理 |
| `cam-agent-web:<版本>` | Agent 静态页面、Caddy、TLS/反向代理 |

在目标主机校验镜像归档摘要后导入：

```bash
sha256sum -c "$ROOT/cam-$MODULE-images-$VERSION.tar.sha256"
sudo docker load -i "$ROOT/cam-$MODULE-images-$VERSION.tar"
sudo docker image inspect "cam-backend:$VERSION" "$WEB_IMAGE:$VERSION"
```

Compose 中的镜像名必须与已导入的完整镜像名、标签一致。三个后端 Compose 服务共用 `cam-backend:<版本>`，并分别通过固定的 `SERVICE=cam-edge`、`SERVICE=cam-core`、`SERVICE=cam-agent` 选择运行模式；不要把该变量交给普通 `.env` 修改。离线隔离区不要执行 `docker compose pull`，也不要在 Compose 中使用 `build:` 或 `pull_policy: always`。

## 目录和持久化

CAM 的 SQLite 数据库、密钥、下载文件、候选包和 Agent 缓存均通过绑定挂载保存在宿主机普通目录中，不依赖 Docker 命名卷。每个模块只挂载自己的数据目录：

```text
/var/lib/cloud-artifact-management/edge/   Edge 数据与制品
/var/lib/cloud-artifact-management/core/   Core 数据、审批和服务身份密钥
/var/lib/cloud-artifact-management/agent/  Agent 数据、私钥、制品和缓存
```

在各目标主机只初始化对应目录。应先完成对应配置包解包，再使用配置包中的 `current/init-module-data.sh` 初始化；具体命令见下方“配置文件准备”。

脚本会创建目录并设为容器用户 `10001:10001` 可读写。若目标主机的挂载目录需要使用其他 UID/GID，可在执行脚本时设置 `CAM_DATA_UID` 和 `CAM_DATA_GID`，并确保容器也以相同用户运行。目录必须位于本机可靠存储上，并纳入所在区域的备份和恢复策略。不要把 SQLite 数据库放到多主机共享文件系统，也不要对运行中的数据库文件做普通文件复制；备份时应停服务或使用 SQLite 一致性备份方式。日常禁止使用 `docker compose down -v`，该命令会删除 Compose 管理的命名卷；本部署使用主机绑定目录，仍应避免执行任何清理数据目录的命令。

## 配置文件准备

完成上面的配置包解包后，编辑当前版本配置：

```bash
vi /opt/cloud-artifact-management/edge/current/edge.env
chmod 600 /opt/cloud-artifact-management/edge/current/edge.env
```

生产环境只部署对应模块文件；不要把 Core 的 `.env`、云管/AAA 密钥或其他区的配置复制到 Edge、Agent 主机。配置模板只列启动必需项，其他配置由 Compose 默认值提供；网闸业务参数、AAA 参数和云管工单业务参数优先在页面保存。接收目录只用于收包和校验，不作为 Compose 工作目录。

| 字段 | 修改要求 |
|---|---|
| `CAM_*_IMAGE` | 模板中的镜像名必须与本次导入镜像一致；仓库部署需包含仓库前缀 |
| `CAM_DATA_DIR` | 必填，设置为目标主机本地持久化路径；Edge、Core、每台 Agent 使用各自 `.env` 中互不重叠的目录。应用日志会写入对应数据目录下的 `logs/` 子目录 |
| `CAM_LOG_MAX_BYTES` / `CAM_LOG_MAX_FILES` | 应用日志单文件大小和轮转数量，默认 `52428800` / `5`；Docker `json-file` 轮转仍独立生效 |
| `CAM_LOG_COLLECTION_MAX_BYTES` | 单个 Agent 或 Core 日志归档的大小上限，默认 `104857600`（100 MiB） |
| `CAM_*_WEB_HTTP_BIND` / `CAM_*_WEB_HTTP_PORT` | 嵌入式 Caddy 的 HTTP 页面入口，默认宿主机 `0.0.0.0:80`，映射到容器内非特权端口 `8080` |
| `CAM_*_WEB_HTTPS_BIND` / `CAM_*_WEB_HTTPS_PORT` | 嵌入式 Caddy 的 HTTPS 页面入口，默认宿主机 `0.0.0.0:443`，映射到容器内非特权端口 `8443`；启用 `CAM_*_WEB_HTTPS=true` 后使用该入口 |
| `CAM_*_CONTROL_BIND` / `CAM_*_CONTROL_PORT` | 网闸控制/API 入口；默认 Edge `0.0.0.0:8101`、Core `0.0.0.0:8201`。网闸从其他主机访问时保留专用端口并收紧防火墙 |
| `CAM_*_TRANSFER_BIND` / `CAM_*_TRANSFER_PORT` | Core 数据传输入口；默认 Core `0.0.0.0:8202`。Edge 不发布独立传输端口，Edge→Core 传输使用 Core `8202` |
| `CAM_*_TLS_DIR` | 宿主机证书目录，只读挂载到 Web 容器的 `/tls`；目录内的证书权限应允许容器用户读取 |
| `CAM_*_WEB_HTTPS` / `CAM_*_CONTROL_HTTPS` / `CAM_*_TRANSFER_HTTPS` | 分别控制页面、控制、传输入口是否启用 HTTPS；默认均为 `false`，正式环境准备好证书后建议页面和需要加密的网闸通道设为 `true` |
| `CAM_*_*_TLS_CERT_FILE` / `CAM_*_*_TLS_KEY_FILE` | 对应入口使用的证书和私钥路径，填写容器内 `/tls/...` 路径；可以三条入口共用一套证书，也可以分别配置 |
| `CAM_*_API_BIND` | 正式 Compose 不发布 API 宿主机端口；API 仅供同项目 Web/Caddy 容器访问 |
| `CAM_DOCKER_SUBNET` | 该 Compose 项目的 Docker 子网，模板为每个模块分配不同的 `192.168.241/242/243.0/24` 网段；部署前检查不与宿主机、VPN、业务网或其他 Docker 网络冲突，冲突时修改此值 |
| `CAM_TRUST_PROXY` | 默认与本模块 Docker 子网相同，供同 Compose 内的 Caddy 或经宿主机映射的受控反代转发客户端地址；若反代拓扑不同，改成实际代理源地址/网段，不能信任所有来源 |
| `CAM_COOKIE_SECURE` | HTTPS 正式环境保持 `true`；只有隔离的 HTTP 测试可设为 `false` |
| `CAM_GATE_*_URL` | Edge 的 `CAM_GATE_CORE_CONTROL_URL` 是必填的部署启动地址，页面只读；`CAM_GATE_CORE_TRANSFER_URL` 指向 Core `8202`。Core 的 Edge 控制地址指向 Edge `8101`，在网闸配置页面维护。不要填对端容器地址或自行拼接业务路径 |
| `CAM_GATE_TLS_*` | 只有映射 HTTPS 使用私有 CA 或指定证书名时设置；CA 文件须通过只读挂载等方式提供给容器，不能仅写一个容器内不存在的路径 |
| `CAM_CLOUD_*` | 仅 Core 使用。`.env` 只保留 API 基址、认证用户 ID 和密钥；工单级别、来源、业务类型、部门、团队和处理人等在 Core 页面配置 |
| `CAM_AAA_*` | Core、Agent 的 AAA 参数在各自页面配置；只有需要部署期预置时才放入对应 `.env`，不把普通用户密码放入配置文件 |
| `CAM_AGENT_UPSTREAM` | Core Web 或其他受控反代使用，填写从反代容器可达的 Agent Web 地址（通常为 Agent 主机的 80/443 入口）；多云中心按实际入口配置可路由的 Agent Web 地址 |
| `CAM_SOURCE_ALLOWLIST` | 仅 Edge 使用，配置允许拉取研发内网文件的来源地址/网段策略，按现网实际值收紧；不要照搬模板占位值 |
| `CAM_MAX_CANDIDATE_SIZE` | 仅 Edge 使用，单个候选包允许的最大字节数；默认 2 TiB，必须结合本地磁盘容量收紧，超限或来源重定向会拒绝接收 |

### TLS 证书准备（以 Edge 为例）

正式环境使用容器内嵌 Caddy 时，证书放在宿主机证书目录，Web 容器以只读方式挂载为 `/tls`。默认 Edge 目录为：

```text
/var/lib/cloud-artifact-management/edge/tls/
├── fullchain.pem
└── privkey.pem
```

证书和私钥由主机管理员通过受控介质复制，不要放进镜像包、配置归档、Git 或数据库。容器以 UID/GID `10001:10001` 运行，证书目录和文件必须允许该用户读取；私钥仍应限制为仅容器用户可读：

```bash
sudo install -d -o 10001 -g 10001 -m 750 \
  /var/lib/cloud-artifact-management/edge/tls

sudo install -o 10001 -g 10001 -m 640 \
  fullchain.pem \
  /var/lib/cloud-artifact-management/edge/tls/fullchain.pem

sudo install -o 10001 -g 10001 -m 600 \
  privkey.pem \
  /var/lib/cloud-artifact-management/edge/tls/privkey.pem
```

在真实的 `edge.env` 中启用页面 HTTPS：

```env
CAM_EDGE_TLS_DIR=/var/lib/cloud-artifact-management/edge/tls
CAM_EDGE_WEB_HTTPS=true
CAM_EDGE_WEB_TLS_CERT_FILE=/tls/fullchain.pem
CAM_EDGE_WEB_TLS_KEY_FILE=/tls/privkey.pem
```

如果网闸控制/API 通道 `8101` 也需要 HTTPS，可复用同一证书（证书必须覆盖对应访问名称），并配置：

```env
CAM_EDGE_CONTROL_HTTPS=true
CAM_EDGE_CONTROL_TLS_CERT_FILE=/tls/fullchain.pem
CAM_EDGE_CONTROL_TLS_KEY_FILE=/tls/privkey.pem
```

修改证书或 HTTPS 开关后，重建对应 Web 容器；不要删除数据目录：

```bash
sudo docker compose \
  --env-file /opt/cloud-artifact-management/edge/current/edge.env \
  -f /opt/cloud-artifact-management/edge/current/compose.edge.yaml \
  up -d --force-recreate cam-edge-web
```

Core、Agent 分别使用各自的 `CAM_CORE_TLS_DIR`、`CAM_AGENT_TLS_DIR` 目录和对应的 `CAM_*_TLS_CERT_FILE`、`CAM_*_TLS_KEY_FILE`。启用页面 HTTPS 后，生产环境保持 `CAM_COOKIE_SECURE=true`；仅在隔离的临时 HTTP 测试环境才设置为 `false`。

业务字典、人员匹配结果、密钥轮换和网闸映射配置中，适合日常调整的内容优先使用相应管理页面；`.env` 用于部署基础参数和首次启动默认值，不作为日常业务操作界面。各模块嵌入式 Caddy 的页面入口，以及 Edge 控制入口、Core 控制和传输入口，都可独立切换 HTTP/HTTPS、指定证书/私钥和调整宿主机对外端口；启用 HTTPS 前先把证书目录放到 `CAM_*_TLS_DIR`，再重建对应 Web 容器。HTTP/HTTPS 切换会改变访问协议，`CAM_GATE_*_URL` 和外部网闸规则必须同步使用对应协议与端口。

## 单独部署 Edge

在统一运维外部交换区主机导入 Edge 与 Edge Web 镜像，准备 `edge.env` 和 Edge 数据目录，再运行：

```bash
sudo docker compose --env-file /opt/cloud-artifact-management/edge/current/edge.env -f /opt/cloud-artifact-management/edge/current/compose.edge.yaml config
sudo docker compose --env-file /opt/cloud-artifact-management/edge/current/edge.env -f /opt/cloud-artifact-management/edge/current/compose.edge.yaml up -d
sudo docker compose --env-file /opt/cloud-artifact-management/edge/current/edge.env -f /opt/cloud-artifact-management/edge/current/compose.edge.yaml ps
curl -fsS http://127.0.0.1:80/health/ready
```

Edge Web 使用容器内嵌的 Caddy，宿主机直接发布 `80/443`；`CAM_EDGE_WEB_HTTPS=true` 时使用证书挂载的 443 入口，后续可在防火墙只放行 443。Edge API 的 `3101` 仅在 Compose 网络内可达，不发布到宿主机。Edge 唯一的网闸入口是控制/API `8101`；正式制品传输由 Edge 按配置主动访问 Core 的 `8202`，Edge 不再发布 `8201`。首次登录人员由 Core 统一授权，Edge 不再初始化独立人员账号。

## 单独部署 Core

在统一运维内网主机导入 Core 与 Core Web 镜像，准备 `core.env`，初始化 Core 数据目录并运行：

```bash
sudo docker compose --env-file /opt/cloud-artifact-management/core/current/core.env -f /opt/cloud-artifact-management/core/current/compose.core.yaml config
sudo docker compose --env-file /opt/cloud-artifact-management/core/current/core.env -f /opt/cloud-artifact-management/core/current/compose.core.yaml up -d
sudo docker compose --env-file /opt/cloud-artifact-management/core/current/core.env -f /opt/cloud-artifact-management/core/current/compose.core.yaml ps
curl -fsS http://127.0.0.1:80/health/ready
```

首次建立账号时，可直接使用交互终端创建安全管理员；无需预先创建系统管理员。需要系统管理员时，安全管理员可登录页面后创建：

```bash
sudo docker compose --env-file /opt/cloud-artifact-management/core/current/core.env -f /opt/cloud-artifact-management/core/current/compose.core.yaml exec -it cam-core node apps/cam-core/src/bootstrap-admin.js
sudo docker compose --env-file /opt/cloud-artifact-management/core/current/core.env -f /opt/cloud-artifact-management/core/current/compose.core.yaml exec -it cam-core node apps/cam-core/src/bootstrap-security-admin.js
```

初始口令在终端隐藏输入；登录后按要求修改密码。日常账号与角色管理由安全管理员完成。不要把账号密码写入 Compose 文件、镜像、命令行参数或版本库。

Core 页面中的 Agent 功能通过 `/agent/` 反代到 `CAM_AGENT_UPSTREAM`。跨主机部署时，把 `CAM_AGENT_UPSTREAM` 改为 Agent Web 主机的内网 DNS 名称/地址（Agent Web 直接发布 80/443），主机防火墙只允许受控 Core Web 访问；Agent API 端口 3103 不发布到宿主机。Core API 的 `3102` 仅在 Compose 网络内可达；Core Caddy 的控制/API 入口为 `8201`，专用数据传输入口为 `8202`。网闸规则应分别映射到这两个端口。Core 与 Agent 无须共享 Docker 网络。

Core 的云管、AAA 和网闸地址必须从 Core 所在网络可达。云管工单配置和 Agent/Edge 间的审批状态通过 Core 后端流程完成；不要让 Edge 直接携带云管认证信息。

## 单独部署 Agent

每台 Agent 主机独立部署一份 Compose 实例、一份 `.env` 和一个专属数据目录。将该实例的 `agent.env.example` 复制为 `agent.env`，设置 `CAM_DATA_DIR` 后启动；AAA 参数、Core 地址、公钥和轮换状态在 Agent 页面配置并保存到 `agent.sqlite`。主机绑定目录同时保存 `identity.json`（Agent 私钥，权限 `0600`），不得改为临时卷或容器内部路径：

```bash
sudo docker compose --env-file /opt/cloud-artifact-management/agent/current/agent.env -f /opt/cloud-artifact-management/agent/current/compose.agent.yaml config
sudo docker compose --env-file /opt/cloud-artifact-management/agent/current/agent.env -f /opt/cloud-artifact-management/agent/current/compose.agent.yaml up -d
sudo docker compose --env-file /opt/cloud-artifact-management/agent/current/agent.env -f /opt/cloud-artifact-management/agent/current/compose.agent.yaml ps
curl -fsS http://127.0.0.1:80/
```

首次登录前，可直接交互式创建 Agent 安全管理员；不需要预先创建系统管理员。需要系统管理员时，再由安全管理员登录页面创建。也可以按运维安排独立初始化系统管理员：

```bash
sudo docker compose --env-file /opt/cloud-artifact-management/agent/current/agent.env -f /opt/cloud-artifact-management/agent/current/compose.agent.yaml exec -it cam-agent node apps/cam-agent/src/bootstrap-admin.js
sudo docker compose --env-file /opt/cloud-artifact-management/agent/current/agent.env -f /opt/cloud-artifact-management/agent/current/compose.agent.yaml exec -it cam-agent node apps/cam-agent/src/bootstrap-security-admin.js
```

Agent 由两个容器组成：`cam-agent` 只监听 Compose 内部的 3103，负责 API、认证、任务调度、缓存和传输；`cam-agent-web` 负责静态页面、Caddy、TLS/反向代理和外部访问，宿主机直接发布 80/443。Caddy 只将 `/api/*` 和 `/health/*` 反代到 Agent API，其余请求由静态文件服务处理。Core Web 如果需要代用户打开该 Agent 页面，必须把 `CAM_AGENT_UPSTREAM` 配置成 Core Web 可达的 Agent Web 地址。Agent 本身直接连接 AAA；Core 负责 Agent 身份注册、授权和正式制品分发，不代理 Agent 用户登录。

Core 与 Agent 完成双向服务身份配对后，再验证 Agent 在线、任务领取和文件摘要校验。若 Agent 经由外部反代连接 Core，需确保反代完整转发 Agent 身份认证请求头、响应签名头及二进制分块响应，并关闭会改变请求路径/响应正文的代理功能。

## 更新、回退和运维

更新只替换目标模块的镜像标签和对应 Compose 文件，不删除或覆盖数据目录。先备份模块数据库、密钥及文件，再导入新镜像、修改 `.env` 中镜像版本并重建容器。联网且已推送到内部仓库时，可先拉取镜像：

```bash
sudo docker compose --env-file /opt/cloud-artifact-management/edge/current/edge.env -f /opt/cloud-artifact-management/edge/current/compose.edge.yaml pull
sudo docker compose --env-file /opt/cloud-artifact-management/edge/current/edge.env -f /opt/cloud-artifact-management/edge/current/compose.edge.yaml up -d
```

对于离线镜像，先 `docker load`，然后直接执行 `up -d`（不要执行 `pull`）。若需回退，恢复旧镜像标签并重新 `up -d`；数据库 schema 迁移若不可逆，必须按本次版本说明恢复一致的数据备份，不能只切回旧镜像。

常用检查：

```bash
sudo docker compose --env-file /opt/cloud-artifact-management/core/current/core.env -f /opt/cloud-artifact-management/core/current/compose.core.yaml logs --tail=200
sudo docker compose --env-file /opt/cloud-artifact-management/core/current/core.env -f /opt/cloud-artifact-management/core/current/compose.core.yaml ps
sudo docker inspect cam-core
```

日志由 Docker `json-file` 驱动按大小轮转。定期检查 Docker 主机可用空间、各模块数据目录增长和备份结果。升级与排障时不得将数据库、私钥、下载令牌、云管密钥或 AAA 共享密钥复制到普通日志、工单或未经批准的区间。

## 离线部署故障排查

### `docker compose` 找不到

确认 Compose 插件位于系统级目录：

```bash
ls -l /usr/local/lib/docker/cli-plugins/docker-compose
sudo docker compose version
```

### Docker 服务启动失败

```bash
systemctl --no-pager --full status docker
journalctl -u docker --no-pager -n 200
```

重点检查二进制架构、`/usr/bin/dockerd`、systemd 服务文件、已有 dockerd 进程和磁盘空间。

### 数据目录权限错误

```bash
findmnt /var/lib/cloud-artifact-management/<module>
ls -ld /var/lib/cloud-artifact-management/<module>
sudo env CAM_DATA_DIR=/var/lib/cloud-artifact-management/edge \
  sh /opt/cloud-artifact-management/edge/current/init-module-data.sh edge
```

Core、Agent 只需将路径和脚本参数替换为 `core`、`agent`，并使用对应的 `CAM_DATA_DIR`。不要把数据目录改成 `777`。初始化脚本应将目录设置为容器用户 `10001:10001` 可写。

## 网络与安全要求

- Edge、Core、每台 Agent 的 Compose 项目和 Docker 网络相互独立；不要为了服务发现而把三个安全区加入同一个跨区 Docker 网络。
- 对外的 HTTPS 由各自安全区的受控反向代理终止。CAM Web/API 的宿主机端口默认绑定回环地址；需要网闸或同机反代访问时，按最小范围调整监听地址和防火墙。
- `CAM_TRUST_PROXY` 只填写实际可信反代网段。Cookie Secure 保持开启；不要在生产环境用明文 HTTP 暴露登录页面。
- 容器以非 root 用户运行，根文件系统只读，临时写入使用受限 tmpfs；只有模块数据目录可持久写入。
- 正式部署文件不包含 Hillstone、网闸模拟器或任何测试 VPN 服务。网闸负责映射和隔离策略，CAM 只配置网闸给出的本侧映射地址。
- 逐个分区导入并核对镜像摘要、配置版本、初始化记录和健康状态。镜像传输与配置文件传输分别走批准的交付通道。
