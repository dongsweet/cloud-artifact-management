# 外部交换区账号及下载交付

## 身份与权限

`cam-edge` 使用独立本地账号，不连接统一云管密码库或 AAA。本轮实现只包含外部交换区；`cam-core` 的 AAA 登录、云管审批适配器和 `cam-agent` 设备证书仍待后续接入，不能将服务骨架作为已具备正式身份接入的部署。

| 角色 | 页面与 API 权限 |
|---|---|
| `EDGE_ADMIN` | 创建账号、编辑角色和状态、解锁、重置他人密码、查看认证审计 |
| `CANDIDATE_RECEIVER` | 查看并维护产品、版本、轮次、候选包，导入及接收 |
| `VALIDATOR` | 只读查看候选、创建及撤销本人创建的下载授权、查看本人创建或作为责任人的授权 |
| `RELEASE_APPLICANT` | 只读查看候选；预留审批申请角色，尚无审批提交实现 |
| `EDGE_AUDITOR` | 只读查看账号、候选、全部下载授权及其日志、认证审计 |

角色可组合。管理员不隐式获得业务写入或下载授权权限。初始管理员显式配置管理、接收、验证和发布申请四种角色，便于初始化测试；正式环境建议通过账号管理建立职责独立的账号。

## 初始化与部署

先确保宿主机数据目录及权限已配置，使用现有直连部署。初始化命令只在空账号库上可运行，无 HTTP 初始化入口、默认密码或环境变量密码。

```bash
docker compose -f compose.direct.yaml up -d --build cam-edge cam-edge-web
docker compose -f compose.direct.yaml exec -it cam-edge \
  node apps/cam-edge/src/bootstrap-admin.js
```

按提示输入用户名、姓名、初始密码及确认密码。密码隐藏输入、不进入命令参数或日志。密码至少 12 个字符，最多 256 字节。第一次登录须修改密码，修改后重新登录。

账号、会话及认证审计表与现有候选表共用外部区 SQLite 数据库：`${CAM_EDGE_DATA_DIR}/edge/edge.sqlite`，由宿主机本地目录绑定进入容器；重建镜像和容器不会丢失账号。数据库未加密，备份及文件权限按部署规范保护；禁止清空数据目录。SQLite WAL 在线备份应使用 SQLite 备份机制，或停服后复制数据库及对应 WAL 文件，不能只复制运行中的主文件。

配置在项目 `.env`（Compose 默认读取）中设置；如果使用 `deploy/.env`，执行 Compose 时显式加 `--env-file deploy/.env`：

```dotenv
CAM_COOKIE_SECURE=true
CAM_TRUST_PROXY=192.168.240.0/24
```

正式部署使用 HTTPS 和 `CAM_COOKIE_SECURE=true`。测试机当前映射入口为 HTTP，仅该受控测试部署设置 `CAM_COOKIE_SECURE=false`。修改后重建容器才能生效。`CAM_TRUST_PROXY` 只列可信 Caddy 的地址或网络，用于从反代读取真实来源地址和协议；Docker 子网变化时同步修改，不能设为任意来源。

## 认证实现

Fastify `onRequest` 钩子在业务处理之前读取 Cookie、校验会话并生成 `request.principal`，随后检查初始密码状态及角色。拒绝客户端自报账号的请求头。可信身份适配器的 `principalProvider` 是服务构造参数，测试可以注入，部署服务没有启用。

- 密码使用 Node.js 内置 `crypto.scrypt`：随机 16 字节盐、64 字节结果、`N=32768/r=8/p=1`，记录参数以支持后续迁移。
- 会话使用 32 字节随机值；SQLite 保存 SHA-256 摘要；Cookie 使用 `HttpOnly`、`SameSite=Strict`，默认 `Secure`。
- 闲置 30 分钟或绝对 8 小时失效。退出、修改/重置密码、保存角色或账号状态时撤销相关会话。
- 修改请求须携带 `X-CAM-CSRF`，与当前会话绑定的随机摘要匹配；浏览器从 `cam_csrf` Cookie 获取。跨站 Origin 被拒绝。
- 连续 5 次失败锁定账号 1 分钟，后续失败递增，最长 60 分钟；同来源每分钟最多 20 次登录请求；进程最多并行处理 4 次密码派生，限制 CPU/内存压力。
- 锁定可由管理员在编辑账号中保存解除。不能禁用自己的管理员账号或移除自己的管理员角色，也不能移除最后一个有效管理员。账号采用禁用而非删除，以保留审计关联。

认证事件记录登录成功/失败、退出、账号创建及修改、密码修改或重置。业务修改请求额外记录操作者、方法和路由模板，表示操作尝试，不能当作业务成功的证明。页面提供最新 200 条只读事件；完整业务结果审计及外部日志归档后续补充。

SQLite 表：

