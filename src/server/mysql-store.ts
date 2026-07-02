import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import type {
  AppDatabase,
  ChatMessage,
  DocumentChunk,
  KnowledgeBase,
  ModelConfig,
  PromptTemplate,
  User,
  Visibility
} from "./models.js";

export interface MysqlStoreConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
}

type DbRow = RowDataPacket & Record<string, unknown>;

function escapeIdentifier(value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error("MYSQL_DATABASE 只能包含字母、数字和下划线");
  }
  return `\`${value}\``;
}

function boolToTinyint(value: boolean): number {
  return value ? 1 : 0;
}

function tinyintToBool(value: unknown): boolean {
  return Number(value) === 1;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value === "string" && value.trim()) return JSON.parse(value) as T;
  return fallback;
}

function maybeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class MysqlStateStore {
  private pool?: Pool;

  constructor(private readonly config: MysqlStoreConfig) {}

  private async getPool(): Promise<Pool> {
    if (this.pool) return this.pool;

    const admin = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      waitForConnections: true,
      connectionLimit: 1,
      namedPlaceholders: true
    });
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(this.config.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await admin.end();

    this.pool = mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: this.config.connectionLimit,
      namedPlaceholders: true
    });
    await this.ensureSchema();
    return this.pool;
  }

  async load(): Promise<AppDatabase | null> {
    const pool = await this.getPool();
    const [metaRows] = await pool.query<DbRow[]>("SELECT data_json FROM aikb_meta WHERE id = 1");
    if (metaRows.length === 0) return null;

    const meta = parseJson<AppDatabase["meta"]>(metaRows[0].data_json, {
      ids: {
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
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const [departmentRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_department ORDER BY id");
    const [userRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_user ORDER BY id");
    const [kbRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_knowledge_base ORDER BY id");
    const [memberRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_kb_member ORDER BY id");
    const [documentRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_document ORDER BY id");
    const [chunkRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_document_chunk ORDER BY id");
    const [sessionRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_chat_session ORDER BY id");
    const [messageRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_chat_message ORDER BY id");
    const [referenceRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_answer_reference ORDER BY id");
    const [feedbackRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_answer_feedback ORDER BY id");
    const [promptRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_prompt_template ORDER BY id");
    const [workflowRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_workflow_definition ORDER BY id");
    const [workflowRunRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_workflow_run ORDER BY id");
    const [refreshTokenRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_refresh_token ORDER BY id");
    const [auditRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_audit_log ORDER BY created_at");
    const [modelRows] = await pool.query<DbRow[]>("SELECT * FROM aikb_model_config WHERE id = 1");
    const [llmRows] = await pool.query<DbRow[]>(
      "SELECT * FROM aikb_llm_call_log ORDER BY created_at"
    );

    const modelConfig = modelRows[0]
      ? ({
          provider: String(modelRows[0].provider),
          apiKeyEncrypted: modelRows[0].api_key_encrypted ? String(modelRows[0].api_key_encrypted) : undefined,
          baseUrl: String(modelRows[0].base_url),
          chatModel: String(modelRows[0].chat_model),
          reasoningModel: modelRows[0].reasoning_model ? String(modelRows[0].reasoning_model) : undefined,
          thinking: modelRows[0].thinking === "enabled" ? "enabled" : "disabled",
          reasoningEffort: modelRows[0].reasoning_effort === "max" ? "max" : "high",
          maxTokens: maybeNumber(modelRows[0].max_tokens),
          embeddingModel: String(modelRows[0].embedding_model),
          updatedAt: String(modelRows[0].updated_at)
        } satisfies ModelConfig)
      : {
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com",
          chatModel: "deepseek-v4-flash",
          reasoningModel: "deepseek-v4-pro",
          thinking: "disabled" as const,
          reasoningEffort: "high" as const,
          maxTokens: 4096,
          embeddingModel: "local-hashing",
          updatedAt: new Date().toISOString()
        };

    return {
      meta,
      departments: departmentRows.map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        parentId: maybeNumber(row.parent_id),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      })),
      users: userRows.map((row) => ({
        id: Number(row.id),
        username: String(row.username),
        passwordHash: String(row.password_hash),
        nickname: String(row.nickname),
        departmentId: maybeNumber(row.department_id),
        role: row.role as User["role"],
        status: Number(row.status) as 0 | 1,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      })),
      knowledgeBases: kbRows.map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        description: String(row.description ?? ""),
        ownerId: Number(row.owner_id),
        departmentId: maybeNumber(row.department_id),
        visibility: row.visibility as Visibility,
        tags: parseJson<string[]>(row.tags_json, []),
        status: Number(row.status) as 0 | 1,
        documentCount: Number(row.document_count),
        chunkCount: Number(row.chunk_count),
        qaCount: Number(row.qa_count ?? 0),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      })),
      kbMembers: memberRows.map((row) => ({
        id: Number(row.id),
        kbId: Number(row.kb_id),
        userId: Number(row.user_id),
        permission: row.permission as AppDatabase["kbMembers"][number]["permission"],
        createdAt: String(row.created_at)
      })),
      documents: documentRows.map((row) => ({
        id: Number(row.id),
        kbId: Number(row.kb_id),
        title: row.title ? String(row.title) : String(row.file_name),
        fileName: String(row.file_name),
        fileType: String(row.file_type),
        fileSize: Number(row.file_size),
        filePath: String(row.file_path),
        tags: parseJson<string[]>(row.tags_json, []),
        parseStatus: row.parse_status as AppDatabase["documents"][number]["parseStatus"],
        errorMessage: row.error_message ? String(row.error_message) : undefined,
        createdBy: Number(row.created_by),
        referenceCount: Number(row.reference_count),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      })),
      chunks: chunkRows.map((row) => ({
        id: Number(row.id),
        documentId: Number(row.document_id),
        kbId: Number(row.kb_id),
        chunkIndex: Number(row.chunk_index),
        title: String(row.title ?? ""),
        content: String(row.content),
        vectorId: String(row.vector_id),
        vector: parseJson<number[]>(row.vector_json, []),
        tokenCount: Number(row.token_count),
        pageNumber: maybeNumber(row.page_number),
        createdAt: String(row.created_at)
      })),
      sessions: sessionRows.map((row) => ({
        id: Number(row.id),
        kbId: Number(row.kb_id),
        userId: Number(row.user_id),
        title: String(row.title),
        status: row.status === "archived" ? "archived" : "active",
        archivedAt: row.archived_at ? String(row.archived_at) : undefined,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      })),
      messages: messageRows.map((row) => ({
        id: Number(row.id),
        sessionId: Number(row.session_id),
        role: row.role as ChatMessage["role"],
        content: String(row.content),
        promptSnapshot: row.prompt_snapshot ? String(row.prompt_snapshot) : undefined,
        llmUsed: row.llm_used === null || row.llm_used === undefined ? undefined : tinyintToBool(row.llm_used),
        llmProvider: row.llm_provider ? String(row.llm_provider) : undefined,
        llmModel: row.llm_model ? String(row.llm_model) : undefined,
        answerSource: row.answer_source ? (String(row.answer_source) as ChatMessage["answerSource"]) : undefined,
        retrievalCount: maybeNumber(row.retrieval_count),
        llmError: row.llm_error ? String(row.llm_error) : undefined,
        llmFinishReason: row.llm_finish_reason ? String(row.llm_finish_reason) : undefined,
        createdAt: String(row.created_at)
      })),
      references: referenceRows.map((row) => ({
        id: Number(row.id),
        messageId: Number(row.message_id),
        chunkId: Number(row.chunk_id),
        documentId: Number(row.document_id),
        score: Number(row.score),
        createdAt: String(row.created_at)
      })),
      feedback: feedbackRows.map((row) => ({
        id: Number(row.id),
        messageId: Number(row.message_id),
        sessionId: Number(row.session_id),
        kbId: Number(row.kb_id),
        userId: Number(row.user_id),
        rating: row.rating as AppDatabase["feedback"][number]["rating"],
        reason: row.reason as AppDatabase["feedback"][number]["reason"],
        comment: String(row.comment ?? ""),
        createdAt: String(row.created_at)
      })),
      prompts: promptRows.map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        scene: String(row.scene ?? "知识库问答"),
        content: String(row.content),
        variables: parseJson<string[]>(row.variables_json, ["context", "history", "question"]),
        active: tinyintToBool(row.active),
        status: Number(row.status) as 0 | 1,
        createdBy: maybeNumber(row.created_by),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      })),
      workflows: workflowRows.map((row) => ({
        id: Number(row.id),
        name: String(row.name),
        scene: String(row.scene),
        description: String(row.description ?? ""),
        config: parseJson<AppDatabase["workflows"][number]["config"]>(row.config_json, {
          inputFields: [],
          prompt: ""
        }),
        status: Number(row.status) as 0 | 1,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      })),
      workflowRuns: workflowRunRows.map((row) => ({
        id: Number(row.id),
        workflowId: Number(row.workflow_id),
        userId: Number(row.user_id),
        kbId: maybeNumber(row.kb_id),
        input: parseJson<Record<string, unknown>>(row.input_json, {}),
        outputText: String(row.output_text ?? ""),
        status: row.status as AppDatabase["workflowRuns"][number]["status"],
        errorMessage: row.error_message ? String(row.error_message) : undefined,
        createdAt: String(row.created_at),
        finishedAt: row.finished_at ? String(row.finished_at) : undefined
      })),
      llmCalls: llmRows.map((row) => ({
        id: String(row.id),
        purpose: row.purpose as AppDatabase["llmCalls"][number]["purpose"],
        userId: maybeNumber(row.user_id),
        kbId: maybeNumber(row.kb_id),
        provider: String(row.provider),
        baseUrl: String(row.base_url),
        model: String(row.model),
        success: tinyintToBool(row.success),
        statusCode: maybeNumber(row.status_code),
        durationMs: Number(row.duration_ms),
        promptTokens: maybeNumber(row.prompt_tokens),
        completionTokens: maybeNumber(row.completion_tokens),
        totalTokens: maybeNumber(row.total_tokens),
        promptCacheHitTokens: maybeNumber(row.prompt_cache_hit_tokens),
        promptCacheMissTokens: maybeNumber(row.prompt_cache_miss_tokens),
        reasoningTokens: maybeNumber(row.reasoning_tokens),
        finishReason: row.finish_reason ? String(row.finish_reason) : undefined,
        errorMessage: row.error_message ? String(row.error_message) : undefined,
        createdAt: String(row.created_at)
      })),
      refreshTokens: refreshTokenRows.map((row) => ({
        id: Number(row.id),
        userId: Number(row.user_id),
        tokenHash: String(row.token_hash),
        expiresAt: String(row.expires_at),
        revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
        replacedByTokenHash: row.replaced_by_token_hash ? String(row.replaced_by_token_hash) : undefined,
        createdAt: String(row.created_at)
      })),
      auditLogs: auditRows.map((row) => ({
        id: Number(row.id),
        userId: maybeNumber(row.user_id),
        action: String(row.action),
        resourceType: row.resource_type ? String(row.resource_type) : undefined,
        resourceId: row.resource_id === null || row.resource_id === undefined ? undefined : String(row.resource_id),
        detail: parseJson<Record<string, unknown>>(row.detail_json, {}),
        ip: row.ip ? String(row.ip) : undefined,
        userAgent: row.user_agent ? String(row.user_agent) : undefined,
        createdAt: String(row.created_at)
      })),
      modelConfig
    };
  }

  async save(db: AppDatabase): Promise<void> {
    const pool = await this.getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("DELETE FROM aikb_audit_log");
      await connection.query("DELETE FROM aikb_refresh_token");
      await connection.query("DELETE FROM aikb_llm_call_log");
      await connection.query("DELETE FROM aikb_workflow_run");
      await connection.query("DELETE FROM aikb_workflow_definition");
      await connection.query("DELETE FROM aikb_model_config");
      await connection.query("DELETE FROM aikb_prompt_template");
      await connection.query("DELETE FROM aikb_answer_feedback");
      await connection.query("DELETE FROM aikb_answer_reference");
      await connection.query("DELETE FROM aikb_chat_message");
      await connection.query("DELETE FROM aikb_chat_session");
      await connection.query("DELETE FROM aikb_document_chunk");
      await connection.query("DELETE FROM aikb_document");
      await connection.query("DELETE FROM aikb_kb_member");
      await connection.query("DELETE FROM aikb_knowledge_base");
      await connection.query("DELETE FROM aikb_user");
      await connection.query("DELETE FROM aikb_department");
      await connection.query("DELETE FROM aikb_meta");

      await connection.execute("INSERT INTO aikb_meta (id, data_json) VALUES (1, ?)", [JSON.stringify(db.meta)]);
      for (const department of db.departments) {
        await connection.execute(
          `INSERT INTO aikb_department (id, name, parent_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [department.id, department.name, department.parentId ?? null, department.createdAt, department.updatedAt]
        );
      }
      for (const user of db.users) {
        await connection.execute(
          `INSERT INTO aikb_user
            (id, username, password_hash, nickname, department_id, role, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            user.id,
            user.username,
            user.passwordHash,
            user.nickname,
            user.departmentId ?? null,
            user.role,
            user.status,
            user.createdAt,
            user.updatedAt
          ]
        );
      }
      for (const kb of db.knowledgeBases) {
        await connection.execute(
          `INSERT INTO aikb_knowledge_base
            (id, name, description, owner_id, department_id, visibility, tags_json, status, document_count, chunk_count, qa_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?)`,
          [
            kb.id,
            kb.name,
            kb.description,
            kb.ownerId,
            kb.departmentId ?? null,
            kb.visibility,
            JSON.stringify(kb.tags ?? []),
            kb.status,
            kb.documentCount,
            kb.chunkCount,
            kb.qaCount,
            kb.createdAt,
            kb.updatedAt
          ]
        );
      }
      for (const member of db.kbMembers) {
        await connection.execute(
          `INSERT INTO aikb_kb_member (id, kb_id, user_id, permission, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [member.id, member.kbId, member.userId, member.permission, member.createdAt]
        );
      }
      for (const document of db.documents) {
        await connection.execute(
          `INSERT INTO aikb_document
            (id, kb_id, title, file_name, file_type, file_size, file_path, tags_json, parse_status, error_message, created_by, reference_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?, ?)`,
          [
            document.id,
            document.kbId,
            document.title ?? document.fileName,
            document.fileName,
            document.fileType,
            document.fileSize,
            document.filePath,
            JSON.stringify(document.tags ?? []),
            document.parseStatus,
            document.errorMessage ?? null,
            document.createdBy,
            document.referenceCount,
            document.createdAt,
            document.updatedAt
          ]
        );
      }
      for (const chunk of db.chunks) {
        await connection.execute(
          `INSERT INTO aikb_document_chunk
            (id, document_id, kb_id, chunk_index, title, content, vector_id, vector_json, token_count, page_number, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?)`,
          [
            chunk.id,
            chunk.documentId,
            chunk.kbId,
            chunk.chunkIndex,
            chunk.title,
            chunk.content,
            chunk.vectorId,
            JSON.stringify(chunk.vector),
            chunk.tokenCount,
            chunk.pageNumber ?? null,
            chunk.createdAt
          ]
        );
      }
      for (const session of db.sessions) {
        await connection.execute(
          `INSERT INTO aikb_chat_session (id, kb_id, user_id, title, status, archived_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            session.id,
            session.kbId,
            session.userId,
            session.title,
            session.status,
            session.archivedAt ?? null,
            session.createdAt,
            session.updatedAt
          ]
        );
      }
      for (const message of db.messages) {
        await connection.execute(
          `INSERT INTO aikb_chat_message
            (id, session_id, role, content, prompt_snapshot, llm_used, llm_provider, llm_model, answer_source, retrieval_count, llm_error, llm_finish_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            message.id,
            message.sessionId,
            message.role,
            message.content,
            message.promptSnapshot ?? null,
            message.llmUsed === undefined ? null : boolToTinyint(message.llmUsed),
            message.llmProvider ?? null,
            message.llmModel ?? null,
            message.answerSource ?? null,
            message.retrievalCount ?? null,
            message.llmError ?? null,
            message.llmFinishReason ?? null,
            message.createdAt
          ]
        );
      }
      for (const feedback of db.feedback) {
        await connection.execute(
          `INSERT INTO aikb_answer_feedback
            (id, message_id, session_id, kb_id, user_id, rating, reason, comment, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            feedback.id,
            feedback.messageId,
            feedback.sessionId,
            feedback.kbId,
            feedback.userId,
            feedback.rating,
            feedback.reason,
            feedback.comment,
            feedback.createdAt
          ]
        );
      }
      for (const reference of db.references) {
        await connection.execute(
          `INSERT INTO aikb_answer_reference (id, message_id, chunk_id, document_id, score, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            reference.id,
            reference.messageId,
            reference.chunkId,
            reference.documentId,
            reference.score,
            reference.createdAt
          ]
        );
      }
      for (const prompt of db.prompts) {
        await connection.execute(
          `INSERT INTO aikb_prompt_template (id, name, scene, content, variables_json, active, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?)`,
          [
            prompt.id,
            prompt.name,
            prompt.scene,
            prompt.content,
            JSON.stringify(prompt.variables),
            boolToTinyint(prompt.active),
            prompt.status,
            prompt.createdBy ?? null,
            prompt.createdAt,
            prompt.updatedAt
          ]
        );
      }
      for (const workflow of db.workflows) {
        await connection.execute(
          `INSERT INTO aikb_workflow_definition
            (id, name, scene, description, config_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?)`,
          [
            workflow.id,
            workflow.name,
            workflow.scene,
            workflow.description,
            JSON.stringify(workflow.config),
            workflow.status,
            workflow.createdAt,
            workflow.updatedAt
          ]
        );
      }
      for (const run of db.workflowRuns) {
        await connection.execute(
          `INSERT INTO aikb_workflow_run
            (id, workflow_id, user_id, kb_id, input_json, output_text, status, error_message, created_at, finished_at)
           VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?, ?)`,
          [
            run.id,
            run.workflowId,
            run.userId,
            run.kbId ?? null,
            JSON.stringify(run.input),
            run.outputText,
            run.status,
            run.errorMessage ?? null,
            run.createdAt,
            run.finishedAt ?? null
          ]
        );
      }
      await connection.execute(
        `INSERT INTO aikb_model_config
          (id, provider, api_key_encrypted, base_url, chat_model, reasoning_model, thinking, reasoning_effort, max_tokens, embedding_model, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          db.modelConfig.provider,
          db.modelConfig.apiKeyEncrypted ?? null,
          db.modelConfig.baseUrl,
          db.modelConfig.chatModel,
          db.modelConfig.reasoningModel ?? "deepseek-v4-pro",
          db.modelConfig.thinking ?? "disabled",
          db.modelConfig.reasoningEffort ?? "high",
          db.modelConfig.maxTokens ?? 4096,
          db.modelConfig.embeddingModel,
          db.modelConfig.updatedAt
        ]
      );
      for (const call of db.llmCalls ?? []) {
        await connection.execute(
          `INSERT INTO aikb_llm_call_log
            (id, purpose, user_id, kb_id, provider, base_url, model, success, status_code, duration_ms, prompt_tokens, completion_tokens, total_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens, reasoning_tokens, finish_reason, error_message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            call.id,
            call.purpose,
            call.userId ?? null,
            call.kbId ?? null,
            call.provider,
            call.baseUrl,
            call.model,
            boolToTinyint(call.success),
            call.statusCode ?? null,
            call.durationMs,
            call.promptTokens ?? null,
            call.completionTokens ?? null,
            call.totalTokens ?? null,
            call.promptCacheHitTokens ?? null,
            call.promptCacheMissTokens ?? null,
            call.reasoningTokens ?? null,
            call.finishReason ?? null,
            call.errorMessage ?? null,
            call.createdAt
          ]
        );
      }
      for (const token of db.refreshTokens ?? []) {
        await connection.execute(
          `INSERT INTO aikb_refresh_token
            (id, user_id, token_hash, expires_at, revoked_at, replaced_by_token_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            token.id,
            token.userId,
            token.tokenHash,
            token.expiresAt,
            token.revokedAt ?? null,
            token.replacedByTokenHash ?? null,
            token.createdAt
          ]
        );
      }
      for (const audit of db.auditLogs ?? []) {
        await connection.execute(
          `INSERT INTO aikb_audit_log
            (id, user_id, action, resource_type, resource_id, detail_json, ip, user_agent, created_at)
           VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?)`,
          [
            audit.id,
            audit.userId ?? null,
            audit.action,
            audit.resourceType ?? null,
            audit.resourceId === undefined ? null : String(audit.resourceId),
            JSON.stringify(audit.detail ?? {}),
            audit.ip ?? null,
            audit.userAgent ?? null,
            audit.createdAt
          ]
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private async ensureSchema(): Promise<void> {
    if (!this.pool) throw new Error("MySQL pool is not initialized");
    const statements = [
      `CREATE TABLE IF NOT EXISTS aikb_meta (
        id TINYINT PRIMARY KEY,
        data_json JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_department (
        id BIGINT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        parent_id BIGINT,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        INDEX idx_department_parent (parent_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_user (
        id BIGINT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        nickname VARCHAR(64) NOT NULL,
        department_id BIGINT,
        role VARCHAR(32) NOT NULL,
        status TINYINT NOT NULL DEFAULT 1,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        INDEX idx_user_department (department_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_knowledge_base (
        id BIGINT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        description VARCHAR(512),
        owner_id BIGINT NOT NULL,
        department_id BIGINT,
        visibility VARCHAR(32) NOT NULL,
        tags_json JSON NOT NULL,
        status TINYINT NOT NULL DEFAULT 1,
        document_count INT NOT NULL DEFAULT 0,
        chunk_count INT NOT NULL DEFAULT 0,
        qa_count INT NOT NULL DEFAULT 0,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        INDEX idx_kb_owner (owner_id),
        INDEX idx_kb_department (department_id),
        INDEX idx_kb_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_kb_member (
        id BIGINT PRIMARY KEY,
        kb_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        permission VARCHAR(32) NOT NULL,
        created_at VARCHAR(32) NOT NULL,
        UNIQUE KEY uniq_kb_member (kb_id, user_id),
        INDEX idx_member_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_document (
        id BIGINT PRIMARY KEY,
        kb_id BIGINT NOT NULL,
        title VARCHAR(255),
        file_name VARCHAR(255) NOT NULL,
        file_type VARCHAR(32) NOT NULL,
        file_size BIGINT NOT NULL,
        file_path VARCHAR(512) NOT NULL,
        tags_json JSON NOT NULL,
        parse_status VARCHAR(32) NOT NULL,
        error_message TEXT,
        created_by BIGINT NOT NULL,
        reference_count INT NOT NULL DEFAULT 0,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        INDEX idx_document_kb (kb_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_document_chunk (
        id BIGINT PRIMARY KEY,
        document_id BIGINT NOT NULL,
        kb_id BIGINT NOT NULL,
        chunk_index INT NOT NULL,
        title VARCHAR(255),
        content MEDIUMTEXT NOT NULL,
        vector_id VARCHAR(128) NOT NULL,
        vector_json JSON NOT NULL,
        token_count INT NOT NULL,
        page_number INT,
        created_at VARCHAR(32) NOT NULL,
        INDEX idx_chunk_document (document_id),
        INDEX idx_chunk_kb (kb_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_chat_session (
        id BIGINT PRIMARY KEY,
        kb_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        title VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        archived_at VARCHAR(32),
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        INDEX idx_session_user (user_id),
        INDEX idx_session_kb (kb_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_chat_message (
        id BIGINT PRIMARY KEY,
        session_id BIGINT NOT NULL,
        role VARCHAR(32) NOT NULL,
        content MEDIUMTEXT NOT NULL,
        prompt_snapshot MEDIUMTEXT,
        llm_used TINYINT,
        llm_provider VARCHAR(40),
        llm_model VARCHAR(80),
        answer_source VARCHAR(32),
        retrieval_count INT,
        llm_error TEXT,
        llm_finish_reason VARCHAR(64),
        created_at VARCHAR(32) NOT NULL,
        INDEX idx_message_session (session_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_answer_reference (
        id BIGINT PRIMARY KEY,
        message_id BIGINT NOT NULL,
        chunk_id BIGINT NOT NULL,
        document_id BIGINT NOT NULL,
        score DECIMAL(10, 8) NOT NULL,
        created_at VARCHAR(32) NOT NULL,
        INDEX idx_reference_message (message_id),
        INDEX idx_reference_chunk (chunk_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_answer_feedback (
        id BIGINT PRIMARY KEY,
        message_id BIGINT NOT NULL,
        session_id BIGINT NOT NULL,
        kb_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        rating VARCHAR(32) NOT NULL,
        reason VARCHAR(32) NOT NULL,
        comment TEXT,
        created_at VARCHAR(32) NOT NULL,
        UNIQUE KEY uniq_feedback_message_user (message_id, user_id),
        INDEX idx_feedback_kb (kb_id),
        INDEX idx_feedback_rating (rating)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_prompt_template (
        id BIGINT PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        scene VARCHAR(64) NOT NULL DEFAULT '知识库问答',
        content MEDIUMTEXT NOT NULL,
        variables_json JSON NOT NULL,
        active TINYINT NOT NULL DEFAULT 0,
        status TINYINT NOT NULL DEFAULT 1,
        created_by BIGINT,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        INDEX idx_prompt_status (status),
        INDEX idx_prompt_active (active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_workflow_definition (
        id BIGINT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        scene VARCHAR(64) NOT NULL,
        description VARCHAR(512),
        config_json JSON NOT NULL,
        status TINYINT NOT NULL DEFAULT 1,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL,
        INDEX idx_workflow_status (status),
        INDEX idx_workflow_scene (scene)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_workflow_run (
        id BIGINT PRIMARY KEY,
        workflow_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        kb_id BIGINT,
        input_json JSON NOT NULL,
        output_text MEDIUMTEXT,
        status VARCHAR(32) NOT NULL,
        error_message TEXT,
        created_at VARCHAR(32) NOT NULL,
        finished_at VARCHAR(32),
        INDEX idx_workflow_run_user (user_id),
        INDEX idx_workflow_run_workflow (workflow_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_model_config (
        id TINYINT PRIMARY KEY,
        provider VARCHAR(40) NOT NULL,
        api_key_encrypted TEXT,
        base_url VARCHAR(255) NOT NULL,
        chat_model VARCHAR(80) NOT NULL,
        reasoning_model VARCHAR(80),
        thinking VARCHAR(16) NOT NULL DEFAULT 'disabled',
        reasoning_effort VARCHAR(16) NOT NULL DEFAULT 'high',
        max_tokens INT NOT NULL DEFAULT 4096,
        embedding_model VARCHAR(80) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_llm_call_log (
        id VARCHAR(64) PRIMARY KEY,
        purpose VARCHAR(32) NOT NULL,
        user_id BIGINT,
        kb_id BIGINT,
        provider VARCHAR(40) NOT NULL,
        base_url VARCHAR(255) NOT NULL,
        model VARCHAR(80) NOT NULL,
        success TINYINT NOT NULL,
        status_code INT,
        duration_ms INT NOT NULL,
        prompt_tokens INT,
        completion_tokens INT,
        total_tokens INT,
        prompt_cache_hit_tokens INT,
        prompt_cache_miss_tokens INT,
        reasoning_tokens INT,
        finish_reason VARCHAR(64),
        error_message TEXT,
        created_at VARCHAR(32) NOT NULL,
        INDEX idx_llm_user (user_id),
        INDEX idx_llm_kb (kb_id),
        INDEX idx_llm_created_at (created_at),
        INDEX idx_llm_success (success)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_refresh_token (
        id BIGINT PRIMARY KEY,
        user_id BIGINT NOT NULL,
        token_hash VARCHAR(128) NOT NULL UNIQUE,
        expires_at VARCHAR(32) NOT NULL,
        revoked_at VARCHAR(32),
        replaced_by_token_hash VARCHAR(128),
        created_at VARCHAR(32) NOT NULL,
        INDEX idx_refresh_user (user_id),
        INDEX idx_refresh_expires_at (expires_at),
        INDEX idx_refresh_revoked_at (revoked_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS aikb_audit_log (
        id BIGINT PRIMARY KEY,
        user_id BIGINT,
        action VARCHAR(80) NOT NULL,
        resource_type VARCHAR(64),
        resource_id VARCHAR(80),
        detail_json JSON NOT NULL,
        ip VARCHAR(64),
        user_agent VARCHAR(255),
        created_at VARCHAR(32) NOT NULL,
        INDEX idx_audit_user (user_id),
        INDEX idx_audit_action (action),
        INDEX idx_audit_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    ];

    for (const statement of statements) {
      await this.pool.query(statement);
    }
    await this.ensureLegacyColumns();
  }

  private async columnExists(table: string, column: string): Promise<boolean> {
    if (!this.pool) throw new Error("MySQL pool is not initialized");
    const [rows] = await this.pool.query<DbRow[]>(`SHOW COLUMNS FROM ${escapeIdentifier(table)} LIKE ?`, [column]);
    return rows.length > 0;
  }

  private async ensureColumn(table: string, column: string, definition: string): Promise<void> {
    if (!this.pool) throw new Error("MySQL pool is not initialized");
    if (await this.columnExists(table, column)) return;
    await this.pool.query(`ALTER TABLE ${escapeIdentifier(table)} ADD COLUMN ${escapeIdentifier(column)} ${definition}`);
  }

  private async ensureLegacyColumns(): Promise<void> {
    if (!this.pool) throw new Error("MySQL pool is not initialized");
    await this.ensureColumn("aikb_user", "department_id", "BIGINT");
    await this.ensureColumn("aikb_knowledge_base", "department_id", "BIGINT");
    await this.ensureColumn("aikb_knowledge_base", "qa_count", "INT NOT NULL DEFAULT 0");
    await this.ensureColumn("aikb_knowledge_base", "tags_json", "JSON NULL");
    await this.ensureColumn("aikb_document", "title", "VARCHAR(255)");
    await this.ensureColumn("aikb_document", "tags_json", "JSON NULL");
    await this.ensureColumn("aikb_chat_session", "status", "VARCHAR(16) NOT NULL DEFAULT 'active'");
    await this.ensureColumn("aikb_chat_session", "archived_at", "VARCHAR(32)");
    await this.ensureColumn("aikb_chat_message", "prompt_snapshot", "MEDIUMTEXT");
    await this.ensureColumn("aikb_chat_message", "llm_finish_reason", "VARCHAR(64)");
    await this.ensureColumn("aikb_prompt_template", "scene", "VARCHAR(64) NOT NULL DEFAULT '知识库问答'");
    await this.ensureColumn("aikb_prompt_template", "variables_json", "JSON NULL");
    await this.ensureColumn("aikb_prompt_template", "created_by", "BIGINT");
    await this.ensureColumn("aikb_llm_call_log", "user_id", "BIGINT");
    await this.ensureColumn("aikb_llm_call_log", "kb_id", "BIGINT");
    await this.ensureColumn("aikb_llm_call_log", "prompt_cache_hit_tokens", "INT");
    await this.ensureColumn("aikb_llm_call_log", "prompt_cache_miss_tokens", "INT");
    await this.ensureColumn("aikb_llm_call_log", "reasoning_tokens", "INT");
    await this.ensureColumn("aikb_llm_call_log", "finish_reason", "VARCHAR(64)");
    await this.ensureColumn("aikb_model_config", "reasoning_model", "VARCHAR(80)");
    await this.ensureColumn("aikb_model_config", "thinking", "VARCHAR(16) NOT NULL DEFAULT 'disabled'");
    await this.ensureColumn("aikb_model_config", "reasoning_effort", "VARCHAR(16) NOT NULL DEFAULT 'high'");
    await this.ensureColumn("aikb_model_config", "max_tokens", "INT NOT NULL DEFAULT 4096");
    await this.pool.query(
      "UPDATE aikb_prompt_template SET variables_json = JSON_ARRAY('context', 'history', 'question') WHERE variables_json IS NULL"
    );
    await this.pool.query("UPDATE aikb_knowledge_base SET tags_json = JSON_ARRAY() WHERE tags_json IS NULL");
    await this.pool.query("UPDATE aikb_document SET tags_json = JSON_ARRAY() WHERE tags_json IS NULL");
    await this.pool.query("UPDATE aikb_document SET title = file_name WHERE title IS NULL OR title = ''");
  }
}
