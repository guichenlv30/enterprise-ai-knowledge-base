import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { cache } from "./cache.js";
import { appConfig } from "./config.js";
import { MysqlStateStore } from "./mysql-store.js";
import { encryptSecret } from "./secrets.js";
import { chunkText, cleanText } from "./text.js";
import type {
  AppDatabase,
  ChatMessage,
  ChatSession,
  DocumentChunk,
  Department,
  IdCounters,
  KnowledgeBase,
  KnowledgeDocument,
  PromptTemplate,
  WorkflowDefinition,
  User
} from "./models.js";

type IdKey = keyof IdCounters;

const defaultPrompt = `你是企业内部知识库助手。
请严格根据【参考资料】回答用户问题。
如果参考资料中没有相关信息，请回答“当前知识库中没有找到明确依据”。
回答时请尽量简洁、准确，并保留关键信息。

【参考资料】
{context}

【历史对话】
{history}

【用户问题】
{question}`;

function now(): string {
  return new Date().toISOString();
}

function emptyCounters(): IdCounters {
  return {
    department: 1,
    user: 1,
    knowledgeBase: 1,
    kbMember: 1,
    document: 1,
    chunk: 1,
    session: 1,
    message: 1,
    reference: 1,
    prompt: 1,
    feedback: 1,
    refreshToken: 1,
    workflow: 1,
    workflowRun: 1,
    auditLog: 1
  };
}

function createEmptyDatabase(): AppDatabase {
  const createdAt = now();
  return {
    meta: {
      ids: emptyCounters(),
      createdAt,
      updatedAt: createdAt
    },
    departments: [],
    users: [],
    knowledgeBases: [],
    kbMembers: [],
    documents: [],
    chunks: [],
    sessions: [],
    messages: [],
    references: [],
    feedback: [],
    prompts: [],
    workflows: [],
    workflowRuns: [],
    llmCalls: [],
    refreshTokens: [],
    auditLogs: [],
    modelConfig: {
      provider: appConfig.ai.provider,
      baseUrl: appConfig.ai.baseUrl,
      chatModel: appConfig.ai.chatModel,
      reasoningModel: appConfig.ai.reasoningModel,
      thinking: appConfig.ai.thinking as "enabled" | "disabled",
      reasoningEffort: appConfig.ai.reasoningEffort as "high" | "max",
      maxTokens: appConfig.ai.maxTokens,
      embeddingModel: "local-hashing",
      updatedAt: createdAt
    }
  };
}

