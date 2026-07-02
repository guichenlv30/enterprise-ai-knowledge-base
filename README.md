# 企业 AI 知识库问答系统

一个可本地运行的企业 AI 知识库与工作流平台。项目覆盖升级文档中的核心链路：登录、管理员/普通用户权限隔离、部门与用户、知识库权限、成员授权、私有知识库本地存储、文档上传解析、文本清洗分块、本地向量检索、Prompt 组装、普通问答、SSE 流式问答、答案引用、会话记录、答案质量反馈、AI 工作流、模型调用日志和统计看板。

## 技术栈

- 前端：Vue 3、TypeScript、Vite、Element Plus、Pinia、Axios
- 后端：Node.js 24、Express、Multer、Mammoth、pdf-parse、JWT、bcryptjs
- 检索：本地哈希向量 + Cosine 相似度，免外部向量库即可演示
- LLM：优先适配 DeepSeek Chat Completions；未配置 `DEEPSEEK_API_KEY` 时自动使用本地抽取式答案
- 存储：组织级数据默认本地 JSON 持久化，可切换到 MySQL；用户私有知识库、私有文档、私有会话和用户自建 Prompt 固定写入 `data/users/{userId}/private.json`，上传文件写入 `storage/users/{userId}/uploads`
- 缓存：可选 Redis，用于缓存系统统计和模型配置状态；写入数据后自动失效

## 快速启动

```bash
npm install
npm run dev
```

访问：

- 前端：http://127.0.0.1:5173
- 后端健康检查：http://127.0.0.1:8080/api/health

演示账号：

- `admin / admin123`
- `demo / demo123`

`admin` 是超级管理员，可管理组织级知识库、用户和系统配置；`demo` 是普通用户，只能创建和查看自己的私有知识库。

## 环境变量

复制 `.env.example` 为 `.env` 后可调整配置。

```bash
PORT=8080
JWT_SECRET=change-me-in-production
JWT_REFRESH_SECRET=change-me-refresh-secret
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=7d
ACCESS_TOKEN_EXPIRES_SECONDS=900
APP_ENCRYPTION_SECRET=change-me-to-a-long-random-secret
UPLOAD_DIR=storage/uploads
MAX_UPLOAD_MB=30
DB_DRIVER=json
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=
MYSQL_DATABASE=enterprise_ai_kb
REDIS_ENABLED=false
REDIS_URL=redis://127.0.0.1:6379
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_CHAT_MODEL=deepseek-v4-flash
DEEPSEEK_REASONING_MODEL=deepseek-v4-pro
DEEPSEEK_THINKING=disabled
DEEPSEEK_REASONING_EFFORT=high
DEEPSEEK_MAX_TOKENS=4096
DEEPSEEK_TIMEOUT_MS=900000
DEEPSEEK_STREAM_INCLUDE_USAGE=true
EMBEDDING_MODEL=local-hashing
RAG_TOP_K=5
RAG_MIN_SCORE=0.08
RAG_CHUNK_SIZE=700
RAG_CHUNK_OVERLAP=120
RAG_SEARCH_CACHE_TTL_SECONDS=300
RATE_LIMIT_WINDOW_SECONDS=60
RATE_LIMIT_LOGIN_PER_WINDOW=10
RATE_LIMIT_UPLOAD_PER_WINDOW=10
RATE_LIMIT_SEARCH_PER_WINDOW=60
RATE_LIMIT_CHAT_PER_WINDOW=30
```

`DEEPSEEK_API_KEY` 为空时系统仍可运行，并基于检索片段生成本地演示答案。也可以登录后台后在“系统 -> 模型配置”里填写 API Key、Base URL、模型名、Thinking 和 Max Tokens，保存后立即生效。旧版 `AI_API_KEY`、`AI_BASE_URL`、`AI_CHAT_MODEL` 仍兼容读取，但新部署建议使用 `DEEPSEEK_*`。

### MySQL / Navicat

项目根目录的 `.env` 是实际运行配置文件。要使用本机 MySQL，在 `.env` 中设置：

```bash
DB_DRIVER=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=你的MySQL密码
MYSQL_DATABASE=enterprise_ai_kb
```

