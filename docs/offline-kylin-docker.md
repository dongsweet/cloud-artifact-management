# 银河麒麟离线准备与 CAM 部署

本文记录在不能联网的银河麒麟服务器上部署 CAM Edge、Core 或 Agent 的完整准备步骤，包括 2T 数据盘分区、Docker 二进制安装、Docker Compose 安装、Docker systemd 服务、SELinux 处理和模块启动验证。

正式环境不要在 root 家目录下保存和运行 CAM。本文假设专用的普通运维账号名为 `sugon`：它负责接收部署包、维护 Compose 配置和执行日常发布；root 只用于磁盘、Docker、systemd、防火墙和 `/var/lib` 等系统级操作。本文中的 `/dev/vdb` 只是示例设备名，必须先根据 `lsblk` 确认，不能直接照搬到其他机器。

## 0. 部署账号和目录规范

以下账号初始化命令由 root 执行。账号应使用个人 SSH 密钥或企业账号登录，不共享 root 密码：

    useradd --create-home --shell /bin/bash sugon
    passwd sugon
    id sugon

CAM 容器仍以镜像内的 `10001:10001` 运行，不能把宿主机的 `sugon` UID 当成容器用户。若允许 `sugon` 直接执行 Docker，可加入 `docker` 组并重新登录：

    usermod -aG docker sugon
    su - sugon
    docker version

`docker` 组具有接近 root 的主机控制能力；安全基线不允许时，不要加入该组，改用经过审计的 `sudo docker` / `sudo docker compose`。无论采用哪种方式，都不要用 root 作为日常应用部署账号。

推荐目录布局：

    /opt/cloud-artifact-management/<module>/releases/<version>/  # Compose、.env、初始化脚本
    /opt/cloud-artifact-management/<module>/current              # 指向当前版本的符号链接
    /var/lib/cloud-artifact-management/<module>/                 # SQLite、身份密钥、制品和缓存
    /var/tmp/cam-incoming/                                       # 临时接收镜像和配置包

其中 `<module>` 为 `edge`、`core` 或 `agent`。`/opt` 下的发布配置由 `sugon:sugon` 管理，版本目录建议 `0750`；实际 `.env` 含部署凭据，必须为 `0600`。`/var/lib/cloud-artifact-management` 是应用持久化数据目录，由 root 创建，模块目录交给容器 UID `10001:10001`，不要放在 `/home/sugon` 或 `/root` 下。Docker 镜像层仍默认放在 `/var/lib/docker`，除非另行设计 Docker data-root，不要把它和 CAM 数据目录混用。

创建基础目录示例：

    install -d -o sugon -g sugon -m 0750 /opt/cloud-artifact-management
    install -d -o sugon -g sugon -m 0700 /var/tmp/cam-incoming
    install -d -o root -g root -m 0755 /var/lib/cloud-artifact-management

## 1. 确认系统和磁盘

先执行只读检查：

    uname -m
    cat /etc/os-release
    lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL,SERIAL
    fdisk -l

确认 2T 盘是独立数据盘、不是系统盘，也没有挂载到其他目录。假设本机确认数据盘为 /dev/vdb，系统盘为 /dev/vda。

格式化前再检查磁盘是否已有签名：

    wipefs -n /dev/vdb
    fdisk -l /dev/vdb

如果显示已有分区或文件系统，先停止操作并确认数据是否需要保留。只有确认该盘为空盘后，才能执行下一节的分区和格式化命令。

## 2. 分区并挂载 Edge 数据盘

下面示例将 /dev/vdb 建为 GPT，并创建一个占满磁盘的 ext4 分区。所有命令都会破坏 /dev/vdb 上原有数据：

    parted -s /dev/vdb mklabel gpt
    parted -s -a optimal /dev/vdb mkpart primary ext4 1MiB 100%
    partprobe /dev/vdb
    udevadm settle

    mkfs.ext4 -L cam-edge-data /dev/vdb1
    tune2fs -m 1 /dev/vdb1

创建并挂载 CAM Edge 数据目录：

    mkdir -p /var/lib/cloud-artifact-management/edge
    mount /dev/vdb1 /var/lib/cloud-artifact-management/edge
    df -h /var/lib/cloud-artifact-management/edge
    blkid /dev/vdb1

