# Core 正式制品查询接口

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

### 下载正式制品

```http
GET /api/v1/artifacts/:sha256/content
```

文件下载地址由清单的 `downloadUrl` 给出。客户端必须自行校验下载字节的长度和 SHA-256，并且只有校验通过后才可将文件标记为本地可用。

## 身份与后续分发

`cam-agent` 使用首次配对的 Ed25519 设备身份，不使用固定服务令牌。Core 注册 Agent 时保存公钥和指纹；Agent 请求携带 `X-CAM-Agent-Id`、`X-CAM-Agent-Timestamp`、`X-CAM-Agent-Nonce` 和 `X-CAM-Agent-Signature`，签名覆盖 HTTP 方法、路径、时间戳、随机数和请求体摘要。Core 拒绝过期时间戳、重复随机数、禁用 Agent 和无效签名。Agent 可使用旧身份签名提交新公钥，Core 在短暂过渡期接受旧、新公钥后完成轮换。Core 仍根据 Agent 身份、分发任务和目标范围授权版本基线及其文件，不开放匿名目录或摘要下载。

注册接口 `POST /api/v1/agents` 仅要求 `centerId`、`name`、`publicKey`，不再要求或返回 `securityDomain`。已有数据库升级时删除该字段，保留 Agent 编号、公钥、任务和心跳。中心内多个 Agent 依靠各自设备身份及任务目标区分。

管理目录的单文件下载路由用于登录用户受控查询。Agent 使用独立的任务接口 `/api/v1/agent/tasks/:taskId/files/:sha256/parts/:index`，只允许读取分配给该 Agent 的文件分块；目录查询接口不代表 Agent 已获得文件下载授权。下载审计仍需在正式上线前补齐。

Agent 登录后的“Core 身份配对”页面可复制本机公钥、测试签名认证，并查看配对与轮换状态；写操作要求本地会话与 CSRF 校验。Core 管理员为每个 Agent 设置自动轮换周期（默认 90 天，可设 1–365 天）和过渡期（默认 24 小时，可设 1–168 小时），也可请求立即轮换。Core 仅保存策略和请求，不连接 Agent；Agent 通过既有出站轮询读取策略并执行请求。

Agent 在本机原子持久化待用 Ed25519 密钥后，使用当前身份签名提交新公钥，并以新私钥对同一请求另行签名证明持有权；Core 仅允许当前身份发起换钥，重复提交同一新公钥幂等，不会重置过渡期。Core 短暂接受旧身份和新身份，Agent 使用新身份确认后才显示配对成功。待用私钥及退避状态保存在本机数据目录；进程重启、响应丢失或网络中断时继续使用同一把待用密钥探测/重试。失败从 5 秒开始指数退避，最长 5 分钟，Core 管理页和 Agent 页面显示最近错误、尝试次数、下次重试时间及轮换进度。Agent 不在线时 Core 保留请求，恢复连接后执行。