启动后程序会自动创建 `enterprise_ai_kb` 数据库和 `aikb_department`、`aikb_user`、`aikb_knowledge_base`、`aikb_kb_member`、`aikb_document`、`aikb_refresh_token`、`aikb_answer_feedback`、`aikb_workflow_definition`、`aikb_workflow_run`、`aikb_llm_call_log`、`aikb_audit_log` 等表。第一次切换到 MySQL 时，如果库里还没有数据，会从 `data/app.json` 导入现有组织级本地数据；之后组织级数据以 MySQL 为准。用户私有知识库和用户自建 Prompt 不进入 MySQL，仍保存在 `data/users/{userId}/private.json`。可以在 Navicat Premium 里连接 `localhost:3306`，打开 `enterprise_ai_kb` 查看组织级数据。

### Redis

如需启用 Redis 缓存，在 `.env` 中设置：

```bash
REDIS_ENABLED=true
REDIS_URL=redis://127.0.0.1:6379
REDIS_KEY_PREFIX=aikb:
REDIS_CACHE_TTL_SECONDS=60
```

Redis 用于系统统计、公开模型配置、热点检索结果和限流计数，不保存业务主数据；MySQL 或 JSON 文件仍是持久化来源。Redis 未启用或不可用时应用会降级到进程内内存缓存，不影响登录、上传、问答和配置保存。

后台填写的 API Key 会使用 AES-256-GCM 加密后写入 `data/app.json` 或 MySQL，调用模型时再解密使用，不影响原 Key 的功能。生产环境请设置稳定的 `APP_ENCRYPTION_SECRET`；如果这个值变化，之前保存的后台 Key 将无法解密，需要重新填写。更高安全要求的生产环境仍建议使用 `.env` 或专门的密钥管理服务。

登录返回的 Refresh Token 支持服务端轮换和撤销。服务端只持久化 token id 的 SHA-256 哈希，不保存 refresh token 明文；调用 `/api/auth/refresh` 会撤销旧 token 并签发新 token，调用 `/api/auth/logout` 可撤销当前 refresh token。

DeepSeek 官方文档当前 OpenAI-compatible 地址为 `https://api.deepseek.com`，对话接口为 `/chat/completions`。默认模型使用 `deepseek-v4-flash` 且 `thinking=disabled`；需要更强推理能力时可在“系统 -> 模型配置”中把 Thinking 改为开启，并使用 `deepseek-v4-pro`。旧模型名 `deepseek-chat` 和 `deepseek-reasoner` 会自动迁移为新模型名。

保存后台模型配置时，后端会先发起一次低 token 的对话请求验证 API Key、Base URL 和模型名。验证失败会返回错误并拒绝保存；验证通过后才会加密保存 Key。模型调用日志会记录 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`reasoning_tokens` 和 `finish_reason`，用于排查成本、缓存命中和推理模式。

## 权限和本地私有数据

系统把管理员/组织级资源和普通用户私有资源分开处理：

- 超级管理员和知识库管理员可以创建非私有知识库，非私有知识库支持部门和可见范围配置。
- 普通用户只能创建私有知识库，创建表单不会出现部门和可见范围；普通用户也不能看到管理员创建的公开、部门或成员知识库。
- 普通用户可以编辑、启用/禁用和删除自己创建的私有知识库；对管理员创建的知识库没有新增、编辑或删除权限。
- 管理员创建的 Prompt 模板对普通用户只允许启用/禁用，用户不能编辑或删除管理员模板。
- 普通用户自己创建的 Prompt 模板保存到自己的用户数据库中，可以编辑、启用/禁用和删除。
- 用户私有知识库、私有文档、私有会话、答案反馈和用户自建 Prompt 保存在 `data/users/{userId}/private.json`；私有上传文件保存在 `storage/users/{userId}/uploads`。
- 组织级知识库、管理员 Prompt、部门、用户、审计日志、模型配置等仍保存在服务器主数据库中，即 `data/app.json` 或 MySQL。

部署时如果要避免用户隐私上传到服务器，只同步组织级数据库和组织级上传目录即可；`data/users` 与 `storage/users` 应保留在用户本地环境。

## 核心功能

