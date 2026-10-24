# Core 正式制品查询接口

## Core 与 Agent 的双向身份签名

Agent 请求继续使用本机独立 Ed25519 私钥签名。规范化内容为 `HTTP_METHOD`、不含 query 的 `PATH`、`TIMESTAMP`、`NONCE` 和原始请求体的 SHA-256，Core 按 Agent 当前公钥验签并检查时间窗口与 nonce 重放。首次请求使用 `x-cam-agent-key-id` 携带本机公钥 SHA-256 指纹作为查找提示，Core 验签成功后在身份策略响应中返回稳定 Agent 编号；Agent 持久保存该编号并在后续请求中使用。编号只用于 Core 内部定位记录和关联任务，不是凭证，也不需要写入 Agent 部署配置。Agent 密钥轮换期间仍以稳定编号关联记录，丢失本地编号时可用已登记的公钥指纹重新发现。

Core 为 Agent API 生成并持久化独立服务身份，私钥位于 Core 数据目录的 `core-agent-identity.json`（权限 `0600`），不会离开 Core。每个 `/api/v1/agent/*` 响应（包括业务错误）都签名，签名覆盖 `HTTP_STATUS`、`HTTP_METHOD`、不含 query 的 `PATH`、对应请求 nonce、响应时间戳和原始响应体 SHA-256。响应头为 `x-cam-core-key-id`、`x-cam-core-timestamp`、`x-cam-core-signature`。Agent 必须先验证时间戳、key ID 和签名，再解析响应或执行任务；缺少可信 Core 公钥或签名不匹配时拒绝响应。

首次配对时，将 Core 管理界面 Agent 管理页显示的 Core 服务公钥直接粘贴到 Agent“Core 身份配对”页的“Core 服务公钥”输入框，填写 Core 地址，保存并测试配对。配置在 Agent 本地 SQLite 持久化，立即生效，重启后优先于部署默认值 `CAM_CORE_URL`、`CAM_CORE_PUBLIC_KEY` / `CAM_CORE_PUBLIC_KEY_B64`。Core 服务私钥不用于 Agent 身份，也不替代每台 Agent 自己的私钥。缺少 Core 公钥时拒绝发起业务请求。

Core 密钥轮换采用显式双钥过渡。Core 管理页面的轮换操作立即生成并切换新密钥，管理员随后在各 Agent 页面点击“更换 Core 身份”，粘贴新公钥、核对指纹并明确确认；保存时保留当前已信任公钥作为旧公钥，必须指定未来 30 天以内的过渡期，到期后旧签名失效。尚未更新的离线 Agent 不会自动信任未知签名密钥，需管理员更新其信任配置后恢复。当前没有自动 Core 换钥分发协议。Core 服务身份文件应持久保存；丢失后重新生成身份须按身份重置流程重新分发公钥。

### Agent 本地 Core 配置接口