| 表 | 内容 |
|---|---|
| `edge_users` | 用户 ID、用户名、姓名、密码结果/盐/参数、角色 JSON、状态、初始改密标记、锁定及时间 |
| `edge_sessions` | 会话 ID、用户 ID、会话/CSRF 摘要、绝对到期和最近活动、撤销、来源及 User-Agent |
| `edge_auth_events` | 事件 ID、操作者、类型、来源、详情及时间 |

角色采用固定枚举，用户角色保存在 `roles_json`；目前不允许页面自定义权限。未引入认证依赖、ORM、Redis 或外部会话服务。

## 页面及接口

页面右上角提供当前账号、改密码和退出。左侧增加“账号管理”和“下载授权”，按角色显示入口；隐藏按钮不替代服务器校验。产品、版本、轮次和候选页面继续使用现有 hash 导航及加载保护。

| 接口 | 用途 |
|---|---|
| `POST /api/v1/auth/login` | 登录并写入会话及 CSRF Cookie |
| `GET /api/v1/auth/me` | 当前账号及角色标签 |
| `POST /api/v1/auth/logout` | 撤销当前会话 |
| `POST /api/v1/auth/password` | 提供旧密码修改本人密码，撤销所有会话 |
| `GET/POST /api/v1/users` | 查看/创建账号 |
| `PATCH /api/v1/users/:id` | 编辑角色、姓名、状态并解锁，撤销该用户所有会话 |
| `POST /api/v1/users/:id/password` | 管理员重置他人密码，下次登录强制改密 |
| `GET /api/v1/auth-events` | 最新 200 条认证与操作尝试事件 |
| `GET /api/v1/validators` | 可关联的验证人员 ID、用户名和姓名 |
| `GET/POST /api/v1/download-grants` | 授权列表/创建授权 |
| `GET/DELETE /api/v1/download-grants/:id` | 授权详情及最近事件/撤销本人创建的授权 |

初始化、改密、账号管理接口均不回传密码结果、盐或会话摘要；日志不记录请求正文或认证请求头。

## 浏览器及测试服务器交付

轮次详情“交付验证”和已完成候选详情“下载 / 交付验证”提供创建入口；左侧“下载授权”提供授权管理。选择文件、已启用且完成初始改密的验证人员、有效天数（最长 30 天）、总会话次数及每文件会话次数。

创建后可直接点击浏览器下载，或导出带 Token 的 JSON、链接文本给测试人员。Token 仅本次创建时可获得，关掉导出窗口后无法从数据库恢复，需要时撤销旧授权并创建新的。导出链接使用当前浏览器访问的入口地址，保证经映射访问时不会包含容器地址或内部端口。

`created_by` 记录创建者，`principal_id` 记录下载责任人。浏览器已登录时，下载日志记录实际登录账号；测试服务器只携带 Token 时，调用身份记为 `TOKEN:<grantId>`，关联责任人但不声称验证了责任人本人。授权持有者可调用，不是登录凭证；负责人员禁用、失去验证角色或进入待改密状态时，拒绝新下载和续传请求。

Token 接口不要求人员登录 Cookie 或 Cookie CSRF，而是校验 Token 摘要、范围、期限、撤销状态和累计/单文件次数：

| 接口 | 约束 |
|---|---|
| `GET /api/v1/download-grants/:id/manifest` | 用 Token 获取授权文件清单，不恢复其他授权 |
| `POST /api/v1/downloads/:candidateId/session` | 开始或恢复会话；每个新会话扣一次，恢复同一会话不重复扣 |
| `GET /api/v1/downloads/:candidateId/content` | 接受 Bearer 或链接 Token、单区间 Range、`X-CAM-Download-Session` |

测试服务器建议使用 Bearer 请求头，避免 Token 链接留在命令历史。首次响应保存 `X-CAM-Download-Session`；中断后用本地已有字节长度作为 Range 起点并传回同一会话 ID。普通下载工具仅加 `-C -` 而不复用会话 ID，会消耗新的下载次数。

```bash
# CAM_DOWNLOAD_TOKEN 从受保护文件/交互输入读入，不能将其值写入日志。
curl -f -D response.headers \
  -H "Authorization: Bearer ${CAM_DOWNLOAD_TOKEN}" \
  -o package.part "https://cam.example/api/v1/downloads/<candidateId>/content"
# 按 response.headers 中的 X-CAM-Download-Session 值设置 CAM_DOWNLOAD_SESSION。
curl -f -C - -H "Authorization: Bearer ${CAM_DOWNLOAD_TOKEN}" \
  -H "X-CAM-Download-Session: ${CAM_DOWNLOAD_SESSION}" \
  -o package.part "https://cam.example/api/v1/downloads/<candidateId>/content"
sha256sum package.part
```

新下载会话的次数计数在 SQLite 事务内执行，非法 Range 不扣次数。完成事件表示服务器完成响应，不证明测试服务器已落盘或已校验，接收端仍须核对清单摘要。正在发送的响应不因撤销授权自动截断，新请求会被拒绝。审计关联的候选文件暂保留，由授权外键阻止永久删除；后续归档/保留策略另行实现。