- 部门：内置总部、客服部、人事行政部，用户和知识库可绑定部门
- 知识库：创建、编辑、删除、禁用/启用；管理员支持公开、部门可见、指定成员可见，普通用户仅支持私有知识库
- 成员授权：非私有知识库可指定成员可读或可管理，私有知识库不支持成员授权
- 文档：直接融入知识库页；上传 PDF、DOCX、TXT、Markdown；解析失败记录错误；支持重解析和删除
- 分块：固定长度 + 重叠窗口，保留标题和片段索引
- 检索：问题向量化、TopK 召回、相似度阈值过滤
- 问答：严格知识库模式、通用增强模式、普通回答、SSE 流式回答
- 会话：支持重命名、归档、恢复和删除；归档会话保留消息但不能继续提问
- 引用：回答关联 chunk、document 和 score，前端右侧展示来源
- Prompt：管理员模板和用户模板分库保存；用户自建模板可编辑/删除，管理员模板对普通用户只允许启用/禁用
- 反馈：用户可对助手回答标记有用/无用，后台统计低质量回答
- 工作流：预置会议纪要、培训题库、客服话术、SOP 检查清单、产品资料摘要
- 看板：统计高频问题、无召回问题、引用最多文档、有用率、模型调用和工作流运行
- 系统：管理员可查看部门、用户、知识库、文档、片段、会话、引用、反馈、工作流和模型配置状态；普通用户菜单隐藏系统管理

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/openapi.json` | OpenAPI 3.1 接口文档 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/register` | 注册普通用户 |
| POST | `/api/auth/refresh` | 刷新 Access Token |
| GET | `/api/users/me` | 当前用户 |
| PATCH | `/api/users/me/password` | 修改当前用户密码 |
| GET | `/api/departments` | 部门列表 |
| GET | `/api/users` | 用户列表 |
| POST | `/api/kbs` | 创建知识库；普通用户只能创建 `PRIVATE` |
| GET | `/api/kbs` | 知识库列表；普通用户只返回自己的私有知识库 |
| PUT | `/api/kbs/{id}` | 更新知识库；普通用户仅可更新自己的私有知识库 |
| PATCH | `/api/kbs/{id}/status` | 禁用/启用知识库；普通用户仅可操作自己的私有知识库 |
| DELETE | `/api/kbs/{id}` | 删除知识库；普通用户仅可删除自己的私有知识库 |
| GET | `/api/kbs/{id}/members` | 知识库成员 |
| POST | `/api/kbs/{id}/members` | 添加或更新成员 |
| DELETE | `/api/kbs/{id}/members/{userId}` | 移除成员 |
| POST | `/api/kbs/{kbId}/documents` | 上传文档 |
| GET | `/api/kbs/{kbId}/documents` | 文档列表 |
| GET | `/api/kbs/{kbId}/tags` | 知识库标签 |
| POST | `/api/kbs/{kbId}/tags` | 创建知识库标签 |
| POST | `/api/kbs/{id}/search` | RAG 检索 |
| GET | `/api/tasks/{taskId}` | 文档解析任务状态 |
| GET | `/api/documents/{id}/download` | 鉴权下载原文件 |
| POST | `/api/documents/{id}/reparse` | 重新解析 |
| GET | `/api/documents/{id}/chunks` | 片段列表 |
| POST | `/api/documents/{id}/tags` | 更新文档标签 |
| POST | `/api/chat/sessions` | 创建会话 |
| GET | `/api/chat/sessions?status=active|archived|all` | 会话列表 |
| PATCH | `/api/chat/sessions/{id}` | 重命名会话 |
| POST | `/api/chat/sessions/{id}/archive` | 归档会话 |
| POST | `/api/chat/sessions/{id}/restore` | 恢复会话 |
| DELETE | `/api/chat/sessions/{id}` | 删除会话及消息引用反馈 |
| POST | `/api/knowledge-bases/{kbId}/chat/sessions` | 按知识库创建会话 |
| GET | `/api/chat/sessions/{id}/messages` | 会话消息 |
| POST | `/api/chat/sessions/{id}/messages` | 普通问答 |
| POST | `/api/chat/sessions/{id}/stream` | SSE 流式问答 |
| POST | `/api/chat/messages/{messageId}/feedback` | 提交答案反馈 |
| GET | `/api/prompts` | Prompt 列表 |
| POST | `/api/prompts` | 创建 Prompt；普通用户写入自己的用户数据库 |
| PUT | `/api/prompts/{id}` | 更新 Prompt；普通用户只能更新自己的 Prompt |
| PATCH | `/api/prompts/{id}/status` | 禁用/启用 Prompt |
| DELETE | `/api/prompts/{id}` | 删除 Prompt；普通用户只能删除自己的 Prompt |
| GET | `/api/workflows` | 工作流列表 |
| POST | `/api/workflows/{id}/run` | 执行工作流 |
| GET | `/api/workflows/runs` | 工作流运行记录 |
| GET | `/api/dashboard/overview` | 看板总览 |
| GET | `/api/dashboard/questions/hot` | 高频问题 |
| GET | `/api/dashboard/feedback/bad` | 低质量反馈 |
| GET | `/api/dashboard/model-calls` | 模型调用日志 |
| GET | `/api/system/stats` | 系统统计 |
| GET | `/api/admin/users` | 管理员用户列表 |
| PATCH | `/api/admin/users/{userId}/status` | 管理员启停用户 |
| GET | `/api/admin/audit-logs` | 审计日志 |
| GET | `/api/admin/stats` | 管理统计 |

