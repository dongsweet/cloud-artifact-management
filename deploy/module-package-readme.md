# CAM 模块部署配置包

本目录只包含部署配置，不包含镜像和任何真实密钥。

完整的账号、目录、银河麒麟离线安装和模块部署说明见仓库中的 `docs/deployment-guide.md`。

交付包统一输出到版本目录 `v<版本>/`，例如 `cam/v0.2.4/`。同一版本目录内包含对应模块的镜像包、配置包及 SHA-256 校验文件；不要把包直接输出到交付根目录。

1. 按目标主机修改模块 `.env` 文件中的持久化目录、端口和必要的地址/凭据。
2. 将 `.env` 文件权限设为 `600`。
3. 先执行 `sha256sum -c` 校验镜像包，再执行 `sudo docker load -i` 导入镜像。
4. 初始化数据目录：`sudo env CAM_DATA_DIR=/var/lib/cloud-artifact-management/<module> sh init-module-data.sh <module>`。
5. 校验并启动：`sudo docker compose --env-file <module>.env -f compose.<module>.yaml config`，然后执行 `sudo docker compose ... up -d`。

Core 或 Edge 所在主机没有 DNS 时，直接编辑对应的 `compose.core.yaml` 或 `compose.edge.yaml`，取消 `extra_hosts` 示例注释并替换为现场 IP；主机的 `/etc/hosts` 不会自动传入容器。修改后使用原 Compose 命令重新创建对应后端容器。具体说明见部署指南“无 DNS 服务器时的域名解析”。

Edge 首次启动后，先在 Core 登记 Edge 身份公钥，再执行容器内的 `apps/cam-edge/src/bootstrap-gate.js` 初始化 Core 地址和 Core 身份信任。该脚本只显示 Edge 身份公钥包，不显示或导出 Edge 私钥；配置包中的同名文件仅用于留存部署说明，不能在宿主机直接执行。

`.env` 是不含密钥的部署模板；Core 的云管/AAA 密钥和网闸业务配置按部署要求填写或在页面中保存，不要把真实密钥回传到版本库或镜像包。
