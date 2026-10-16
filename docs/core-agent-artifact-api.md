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

当前 Core 查询接口沿用 Core 管理 API 的登录会话鉴权；`cam-agent` 的设备身份认证和任务级访问授权尚未实现。Agent 分发功能落地时，应为 Agent 建立独立设备凭据，并由 Core 根据 Agent 身份、分发任务和目标范围授权版本基线及其文件。不得为了 Agent 访问而开放匿名目录或摘要下载。

当前单文件下载路由用于受控查询和验证。Agent 正式分发上线前，还需实现任务绑定下载授权、可续传分块读取、下载审计和撤销检查；目录查询接口不代表 Agent 已获得文件下载授权。