兼容文档中的个人知识库命名，以上知识库接口也支持 `/api/knowledge-bases` 前缀，例如 `/api/knowledge-bases/{kbId}/search`、`/api/knowledge-bases/{kbId}/documents`。

列表接口默认保持数组响应以兼容前端；传入 `page` 或 `pageSize` 后返回 `{ items, page, pageSize, total }` 分页结构。所有 JSON 响应同时包含 `success` 和 `code/message/data` 字段。

## 项目结构

```text
enterprise-ai-knowledge-base
├── src/server          # Express API、文档解析、检索、问答
├── src/web             # Vue3 前端应用
├── storage/uploads     # 组织级上传文件
├── storage/users       # 用户私有上传文件，按 userId 隔离
├── data/app.json       # 组织级 JSON 持久化数据，也可作为首次 MySQL 导入来源
├── data/users          # 用户私有数据库，按 userId 保存 private.json
├── docs/schema.sql     # MySQL 表结构参考
├── docker-compose.yml
├── Dockerfile
└── README.md
```

## 构建和生产运行

```bash
npm run build
node dist-server/index.js
```

生产模式下后端会直接托管 `dist-web`，访问 `http://127.0.0.1:8080` 即可打开前端。

## Docker

```bash
docker compose up --build
```

容器默认暴露 `8080`，组织级数据和上传文件通过卷挂载到项目的 `data` 和 `storage` 目录。涉及隐私隔离部署时，`data/users` 和 `storage/users` 不应作为服务器共享数据目录，可放在用户本地磁盘或按用户独立挂载。

## 面试演示路径

1. 登录 `admin / admin123`。
2. 先看“数据看板”，说明高频问题、无召回问题、引用最多文档和模型调用统计。
3. 进入“智能问答”，使用内置“企业制度演示知识库”提问：`年假申请需要提前多久？`
4. 查看右侧引用来源和相似度，并对回答标记“有用/无用”。
5. 进入“AI 工作流”，执行“会议纪要生成”或“员工培训题库生成”。
6. 进入“知识库”，查看组织级知识库启用/禁用、文档管理、片段预览和成员授权。
7. 进入“Prompt 模板”，说明管理员模板可统一维护，普通用户只能启用/禁用管理员模板。
8. 切换登录 `demo / demo123`，确认普通用户看不到管理员的非私有知识库。
9. 用普通用户新建私有知识库，上传文档后提问；说明数据写入 `data/users/2/private.json` 和 `storage/users/2/uploads`。
10. 用普通用户新建 Prompt，再删除该 Prompt；说明用户只能删除自己创建的知识库和 Prompt。
11. 回到管理员，进入“质量反馈”查看低质量回答闭环；进入“系统”查看部门、用户、模型配置和 LLM 调用日志。

## 许可证

本项目使用 MIT License 开源，详见 [LICENSE](LICENSE)。