这些接口要求 Agent 本地管理员登录；写请求同时要求 `x-cam-agent-csrf`。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/core-config` | 返回 `{ item }`，含 Core 地址、当前/旧公钥及指纹、旧公钥过期时间、配置来源和最近测试状态，不返回私钥 |
| `PUT /api/v1/core-config` | 保存 `coreUrl`、`corePublicKey`；替换已有公钥须 `confirmTrustChange: true`，旧公钥须为当前已信任公钥，并指定 `previousPublicKeyExpiresAt`；传输或身份同步中返回 409 |
| `POST /api/v1/core-config/test` | 测试已保存配置，通过 Agent 签名认证并验证 Core 响应签名，完成身份确认；记录 `PASSED` / `FAILED` 和时间 |

保存配置会清除之前的配对确认及重试退避状态，下次签名同步后才能重新显示配对成功。测试失败信息显示在配置卡片内，定时刷新不覆盖未保存编辑。

本文定义 Core 正式制品目录的稳定查询模型，供管理页面和后续 `cam-agent` 分发流程共用。

## 目录模型

正式制品按两级组织：软件产品和版本。修订版本显示为独立版本，例如 `8.0.6.2-r1`。Edge 的候选收集轮次只属于固化工作流；Core 正式目录不按轮次分组，也不将轮次号作为 Agent 的发布选择条件。

一个版本基线由 `artifactId` 唯一标识，当前格式为 `BASELINE-<requestId>`。基线包含审批通过并完成传输回执的版本元数据，以及不可变文件清单。文件按 SHA-256 寻址，同一字节对象可以被多个版本条目引用；每个版本仍保留自己的包标识、原始文件名和来源标记。

## 查询接口

### 列出已接收版本

```http
GET /api/v1/artifacts
```

响应仅包含审批通过且传输状态为 `RECEIVED` 的正式版本：

```json
{
  "items": [
    {
      "artifactId": "BASELINE-FREEZE-123",
      "artifactType": "RELEASE_BASELINE",
      "requestId": "FREEZE-123",
      "releaseId": "REL-456",
      "productName": "曙光云 Stack",
      "version": "8.0.6.2",
      "revision": 1,
      "displayVersion": "8.0.6.2-r1",
      "status": "APPROVED",
      "manifestSha256": "<sha256>",
      "cloudApprovalId": "APR-789",
      "transferTaskId": "TRANSFER-789",
      "approvedAt": "2026-10-17T00:00:00.000Z",
      "receivedAt": "2026-10-17T00:05:00.000Z",
      "files": [
        {
          "packageKey": "control-node",
          "candidateId": "CAND-001",
          "fileName": "control-node.tar.gz",
          "sizeBytes": 1048576,
          "sha256": "<sha256>",
          "source": "INHERITED",
          "stored": true,
          "downloadUrl": "/api/v1/artifacts/<sha256>/content"
        }
      ]
    }
  ]
}
```

### 查询单个版本基线

```http
GET /api/v1/artifacts/:artifactId
```

返回 `{ "item": <版本基线> }`。Agent 应在分发任务中保存并使用 `artifactId`，然后核对目标版本、`manifestSha256` 和每个文件的 `sizeBytes`、`sha256`。

Core 分发页面使用业务只读接口 `GET /api/v1/distribution-agents` 获取 Agent 的基本信息，并在页面上只允许选择处于启用状态的 Agent。该接口只返回 Agent 编号、中心、名称和状态；身份公钥、轮换状态等配置详情仍由 `GET /api/v1/agents` 管理接口提供。

### Core 接收传输监控

审批详情页使用下面的业务只读接口展示 Edge → Core 的接收过程：

```http
GET /api/v1/approval-requests/:requestId/transfer-progress
```

响应包含传输任务通知状态、总体状态、文件/字节汇总，以及每个文件的 SHA-256、已接收分块数、分块总数、已接收字节和本机是否已入库。总体状态包括 `WAITING_AUTHORIZATION`、`WAITING_EDGE`、`RECEIVING`、`VERIFYING` 和 `COMPLETED`。相同 SHA-256 被多个包引用时，每个包仍单独展示清单进度，但已存在的内容寻址对象标记为可复用，不会重复占用存储空间。

### 下载正式制品

```http
GET /api/v1/artifacts/:sha256/content
```

文件下载地址由清单的 `downloadUrl` 给出。客户端必须自行校验下载字节的长度和 SHA-256，并且只有校验通过后才可将文件标记为本地可用。

### Agent 本地人工交付

Core 的正式制品下载接口只服务于已签名的 Agent 分发任务；云中心部署人员不直接从 Core 或 Edge 取包。Agent 将完成校验的对象按 SHA-256 保存在本地缓存后，登录 Agent 页面，在“正式制品库”中选择版本并创建“部署交付”授权。这个授权面向当前人工部署流程，限制正式版本、文件范围、有效期、总会话次数和单文件会话次数。

创建授权响应只返回一次随机下载 Token。Agent 数据库只保存 Token 的 SHA-256 摘要；部署人员得到的短期链接可通过浏览器或下载工具访问 Agent 的文件接口，也可以使用 `Authorization: Bearer`。接口支持 HTTP Range 和 `X-CAM-Download-Session` 断点续传，同一文件同一会话的续传不重复消耗次数。授权可以撤销，过期或撤销后不再接受新的下载请求。

Agent 页面会显示每个授权的版本、文件数、会话用量和状态，并可打开下载明细查看文件进度、累计字节、下载人、来源地址、开始/更新时间、完成时间和错误。下载完成后仍需按清单中的文件大小和 SHA-256 做人工核对。下载事件和会话记录保存在 Agent 自己的 `agent.sqlite`，不回写 Core；Core→Agent 分发与 Agent→部署人员交付是两个独立的授权边界。

Agent 交付接口如下：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/delivery-grants` | 登录后查询本 Agent 创建的交付授权 |
| `POST /api/v1/delivery-grants` | 从已缓存正式版本创建有范围、有期限和次数上限的交付授权；Token 只在响应中返回一次 |
| `GET /api/v1/delivery-grants/:grantId` | 查询授权及下载会话明细 |
| `DELETE /api/v1/delivery-grants/:grantId` | 撤销授权，阻止后续下载 |
| `GET /api/v1/delivery-grants/:grantId/manifest?token=...` | 用短期 Token 获取带下载链接的文件清单 |
| `POST /api/v1/delivery-grants/:grantId/files/:sha256/session` | 用 Token 创建或恢复一个文件下载会话 |
| `GET /api/v1/delivery-grants/:grantId/files/:sha256/content` | 用 Token 下载 Agent 本地缓存文件，支持 Range 和断点续传 |