记录 blkid 输出中的 UUID，并编辑开机挂载配置：

    vi /etc/fstab

追加一行，将下面的 UUID 替换成实际值：

    UUID=实际UUID  /var/lib/cloud-artifact-management/edge  ext4  defaults,noatime  0  2

验证 fstab：

    umount /var/lib/cloud-artifact-management/edge
    mount -a
    findmnt /var/lib/cloud-artifact-management/edge

本数据盘用于 CAM Edge 的 SQLite、候选包、日志和密钥等持久化数据；Docker 自身的镜像和容器数据默认仍在 /var/lib/docker。如需把 Docker 根目录也迁移到数据盘，应另行设计和验证，不要直接修改本步骤。

## 3. 离线安装 Docker 二进制

将 Docker 压缩包和校验文件通过受控介质复制到服务器。先核对文件，再查看压缩包内容：

    sha256sum docker-<版本>.tgz
    tar -tzf docker-<版本>.tgz

解压并安装 Docker 客户端和 daemon：

    tar -xzf docker-<版本>.tgz
    install -m 0755 docker/* /usr/bin/

确认二进制架构和版本：

    uname -m
    file /usr/bin/docker /usr/bin/dockerd
    docker --version
    dockerd --version

如果出现 exec format error，说明二进制架构与 uname -m 不匹配，应重新准备对应架构的 Docker 压缩包。

## 4. 创建 Docker systemd 服务

新增服务文件：

    vi /usr/lib/systemd/system/docker.service

写入以下内容：

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

加载并启动 Docker：

    systemctl daemon-reload
    systemctl enable docker
    systemctl start docker
    systemctl --no-pager --full status docker
    docker version
    docker info

如果已有发行版 Docker 服务，先使用 systemctl cat docker.service 检查，避免两个服务或两个 dockerd 同时运行。

## 5. 安装 Docker Compose

将 Compose v2 二进制复制到 /usr/bin/docker-compose：

    install -m 0755 docker-compose /usr/bin/docker-compose
    docker-compose version

输出应为 Compose v2.x。如果是 v1.x，它只能作为独立的 docker-compose 命令使用，不能注册为 docker compose 插件；需要准备对应架构的 Compose v2 二进制。

注册为 Docker CLI 插件，使两种命令都可用：

    mkdir -p /usr/local/lib/docker/cli-plugins
    install -m 0755 /usr/bin/docker-compose \
      /usr/local/lib/docker/cli-plugins/docker-compose

验证：

    docker-compose version
    docker compose version
    docker compose ls

如果只为当前用户安装插件，可使用：

    mkdir -p "$HOME/.docker/cli-plugins"
    install -m 0755 /usr/bin/docker-compose "$HOME/.docker/cli-plugins/docker-compose"
    docker compose version

正式部署建议使用 /usr/local/lib/docker/cli-plugins 系统级目录，避免 Compose 只能被某个登录用户发现。

## 6. 禁用 SELinux

当前银河麒麟部署方案要求关闭 SELinux。先查看当前状态：

    getenforce

修改配置文件：

    sed -i 's/^SELINUX=.*/SELINUX=disabled/' /etc/selinux/config

重启服务器使配置生效：

    reboot

重启后确认：

    getenforce

输出应为 Disabled。禁用 SELinux 会降低主机的强制访问控制能力；正式环境应确认这是所在安全基线允许的部署要求，并配合防火墙、最小权限和受控网络策略。

## 7. 解包模块配置并初始化数据目录

每台主机只接收对应模块的镜像包和配置包。例如 Edge 主机接收：

- `cam-edge-images-<版本>.tar` 及其 `.sha256`
- `cam-edge-config-<版本>.tar` 及其 `.sha256`

Core、Agent 分别替换为各自前缀。配置包先放到 `/var/tmp/cam-incoming`，校验后由 `sugon` 解包到版本目录；不要直接在 `/root` 下解包：

    cd /var/tmp/cam-incoming
    sha256sum -c cam-edge-config-<版本>.tar.sha256
    tar -xf cam-edge-config-<版本>.tar
    sudo install -d -o sugon -g sugon -m 0750 \
      /opt/cloud-artifact-management/edge/releases/<版本>
    sudo cp -a cam-edge-config-<版本>/. \
      /opt/cloud-artifact-management/edge/releases/<版本>/
    sudo chown -R sugon:sugon \
      /opt/cloud-artifact-management/edge/releases/<版本>
    sudo chmod 600 \
      /opt/cloud-artifact-management/edge/releases/<版本>/edge.env
    sudo ln -sfn releases/<版本> \
      /opt/cloud-artifact-management/edge/current