export class AppStore {
  private pendingSave: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private db: AppDatabase,
    private readonly mysqlStore?: MysqlStateStore
  ) {}

  static async create(filePath: string): Promise<AppStore> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const mysqlStore =
      appConfig.database.driver === "mysql"
        ? new MysqlStateStore(appConfig.database.mysql)
        : undefined;

    let db = mysqlStore ? await mysqlStore.load() : null;
    if (!db) {
      db = AppStore.loadJson(filePath);
    }

    const store = new AppStore(filePath, db, mysqlStore);
    store.migrateSecrets();
    store.seedDefaults();
    store.refreshKnowledgeBaseStats();
    store.save();
    await store.flush();
    return store;
  }

  get data(): AppDatabase {
    return this.db;
  }

  nextId(key: IdKey): number {
    const id = this.db.meta.ids[key];
    this.db.meta.ids[key] += 1;
    return id;
  }

  addMessage(message: Omit<ChatMessage, "id" | "createdAt">): ChatMessage {
    const createdAt = now();
    const record: ChatMessage = {
      id: this.nextId("message"),
      createdAt,
      ...message
    };
    this.db.messages.push(record);
    return record;
  }

  addSession(
    session: Omit<ChatSession, "id" | "createdAt" | "updatedAt" | "status" | "archivedAt"> &
      Partial<Pick<ChatSession, "status" | "archivedAt">>
  ): ChatSession {
    const createdAt = now();
    const record: ChatSession = {
      id: this.nextId("session"),
      createdAt,
      updatedAt: createdAt,
      status: "active",
      ...session
    };
    this.db.sessions.push(record);
    return record;
  }

  addChunks(chunks: DocumentChunk[]): DocumentChunk[] {
    const inserted = chunks.map((chunk) => ({
      ...chunk,
      id: this.nextId("chunk")
    }));
    this.db.chunks.push(...inserted);
    return inserted;
  }

  refreshKnowledgeBaseStats(kbId?: number): void {
    const targets = kbId
      ? this.db.knowledgeBases.filter((kb) => kb.id === kbId)
      : this.db.knowledgeBases;

    for (const kb of targets) {
      kb.documentCount = this.db.documents.filter((document) => document.kbId === kb.id).length;
      kb.chunkCount = this.db.chunks.filter((chunk) => chunk.kbId === kb.id).length;
      kb.updatedAt = now();
    }
  }

  save(): void {
    this.db.meta.updatedAt = now();
    void cache.invalidateDashboard();
    if (!this.mysqlStore) {
      fs.writeFileSync(this.filePath, JSON.stringify(this.db, null, 2), "utf8");
      return;
    }

    const snapshot = JSON.parse(JSON.stringify(this.db)) as AppDatabase;
    this.pendingSave = this.pendingSave
      .catch((error) => {
        console.error("Previous MySQL save failed:", error);
      })
      .then(() => this.mysqlStore?.save(snapshot))
      .then(() => undefined)
      .catch((error) => {
        console.error("MySQL save failed:", error);
      });
  }

  async flush(): Promise<void> {
    await this.pendingSave;
  }

  private static loadJson(filePath: string): AppDatabase {
    if (!fs.existsSync(filePath)) return createEmptyDatabase();
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as AppDatabase;
  }

  private seedDefaults(): void {
    const createdAt = now();
    let root = this.db.departments.find((department) => department.name === "总部");
    if (!root) {
      root = { id: this.nextId("department"), name: "总部", createdAt, updatedAt: createdAt };
      this.db.departments.push(root);
    }
    const defaultDepartments: Department[] = [
      { id: 0, name: "客服部", parentId: root.id, createdAt, updatedAt: createdAt },
      { id: 0, name: "人事行政部", parentId: root.id, createdAt, updatedAt: createdAt }
    ];
    for (const department of defaultDepartments) {
      if (this.db.departments.some((item) => item.name === department.name)) continue;
      this.db.departments.push({ ...department, id: this.nextId("department") });
    }

    if (this.db.users.length === 0) {
      const users: User[] = [
        {
          id: this.nextId("user"),
          username: "admin",
          passwordHash: bcrypt.hashSync("admin123", 10),
          nickname: "系统管理员",
          departmentId: 1,
          role: "SUPER_ADMIN",
          status: 1,
          createdAt,
          updatedAt: createdAt
        },
        {
          id: this.nextId("user"),
          username: "demo",
          passwordHash: bcrypt.hashSync("demo123", 10),
          nickname: "演示用户",
          departmentId: 3,
          role: "USER",
          status: 1,
          createdAt,
          updatedAt: createdAt
        }
      ];
      this.db.users.push(...users);
    }

    if (this.db.prompts.length === 0) {
      const createdAt = now();
      const prompt: PromptTemplate = {
        id: this.nextId("prompt"),
        name: "严格知识库问答",
        scene: "知识库问答",
        content: defaultPrompt,
        variables: ["context", "history", "question"],
        active: true,
        status: 1,
        createdBy: 1,
        createdAt,
        updatedAt: createdAt
      };
      this.db.prompts.push(prompt);
    }

    if (this.db.knowledgeBases.length === 0) {
      this.seedDemoKnowledgeBase();
    }

    if (this.db.workflows.length === 0) {
      this.seedWorkflows();
    }
  }

  private migrateSecrets(): void {
    this.db.meta.ids = { ...emptyCounters(), ...this.db.meta.ids };
    this.db.departments ??= [];
    this.db.kbMembers ??= [];
    this.db.feedback ??= [];
    this.db.workflows ??= [];
    this.db.workflowRuns ??= [];
    this.db.llmCalls ??= [];
    this.db.refreshTokens ??= [];
    this.db.auditLogs ??= [];
    if (this.db.departments.length === 0) {
      const createdAt = now();
      this.db.departments.push({ id: this.nextId("department"), name: "总部", createdAt, updatedAt: createdAt });
    }
    for (const user of this.db.users) {
      user.departmentId ??= 1;
    }
    for (const kb of this.db.knowledgeBases) {
      kb.status ??= 1;
      kb.departmentId ??= this.db.users.find((user) => user.id === kb.ownerId)?.departmentId ?? 1;
      kb.qaCount ??= this.db.sessions.filter((session) => session.kbId === kb.id).length;
      kb.tags ??= [];
    }
    for (const document of this.db.documents) {
      document.title ??= document.fileName;
      document.tags ??= [];
    }
    for (const session of this.db.sessions) {
      session.status = session.status === "archived" ? "archived" : "active";
      if (session.status === "active") delete session.archivedAt;
    }
    for (const prompt of this.db.prompts) {
      prompt.scene ??= "知识库问答";
      prompt.variables ??= ["context", "history", "question"];
      prompt.createdBy ??= 1;
      prompt.status ??= 1;
      if (prompt.status === 0) prompt.active = false;
    }
    if (!this.db.prompts.some((prompt) => prompt.status !== 0 && prompt.active)) {
      const firstEnabledPrompt = this.db.prompts.find((prompt) => prompt.status !== 0);
      if (firstEnabledPrompt) firstEnabledPrompt.active = true;
    }
    const modelConfig = this.db.modelConfig;
    if (modelConfig.apiKey && !modelConfig.apiKeyEncrypted) {
      modelConfig.apiKeyEncrypted = encryptSecret(modelConfig.apiKey);
    }
    delete modelConfig.apiKey;
    modelConfig.provider ||= appConfig.ai.provider;
    modelConfig.baseUrl ||= appConfig.ai.baseUrl;
    if (!modelConfig.chatModel || modelConfig.chatModel === "deepseek-chat") modelConfig.chatModel = "deepseek-v4-flash";
    if (modelConfig.chatModel === "deepseek-reasoner") modelConfig.chatModel = "deepseek-v4-pro";
    modelConfig.reasoningModel ||= appConfig.ai.reasoningModel;
    if (modelConfig.reasoningModel === "deepseek-chat") modelConfig.reasoningModel = "deepseek-v4-flash";
    if (modelConfig.reasoningModel === "deepseek-reasoner") modelConfig.reasoningModel = "deepseek-v4-pro";
    modelConfig.thinking = modelConfig.thinking === "enabled" ? "enabled" : appConfig.ai.thinking as "enabled" | "disabled";
    modelConfig.reasoningEffort = modelConfig.reasoningEffort === "max" ? "max" : "high";
    modelConfig.maxTokens = Number.isFinite(modelConfig.maxTokens) ? modelConfig.maxTokens : appConfig.ai.maxTokens;
    modelConfig.embeddingModel ||= "local-hashing";
  }

  private seedDemoKnowledgeBase(): void {
    const createdAt = now();
    const kb: KnowledgeBase = {
      id: this.nextId("knowledgeBase"),
      name: "企业制度演示知识库",
      description: "内置员工手册、报销制度和售后响应示例，可直接用于问答演示。",
      ownerId: 1,
      departmentId: 3,
      visibility: "PUBLIC",
      tags: ["demo"],
      status: 1,
      documentCount: 0,
      chunkCount: 0,
      qaCount: 0,
      createdAt,
      updatedAt: createdAt
    };
    this.db.knowledgeBases.push(kb);

    const demoText = `# 员工手册

## 年假制度
正式员工入职满一年后享有带薪年假。累计工作满一年不满十年的员工，每年享有 5 天年假；满十年不满二十年的员工，每年享有 10 天年假；满二十年的员工，每年享有 15 天年假。年假申请需要至少提前 3 个工作日在系统中提交，并由直属主管审批。

## 报销流程
员工发生差旅、招待或采购支出后，应在费用发生后 30 天内提交报销申请。申请需要上传发票、付款凭证和业务说明。单笔金额超过 3000 元的费用需要部门负责人和财务负责人共同审批。资料不完整的报销单会被退回补充。

## 售后响应
售后问题按照紧急程度分为 P1、P2、P3。P1 级问题需要 30 分钟内响应并在 4 小时内给出处理方案；P2 级问题需要 2 小时内响应；P3 级问题需要 1 个工作日内响应。所有售后处理过程需要在工单系统中记录。

## AI 工具使用规范
员工可以使用公司批准的 AI 工具辅助资料检索、文本草拟和代码解释。不得上传客户隐私、合同原件、财务数据和未公开经营信息。AI 输出内容用于对外发布前必须经过人工审核。`;

    fs.mkdirSync(appConfig.uploadDir, { recursive: true });
    const filePath = path.join(appConfig.uploadDir, "demo-employee-handbook.md");
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, demoText, "utf8");
    }

    const document: KnowledgeDocument = {
      id: this.nextId("document"),
      kbId: kb.id,
      fileName: "demo-employee-handbook.md",
      title: "demo-employee-handbook.md",
      fileType: "MD",
      fileSize: Buffer.byteLength(demoText),
      filePath,
      tags: ["demo"],
      parseStatus: "COMPLETED",
      createdBy: 1,
      referenceCount: 0,
      createdAt,
      updatedAt: createdAt
    };
    this.db.documents.push(document);

    const chunks = chunkText({
      text: cleanText(demoText),
      documentId: document.id,
      kbId: kb.id,
      chunkSize: 420,
      overlap: 80
    });
    this.addChunks(chunks);
  }

  private seedWorkflows(): void {
    const createdAt = now();
    const workflows: Array<Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">> = [
      {
        name: "会议纪要生成",
        scene: "meeting_minutes",
        description: "根据会议文本生成摘要、结论和待办事项。",
        status: 1,
        config: {
          inputFields: [
            { key: "topic", label: "会议主题", type: "text", required: true },
            { key: "participants", label: "参会人员", type: "text" },
            { key: "transcript", label: "会议文本", type: "textarea", required: true }
          ],
          prompt:
            "请根据会议主题、参会人员和会议文本输出会议纪要，包含会议摘要、关键结论、待办事项、负责人和截止时间。\n会议主题：{topic}\n参会人员：{participants}\n会议文本：{transcript}"
        }
      },
      {
        name: "员工培训题库生成",
        scene: "training_quiz",
        description: "基于制度资料生成培训题、答案和解析。",
        status: 1,
        config: {
          requiresKb: true,
          inputFields: [
            { key: "audience", label: "培训对象", type: "text", required: true },
            { key: "count", label: "题目数量", type: "number", required: true },
            { key: "topic", label: "培训主题", type: "text", required: true }
          ],
          prompt:
            "请基于参考资料，为{audience}围绕“{topic}”生成{count}道培训题，包含单选题、多选题或判断题、参考答案和解析。\n参考资料：\n{context}"
        }
      },
      {
        name: "售后客服话术生成",
        scene: "support_script",
        description: "根据客户问题生成标准回复、注意事项和升级条件。",
        status: 1,
        config: {
          requiresKb: true,
          inputFields: [
            { key: "issueType", label: "问题类型", type: "text", required: true },
            { key: "customerQuestion", label: "客户问题", type: "textarea", required: true }
          ],
          prompt:
            "请基于参考资料，为售后客服生成回复话术，包含标准回复、注意事项和升级人工处理条件。\n问题类型：{issueType}\n客户问题：{customerQuestion}\n参考资料：\n{context}"
        }
      },
      {
        name: "SOP 检查清单生成",
        scene: "sop_checklist",
        description: "将流程文档转成岗位检查清单。",
        status: 1,
        config: {
          requiresKb: true,
          inputFields: [
            { key: "role", label: "岗位角色", type: "text", required: true },
            { key: "process", label: "流程名称", type: "text", required: true }
          ],
          prompt:
            "请基于参考资料，为{role}生成“{process}”SOP 检查清单，包含操作步骤、检查项、风险点和异常处理方式。\n参考资料：\n{context}"
        }
      },
      {
        name: "产品资料摘要生成",
        scene: "product_summary",
        description: "把产品资料整理为摘要、卖点和常见问题。",
        status: 1,
        config: {
          requiresKb: true,
          inputFields: [
            { key: "product", label: "产品名称", type: "text", required: true },
            { key: "focus", label: "关注重点", type: "text" }
          ],
          prompt:
            "请基于参考资料，为产品“{product}”生成资料摘要，包含核心卖点、适用场景、注意事项和常见问题。关注重点：{focus}\n参考资料：\n{context}"
        }
      }
    ];

    for (const workflow of workflows) {
      this.db.workflows.push({
        id: this.nextId("workflow"),
        createdAt,
        updatedAt: createdAt,
        ...workflow
      });
    }
  }
}

export const store = await AppStore.create(appConfig.dataFile);
