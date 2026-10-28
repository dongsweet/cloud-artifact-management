# 银河麒麟离线准备与 CAM 部署

本文记录在不能联网的银河麒麟服务器上部署 CAM Edge 的完整准备步骤，包括 2T 数据盘分区、Docker 二进制安装、Docker Compose 安装、Docker systemd 服务、SELinux 处理和 Edge 启动验证。

命令默认按 root 执行；普通用户请在需要写入系统目录或管理 Docker 服务的命令前加 sudo。本文中的 /dev/vdb 只是示例设备名，必须先根据 lsblk 确认，不能直接照搬到其他机器。

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

## 7. 初始化 CAM Edge 数据目录

将 CAM 的 Edge 部署文件复制到服务器，至少包括：

- deploy/compose.edge.yaml
- deploy/edge.env.example
- deploy/init-module-data.sh
- Edge 和 Edge Web 镜像或离线镜像归档

准备配置：

    cp deploy/edge.env.example deploy/edge.env
    chmod 600 deploy/edge.env
    vi deploy/edge.env

确认 CAM_EDGE_DATA_DIR 指向：

    /var/lib/cloud-artifact-management/edge

初始化目录权限：

    CAM_EDGE_DATA_DIR=/var/lib/cloud-artifact-management/edge \
      sh deploy/init-module-data.sh edge

不要把 CAM 数据目录改成 777；初始化脚本会按容器用户 10001:10001 设置访问权限。

## 8. 导入离线镜像

如果收到镜像归档和校验文件，先校验再导入：

    sha256sum -c cam-images-<版本>.tar.sha256
    docker load -i cam-images-<版本>.tar
    docker image ls

Compose 文件中的镜像名和标签必须与 docker image ls 的结果完全一致。离线环境不要执行 docker compose pull，也不要在 Compose 中使用 build 或 pull_policy: always。

## 9. 启动并验证 Edge

先检查 Compose 展开结果：

    docker compose --env-file deploy/edge.env \
      -f deploy/compose.edge.yaml config

启动 Edge：

    docker compose --env-file deploy/edge.env \
      -f deploy/compose.edge.yaml up -d

查看服务：

    docker compose --env-file deploy/edge.env \
      -f deploy/compose.edge.yaml ps

查看日志：

    docker compose --env-file deploy/edge.env \
      -f deploy/compose.edge.yaml logs --tail=200

健康检查：

    curl -fsS http://127.0.0.1:3101/health/ready
    curl -fsS http://127.0.0.1:8088/

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
      sh deploy/init-module-data.sh edge

不要通过把目录改成 777 来绕过权限问题。

