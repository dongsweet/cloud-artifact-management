# CAM 模块部署配置包

本目录只包含部署配置，不包含镜像和任何真实密钥。

完整的账号、目录、银河麒麟离线安装和模块部署说明见仓库中的 `docs/deployment-guide.md`。

1. 按目标主机修改模块 `.env` 文件中的持久化目录、端口和必要的地址/凭据。
2. 将 `.env` 文件权限设为 `600`。
3. 先执行 `sha256sum -c` 校验镜像包，再执行 `sudo docker load -i` 导入镜像。
4. 初始化数据目录：`sudo CAM_<MODULE>_DATA_DIR=/var/lib/cloud-artifact-management/<module> sh init-module-data.sh <module>`。
5. 校验并启动：`sudo docker compose --env-file <module>.env -f compose.<module>.yaml config`，然后执行 `sudo docker compose ... up -d`。

`.env` 是不含密钥的部署模板；Core 的云管/AAA 密钥和网闸业务配置按部署要求填写或在页面中保存，不要把真实密钥回传到版本库或镜像包。