### Agent 正式制品与传输任务接口

Agent 页面把正式制品作为本地工作台，把 Core→Agent 的传输任务作为独立任务中心。正式制品目录只展示 Core 已授权的全量正式版本；Agent 点击“拉取”时先请求 Core 创建或重新排队分发任务，文件仍由 Agent 主动分块拉取。目录响应中的 `files[].cached`、`files[].cacheState` 和版本级 `agentStatus` 用于显示本机缓存与跨版本 SHA-256 复用情况。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/available-artifacts` | 查询 Core 全量正式版本；附带版本级缓存摘要、文件级缓存状态、最近任务和可复用文件信息 |
| `GET /api/v1/cache/summary` | 查询缓存对象数、缓存文件数、占用空间、可用空间、异常对象数和检查时间 |
| `GET /api/v1/tasks` | 查询本地传输任务；返回展示状态、文件/字节进度、尝试次数、下次重试时间和最近错误 |
| `GET /api/v1/tasks/:taskId` | 查询单个任务及逐文件、分块进度和本机复用状态 |
| `POST /api/v1/tasks/:taskId/retry` | 请求 Core 将归属本 Agent 的失败任务立即放回可领取队列，并触发 Agent 重新轮询 |

任务展示状态将 Core 的 `QUEUED + lastError + retryAt` 转换为“重试等待”。任务详情中的 `reused` 表示同一 SHA-256 对象已经在本机缓存，文件不会再次下载。缓存目录继续按 SHA-256 内容寻址，不为每个正式版本复制对象。

## 身份与后续分发

`cam-agent` 使用首次配对的 Ed25519 设备身份，不使用固定服务令牌。Core 注册 Agent 时保存公钥和指纹；Agent 请求携带 `X-CAM-Agent-Id`、`X-CAM-Agent-Timestamp`、`X-CAM-Agent-Nonce` 和 `X-CAM-Agent-Signature`，签名覆盖 HTTP 方法、路径、时间戳、随机数和请求体摘要。Core 拒绝过期时间戳、重复随机数、禁用 Agent 和无效签名。Agent 可使用旧身份签名提交新公钥，Core 在短暂过渡期接受旧、新公钥后完成轮换。Core 仍根据 Agent 身份、分发任务和目标范围授权版本基线及其文件，不开放匿名目录或摘要下载。

注册接口 `POST /api/v1/agents` 仅要求 `centerId`、`name`、`publicKey`，不再要求或返回 `securityDomain`。已有数据库升级时删除该字段，保留 Agent 编号、公钥、任务和心跳；重复登记同一公钥会被拒绝。中心内多个 Agent 依靠各自设备身份及任务目标区分。

管理目录的单文件下载路由用于登录用户受控查询。Agent 使用独立的任务接口 `/api/v1/agent/tasks/:taskId/files/:sha256/parts/:index`，只允许读取分配给该 Agent 的文件分块；目录查询接口不代表 Agent 已获得文件下载授权。Agent 本地人工交付使用上面的交付授权接口，不能把正式制品目录查询接口当作匿名下载入口。

Agent 登录后的“Core 身份配对”页面可复制本机公钥、测试签名认证，并查看配对与轮换状态；写操作要求本地会话与 CSRF 校验。Core 管理员为每个 Agent 设置自动轮换周期（默认 90 天，可设 1–365 天）和过渡期（默认 24 小时，可设 1–168 小时），也可请求立即轮换。Core 仅保存策略和请求，不连接 Agent；Agent 通过既有出站轮询读取策略并执行请求。

Agent 在本机原子持久化待用 Ed25519 密钥后，使用当前身份签名提交新公钥，并以新私钥对同一请求另行签名证明持有权；Core 仅允许当前身份发起换钥，重复提交同一新公钥幂等，不会重置过渡期。Core 短暂接受旧身份和新身份，Agent 使用新身份确认后才显示配对成功。待用私钥及退避状态保存在本机数据目录；进程重启、响应丢失或网络中断时继续使用同一把待用密钥探测/重试。失败从 5 秒开始指数退避，最长 5 分钟，Core 管理页和 Agent 页面显示最近错误、尝试次数、下次重试时间及轮换进度。Agent 不在线时 Core 保留请求，恢复连接后执行。