将上面的 `edge` 替换为 `core` 或 `agent`，并使用对应的 `.env` 文件。编辑配置时使用当前版本目录中的文件：

    vi /opt/cloud-artifact-management/edge/current/edge.env

配置中的数据目录应分别指向：

    /var/lib/cloud-artifact-management/edge
    /var/lib/cloud-artifact-management/core
    /var/lib/cloud-artifact-management/agent

初始化目录权限时使用对应模块配置和脚本：

    sudo CAM_EDGE_DATA_DIR=/var/lib/cloud-artifact-management/edge \
      sh /opt/cloud-artifact-management/edge/current/init-module-data.sh edge

Core、Agent 分别设置 `CAM_CORE_DATA_DIR`、`CAM_AGENT_DATA_DIR`。不要把 CAM 数据目录改成 `777`；初始化脚本会按容器用户 `10001:10001` 设置访问权限。

## 8. 导入离线镜像

镜像 `.tar` 是 Docker 镜像归档，不需要用 `tar -xf` 解包；校验通过后直接 `docker load`：

    cd /var/tmp/cam-incoming
    sha256sum -c cam-edge-images-<版本>.tar.sha256
    docker load -i cam-edge-images-<版本>.tar
    docker image inspect cam-backend:<版本> cam-edge-web:<版本>

Core、Agent 分别检查 `cam-core-web:<版本>`、`cam-agent-web:<版本>`。Compose 文件中的镜像名和标签必须与 `docker image ls` / `docker image inspect` 的结果完全一致。离线环境不要执行 `docker compose pull`，也不要在 Compose 中使用 `build` 或 `pull_policy: always`。

## 9. 启动并验证模块

以 Edge 为例，日常命令由 `sugon` 执行；若未加入 `docker` 组，则在命令前加 `sudo`：

    cd /opt/cloud-artifact-management/edge/current
    docker compose --env-file edge.env -f compose.edge.yaml config
    docker compose --env-file edge.env -f compose.edge.yaml up -d

查看服务：

    docker compose --env-file edge.env -f compose.edge.yaml ps

查看日志：

    docker compose --env-file edge.env -f compose.edge.yaml logs --tail=200

健康检查：

    curl -fsS http://127.0.0.1:3101/health/ready
    curl -fsS http://127.0.0.1:8088/

Core 使用 `current/core.env` 与 `compose.core.yaml`，Agent 使用 `current/agent.env` 与 `compose.agent.yaml`；健康检查端口分别按对应 Compose 文件和 `.env` 设置确认。升级时创建新的 `releases/<版本>`，校验配置和镜像后再切换 `current`，不要覆盖正在运行的版本目录。回退时把 `current` 指回上一版本并重新执行 `up -d`。

正式 HTTPS 入口由所在安全区的受控反向代理提供，CAM Web 默认只绑定本机受控端口。不要把 API 端口直接暴露到不受控网络。

## 10. 常见问题

### 只支持 docker-compose，不支持 docker compose

通常是 Compose 二进制只放在了 /usr/bin，还没有放入 Docker CLI 插件目录：

    mkdir -p /usr/local/lib/docker/cli-plugins
    install -m 0755 /usr/bin/docker-compose \
      /usr/local/lib/docker/cli-plugins/docker-compose
    docker compose version

### Docker 服务启动失败

查看服务和 daemon 日志：

    systemctl --no-pager --full status docker
    journalctl -u docker --no-pager -n 200

常见原因包括二进制架构错误、/usr/bin/dockerd 不存在、服务文件语法错误、已有 dockerd 占用 socket 或磁盘空间不足。

### 数据目录权限错误

确认挂载点和目录属主：

    findmnt /var/lib/cloud-artifact-management/edge
    ls -ld /var/lib/cloud-artifact-management/edge
    CAM_EDGE_DATA_DIR=/var/lib/cloud-artifact-management/edge \
      sh /opt/cloud-artifact-management/edge/current/init-module-data.sh edge

不要通过把目录改成 777 来绕过权限问题。

