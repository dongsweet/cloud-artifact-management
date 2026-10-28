# 银河麒麟离线安装 Docker 与 Compose

本文记录在不能联网的银河麒麟服务器上，使用已准备好的 Docker 和 Docker Compose 二进制文件，并让 docker compose 子命令生效的步骤。命令默认以 root 执行；普通用户请在需要写入系统目录或管理 Docker 服务的命令前加 sudo。

## 1. 安装前检查

    uname -m
    cat /etc/os-release
    docker --version
    docker-compose version

CAM 正式镜像必须与主机架构匹配。离线介质应同时提供 Docker Engine、Compose v2、镜像归档及其 SHA-256 校验文件。不要在目标机上临时下载依赖或让 Compose 自动拉取镜像。

## 2. 放置 Docker Compose 二进制

假设已将 Compose 二进制复制到 /usr/bin/docker-compose：

    install -m 0755 docker-compose /usr/bin/docker-compose
    docker-compose version

输出应为 Compose v2.x。如果是 v1.x，它只能作为独立的 docker-compose 命令使用，不能注册为 docker compose 插件；需要准备对应架构的 Compose v2 二进制。

## 3. 注册为 Docker CLI 插件

docker-compose 独立命令与 docker compose 子命令的发现机制不同。后者要求 Docker CLI 在 CLI 插件目录中找到名为 docker-compose 的可执行文件：

    mkdir -p /usr/local/lib/docker/cli-plugins
    install -m 0755 /usr/bin/docker-compose \
      /usr/local/lib/docker/cli-plugins/docker-compose

验证两种调用方式：

    docker-compose version
    docker compose version
    docker compose ls

如果只对当前用户安装插件，也可以使用：

    mkdir -p "$HOME/.docker/cli-plugins"
    install -m 0755 /usr/bin/docker-compose "$HOME/.docker/cli-plugins/docker-compose"
    docker compose version

正式部署建议使用 /usr/local/lib/docker/cli-plugins 系统级目录，避免 Compose 只能被某个登录用户发现。

## 4. 验证 Docker 服务

    systemctl enable --now docker
    systemctl --no-pager --full status docker
    docker version
    docker info

如果系统没有 systemctl，按银河麒麟当前 Docker 安装包提供的服务管理方式启动 Docker；不要同时启动多个 Docker daemon。

## 5. 导入离线镜像

    sha256sum -c cam-images-<版本>.tar.sha256
    docker load -i cam-images-<版本>.tar
    docker image ls

Compose 文件中的镜像名和标签必须与导入结果完全一致。离线环境不要执行 docker compose pull，也不要在 Compose 中使用 build 或 pull_policy: always。

## 6. 验证 CAM Compose

以 Edge 为例，把部署文件、edge.env 和 deploy/compose.edge.yaml 放在同一部署目录中：

    docker compose --env-file deploy/edge.env -f deploy/compose.edge.yaml config
    docker compose --env-file deploy/edge.env -f deploy/compose.edge.yaml up -d
    docker compose --env-file deploy/edge.env -f deploy/compose.edge.yaml ps

确认健康状态：

    curl -fsS http://127.0.0.1:3101/health/ready
    curl -fsS http://127.0.0.1:8088/

Core 和 Agent 只需替换对应的配置文件和 Compose 文件：

    docker compose --env-file deploy/core.env -f deploy/compose.core.yaml up -d
    docker compose --env-file deploy/agent.env -f deploy/compose.agent.yaml up -d

不要使用开发联调用的根目录 compose.yaml 或 compose.direct.yaml 部署正式分区。

## 7. 常见问题

### 只支持 docker-compose，不支持 docker compose

通常是 Compose 二进制只放在了 /usr/bin，还没有放入 Docker CLI 插件目录。重新执行：

    mkdir -p /usr/local/lib/docker/cli-plugins
    install -m 0755 /usr/bin/docker-compose \
      /usr/local/lib/docker/cli-plugins/docker-compose
    docker compose version

### exec format error

Compose 或 Docker 二进制的架构与主机不一致：

    uname -m
    file /usr/bin/docker /usr/bin/docker-compose

重新准备与 uname -m 对应的二进制；不要只根据操作系统名称判断架构。

### 找不到镜像或尝试联网拉取

    docker image ls
    docker compose --env-file deploy/edge.env -f deploy/compose.edge.yaml config

离线环境应通过 docker load 导入批准的镜像归档，并把 .env 中的镜像标签改为本次交付版本。

### 数据目录权限错误

    CAM_EDGE_DATA_DIR=/var/lib/cloud-artifact-management/edge \
      sh deploy/init-module-data.sh edge

不要通过把目录改成 777 来绕过权限问题。

