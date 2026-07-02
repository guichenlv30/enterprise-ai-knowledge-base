import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import {
  authenticate,
  canAccessKb,
  canManageKb,
  createRefreshToken,
  createToken,
  currentUser,
  publicUser,
  refreshAccessToken,
  requireAdmin,
  revokeRefreshToken,
  verifyPassword
} from "./auth.js";
import { cache } from "./cache.js";
import { appConfig } from "./config.js";
import { assertFound, HttpError } from "./errors.js";
import { callChatCompletion, validateChatCompletionConfig } from "./llm.js";
import { answerQuestion, referencesForMessage, type RagDataStore } from "./qa.js";
import { encryptSecret, maskSecret, readModelApiKey } from "./secrets.js";
import { openApiDocument } from "./openapi.js";
import { store, type AppStore } from "./store.js";
import { assertSupportedFile, chunkText, cleanText, parseDocumentText } from "./text.js";
import { userDataStore, type UserScopedStore } from "./user-store.js";
import { retrieveTopK } from "./vector.js";
import type { AnswerFeedback, ChatMessage, ChatSession, KnowledgeBase, KnowledgeDocument, PromptTemplate, Visibility } from "./models.js";

fs.mkdirSync(appConfig.uploadDir, { recursive: true });

const app = express();

type ResourceStore = AppStore | UserScopedStore;

interface KnowledgeBaseContext {
  kb: (typeof store.data.knowledgeBases)[number];
  dataStore: ResourceStore;
  privateData: boolean;
}

interface DocumentContext extends KnowledgeBaseContext {
  document: KnowledgeDocument;
}

interface SessionContext extends KnowledgeBaseContext {
  session: ChatSession;
}

interface MessageContext extends SessionContext {
  message: ChatMessage;
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, appConfig.uploadDir),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${uuidv4()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: appConfig.upload.maxBytes },
  fileFilter: (_req, file, callback) => {
    try {
      assertSupportedFile(file.originalname);
      callback(null, true);
    } catch (error) {
      callback(error as Error);
    }
  }
});

function ok(res: Response, data: unknown = null): void {
  res.json({ success: true, code: 0, message: "ok", data });
}

function idParam(req: Request, name = "id"): number {
  const value = Number(req.params[name]);
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, "非法 ID");
  return value;
}

function wantsPagination(req: Request): boolean {
  return req.query.page !== undefined || req.query.pageSize !== undefined;
}

function paginationParams(req: Request): { page: number; pageSize: number } {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
  return { page, pageSize };
}

function maybePaginated<T>(req: Request, items: T[]): T[] | { items: T[]; page: number; pageSize: number; total: number } {
  if (!wantsPagination(req)) return items;
  const { page, pageSize } = paginationParams(req);
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: items.length
  };
}

async function enforceRateLimit(req: Request, scope: string, limit: number): Promise<void> {
  if (limit <= 0) return;
  const identity = req.user?.id ? `user:${req.user.id}` : `ip:${req.ip || "unknown"}`;
  const count = await cache.incrementWithTtl(`rate:${scope}:${identity}`, appConfig.rateLimit.windowSeconds);
  if (count > limit) {
    throw new HttpError(429, "rate limit exceeded");
  }
}

function stableHash(value: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function getKnowledgeBase(id: number) {
  return assertFound(store.data.knowledgeBases.find((kb) => kb.id === id), "知识库不存在");
}

function pruneUserPromptStates(userStore: UserScopedStore): void {
  const adminPromptIds = new Set(store.data.prompts.map((prompt) => prompt.id));
  const originalLength = userStore.data.promptStates.length;
  userStore.data.promptStates = userStore.data.promptStates.filter((state) => adminPromptIds.has(state.promptId));
  if (userStore.data.promptStates.length !== originalLength) {
    userStore.save();
  }
}

function pruneAllUserPromptStates(): void {
  for (const userId of userDataStore.existingUserIds()) {
    pruneUserPromptStates(userDataStore.get(userId));
  }
}

function getUserPrivateStore(user: ReturnType<typeof currentUser>): UserScopedStore {
  const userStore = userDataStore.get(user.id);
  pruneUserPromptStates(userStore);
  return userStore;
}

function resolveKnowledgeBase(user: ReturnType<typeof currentUser>, id: number): KnowledgeBaseContext {
  const privateStore = getUserPrivateStore(user);
  const privateKb = privateStore.data.knowledgeBases.find((kb) => kb.id === id);
  if (privateKb) {
    if (!canAccessKb(user, privateKb)) throw new HttpError(403, "无权访问该知识库");
    return { kb: privateKb, dataStore: privateStore, privateData: true };
  }

  const kb = getKnowledgeBase(id);
  if (!canAccessKb(user, kb)) throw new HttpError(403, "无权访问该知识库");
  return { kb, dataStore: store, privateData: false };
}

function resolveManagedKnowledgeBase(user: ReturnType<typeof currentUser>, id: number): KnowledgeBaseContext {
  const context = resolveKnowledgeBase(user, id);
  if (!canManageKb(user, context.kb)) throw new HttpError(403, "无权管理该知识库");
  return context;
}

function assertKnowledgeBaseEnabled(kb: { status?: 0 | 1 }): void {
  if (kb.status === 0) throw new HttpError(403, "知识库已禁用");
}

function getDocument(id: number) {
  return assertFound(store.data.documents.find((document) => document.id === id), "文档不存在");
}

function resolveDocument(user: ReturnType<typeof currentUser>, id: number): DocumentContext {
  const privateStore = getUserPrivateStore(user);
  const privateDocument = privateStore.data.documents.find((document) => document.id === id);
  if (privateDocument) {
    const kb = assertFound(privateStore.data.knowledgeBases.find((item) => item.id === privateDocument.kbId), "知识库不存在");
    if (!canAccessKb(user, kb)) throw new HttpError(403, "无权访问该文档");
    return { kb, document: privateDocument, dataStore: privateStore, privateData: true };
  }

  const document = getDocument(id);
  const context = resolveKnowledgeBase(user, document.kbId);
  return { ...context, document };
}

function getSession(id: number) {
  return assertFound(store.data.sessions.find((session) => session.id === id), "会话不存在");
}

function resolveSession(user: ReturnType<typeof currentUser>, id: number): SessionContext {
  const privateStore = getUserPrivateStore(user);
  const privateSession = privateStore.data.sessions.find((session) => session.id === id);
  if (privateSession) {
    const kb = assertFound(privateStore.data.knowledgeBases.find((item) => item.id === privateSession.kbId), "知识库不存在");
    if (!canAccessKb(user, kb)) throw new HttpError(403, "无权访问该会话");
    return { kb, session: privateSession, dataStore: privateStore, privateData: true };
  }

  const session = getSession(id);
  const context = resolveKnowledgeBase(user, session.kbId);
  return { ...context, session };
}

function resolveMessage(user: ReturnType<typeof currentUser>, id: number): MessageContext {
  const privateStore = getUserPrivateStore(user);
  const privateMessage = privateStore.data.messages.find((message) => message.id === id);
  if (privateMessage) {
    const session = assertFound(privateStore.data.sessions.find((item) => item.id === privateMessage.sessionId), "会话不存在");
    const kb = assertFound(privateStore.data.knowledgeBases.find((item) => item.id === session.kbId), "知识库不存在");
    if (!canAccessKb(user, kb)) throw new HttpError(403, "无权访问该消息");
    return { kb, session, message: privateMessage, dataStore: privateStore, privateData: true };
  }

  const message = assertFound(store.data.messages.find((item) => item.id === id), "消息不存在");
  const context = resolveSession(user, message.sessionId);
  return { ...context, message };
}

function assertCanAccessSession(user: ReturnType<typeof currentUser>, session: ChatSession): void {
  if (session.userId !== user.id && user.role !== "SUPER_ADMIN") throw new HttpError(403, "无权访问该会话");
}

function assertSessionActive(session: ChatSession): void {
  if (session.status === "archived") throw new HttpError(409, "归档会话不能继续提问，请先恢复会话");
}

function deleteSessionCascade(dataStore: ResourceStore, session: ChatSession): { messageCount: number; referenceCount: number; feedbackCount: number } {
  const sessionMessages = dataStore.data.messages.filter((message) => message.sessionId === session.id);
  const messageIds = new Set(sessionMessages.map((message) => message.id));
  const messageCount = messageIds.size;
  const questionCount = sessionMessages.filter((message) => message.role === "user").length;
  const referenceCount = dataStore.data.references.filter((reference) => messageIds.has(reference.messageId)).length;
  const feedbackCount = dataStore.data.feedback.filter((item) => item.sessionId === session.id || messageIds.has(item.messageId)).length;
  dataStore.data.sessions = dataStore.data.sessions.filter((item) => item.id !== session.id);
  dataStore.data.messages = dataStore.data.messages.filter((message) => message.sessionId !== session.id);
  dataStore.data.references = dataStore.data.references.filter((reference) => !messageIds.has(reference.messageId));
  dataStore.data.feedback = dataStore.data.feedback.filter((item) => item.sessionId !== session.id && !messageIds.has(item.messageId));
  const kb = dataStore.data.knowledgeBases.find((item) => item.id === session.kbId);
  if (kb) {
    kb.qaCount = Math.max(0, (kb.qaCount ?? 0) - questionCount);
    kb.updatedAt = new Date().toISOString();
  }
  return { messageCount, referenceCount, feedbackCount };
}

async function parseAndIndexDocument(dataStore: ResourceStore, document: KnowledgeDocument): Promise<void> {
  document.parseStatus = "PARSING";
  document.errorMessage = undefined;
  document.updatedAt = new Date().toISOString();
  dataStore.save();

  dataStore.data.chunks = dataStore.data.chunks.filter((chunk) => chunk.documentId !== document.id);
  dataStore.data.references = dataStore.data.references.filter((reference) => reference.documentId !== document.id);

  try {
    const rawText = await parseDocumentText(document.filePath, document.fileName);
    const text = cleanText(rawText);
    if (text.length < 8) throw new HttpError(400, "文档没有解析到有效文本");

    const chunks = chunkText({
      text,
      documentId: document.id,
      kbId: document.kbId
    });
    if (chunks.length === 0) throw new HttpError(400, "文档内容过短，无法生成知识片段");

    dataStore.addChunks(chunks);
    document.parseStatus = "COMPLETED";
    document.errorMessage = undefined;
  } catch (error) {
    document.parseStatus = "FAILED";
    document.errorMessage = error instanceof Error ? error.message : "解析失败";
  }

  document.updatedAt = new Date().toISOString();
  dataStore.refreshKnowledgeBaseStats(document.kbId);
  dataStore.save();
}

function withMessageReferences(dataStore: RagDataStore, message: { id: number }) {
  return {
    ...message,
    references: referencesForMessage(dataStore, message.id)
  };
}

function publicChunk(chunk: (typeof store.data.chunks)[number]) {
  const { vector: _vector, ...rest } = chunk;
  return rest;
}

function publicDocument(document: (typeof store.data.documents)[number]) {
  const { filePath: _filePath, ...rest } = document;
  return {
    ...rest,
    taskId: document.id
  };
}

function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(
    raw
      .map((tag) => String(tag).trim())
      .filter(Boolean)
      .slice(0, 20)
  )].map((tag) => tag.slice(0, 40));
}

function audit(req: Request, action: string, options: {
  userId?: number;
  resourceType?: string;
  resourceId?: number | string;
  detail?: Record<string, unknown>;
} = {}): void {
  store.data.auditLogs ??= [];
  store.data.auditLogs.push({
    id: store.nextId("auditLog"),
    userId: options.userId ?? req.user?.id,
    action,
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    detail: options.detail,
    ip: req.ip,
    userAgent: req.get("user-agent"),
    createdAt: new Date().toISOString()
  });
  if (store.data.auditLogs.length > 5000) {
    store.data.auditLogs = store.data.auditLogs.slice(-5000);
  }
}

function moveDocumentFileToUserStore(userId: number, document: KnowledgeDocument): void {
  if (!fs.existsSync(document.filePath)) return;
  const targetDir = userDataStore.uploadDir(userId);
  fs.mkdirSync(targetDir, { recursive: true });
  const source = path.resolve(document.filePath);
  const target = path.resolve(targetDir, path.basename(document.filePath));
  if (source === target) return;
  try {
    if (!fs.existsSync(target)) {
      fs.renameSync(source, target);
    } else {
      const extension = path.extname(target);
      const fallbackTarget = path.join(targetDir, `${uuidv4()}${extension}`);
      fs.renameSync(source, fallbackTarget);
      document.filePath = fallbackTarget;
      return;
    }
    document.filePath = target;
  } catch {
    try {
      const extension = path.extname(target);
      const fallbackTarget = path.join(targetDir, `${uuidv4()}${extension}`);
      fs.copyFileSync(source, fallbackTarget);
      fs.rmSync(source, { force: true });
      document.filePath = fallbackTarget;
    } catch (error) {
      console.warn("Move private document failed:", error instanceof Error ? error.message : String(error));
    }
  }
}

function migratePrivateGlobalData(): void {
  const privateKbs = store.data.knowledgeBases.filter((kb) => kb.visibility === "PRIVATE");
  for (const kb of privateKbs) {
    const userStore = userDataStore.get(kb.ownerId);
    const documents = store.data.documents.filter((document) => document.kbId === kb.id);
    const chunks = store.data.chunks.filter((chunk) => chunk.kbId === kb.id);
    const sessions = store.data.sessions.filter((session) => session.kbId === kb.id);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const messages = store.data.messages.filter((message) => sessionIds.has(message.sessionId));
    const messageIds = new Set(messages.map((message) => message.id));
    const references = store.data.references.filter((reference) => messageIds.has(reference.messageId));
    const feedback = store.data.feedback.filter((item) => item.kbId === kb.id);

    if (!userStore.data.knowledgeBases.some((item) => item.id === kb.id)) {
      userStore.data.knowledgeBases.push({ ...kb, departmentId: undefined, visibility: "PRIVATE" });
    }
    for (const document of documents) {
      const privateDocument = { ...document };
      moveDocumentFileToUserStore(kb.ownerId, privateDocument);
      if (!userStore.data.documents.some((item) => item.id === privateDocument.id)) userStore.data.documents.push(privateDocument);
    }
    for (const chunk of chunks) {
      if (!userStore.data.chunks.some((item) => item.id === chunk.id)) userStore.data.chunks.push({ ...chunk });
    }
    for (const session of sessions) {
      if (!userStore.data.sessions.some((item) => item.id === session.id)) userStore.data.sessions.push({ ...session });
    }
    for (const message of messages) {
      if (!userStore.data.messages.some((item) => item.id === message.id)) userStore.data.messages.push({ ...message });
    }
    for (const reference of references) {
      if (!userStore.data.references.some((item) => item.id === reference.id)) userStore.data.references.push({ ...reference });
    }
    for (const item of feedback) {
      if (!userStore.data.feedback.some((row) => row.id === item.id)) userStore.data.feedback.push({ ...item });
    }
    userStore.refreshKnowledgeBaseStats(kb.id);
    userStore.save();

    store.data.kbMembers = store.data.kbMembers.filter((member) => member.kbId !== kb.id);
    store.data.documents = store.data.documents.filter((document) => document.kbId !== kb.id);
    store.data.chunks = store.data.chunks.filter((chunk) => chunk.kbId !== kb.id);
    store.data.sessions = store.data.sessions.filter((session) => session.kbId !== kb.id);
    store.data.messages = store.data.messages.filter((message) => !sessionIds.has(message.sessionId));
    store.data.references = store.data.references.filter((reference) => !messageIds.has(reference.messageId));
    store.data.feedback = store.data.feedback.filter((item) => item.kbId !== kb.id);
  }
  store.data.knowledgeBases = store.data.knowledgeBases.filter((kb) => kb.visibility !== "PRIVATE");

  for (const prompt of [...store.data.prompts]) {
    const owner = store.data.users.find((user) => user.id === prompt.createdBy);
    if (!owner || owner.role !== "USER") continue;
    const userStore = userDataStore.get(owner.id);
    if (!userStore.data.prompts.some((item) => item.id === prompt.id)) userStore.data.prompts.push({ ...prompt, createdBy: owner.id });
    store.data.prompts = store.data.prompts.filter((item) => item.id !== prompt.id);
    userStore.save();
  }

  store.refreshKnowledgeBaseStats();
  store.save();
}

migratePrivateGlobalData();
pruneAllUserPromptStates();

function taskPayload(document: (typeof store.data.documents)[number]) {
  const statusMap: Record<string, string> = {
    PENDING: "pending",
    PARSING: "parsing",
    COMPLETED: "completed",
    FAILED: "failed",
    DISABLED: "failed"
  };
  const progressMap: Record<string, number> = {
    PENDING: 10,
    PARSING: 50,
    COMPLETED: 100,
    FAILED: 100,
    DISABLED: 100
  };
  return {
    id: document.id,
    taskId: document.id,
    documentId: document.id,
    status: statusMap[document.parseStatus] ?? document.parseStatus.toLowerCase(),
    progress: progressMap[document.parseStatus] ?? 0,
    errorMessage: document.errorMessage ?? null,
    updatedAt: document.updatedAt
  };
}

function canEditDocument(user: ReturnType<typeof currentUser>, document: KnowledgeDocument, kb: KnowledgeBase): boolean {
  return canManageKb(user, kb) || document.createdBy === user.id;
}

function publicRetrievalHit(hit: ReturnType<typeof retrieveTopK>[number]) {
  return {
    chunkId: hit.chunk.id,
    documentId: hit.chunk.documentId,
    documentName: hit.document?.fileName ?? "未知文档",
    title: hit.chunk.title,
    content: hit.chunk.content,
    score: hit.score,
    pageNumber: hit.chunk.pageNumber,
    chunk: publicChunk(hit.chunk),
    document: hit.document ? publicDocument(hit.document) : undefined
  };
}

function activeApiKey(): string {
  return (readModelApiKey(store.data.modelConfig) || appConfig.ai.apiKey).trim();
}

function publicModelConfig() {
  const { apiKey: _apiKey, apiKeyEncrypted: _apiKeyEncrypted, ...config } = store.data.modelConfig;
  const apiKey = activeApiKey();
  return {
    ...config,
    provider: config.provider || appConfig.ai.provider,
    baseUrl: config.baseUrl || appConfig.ai.baseUrl,
    chatModel: config.chatModel || appConfig.ai.chatModel,
    reasoningModel: config.reasoningModel || appConfig.ai.reasoningModel,
    thinking: config.thinking ?? appConfig.ai.thinking,
    reasoningEffort: config.reasoningEffort ?? appConfig.ai.reasoningEffort,
    maxTokens: config.maxTokens ?? appConfig.ai.maxTokens,
    apiKeyConfigured: Boolean(apiKey),
    hasApiKey: Boolean(apiKey),
    apiKeyPreview: maskSecret(apiKey),
    apiKeySource: store.data.modelConfig.apiKeyEncrypted ? "database" : appConfig.ai.apiKey ? "environment" : "none"
  };
}

function departmentName(id?: number): string {
  return store.data.departments.find((department) => department.id === id)?.name ?? "未分配";
}

function publicUserRow(user: (typeof store.data.users)[number]) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    departmentId: user.departmentId,
    departmentName: departmentName(user.departmentId),
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function kbRoleForUser(user: ReturnType<typeof currentUser>, kb: KnowledgeBase): "owner" | "manager" | "reader" {
  if (kb.ownerId === user.id) return "owner";
  if (canManageKb(user, kb)) return "manager";
  return "reader";
}

function publicKnowledgeBase(kb: KnowledgeBase, user: ReturnType<typeof currentUser>, privateData = false) {
  return {
    ...kb,
    myRole: kbRoleForUser(user, kb),
    storageScope: privateData ? "user" : "server"
  };
}

function visibleDataStore(user?: ReturnType<typeof currentUser>): ResourceStore {
  return user?.role === "USER" ? getUserPrivateStore(user) : store;
}

function systemStats(user?: ReturnType<typeof currentUser>) {
  const dataStore = visibleDataStore(user);
  const llmCalls = user?.role === "USER"
    ? (store.data.llmCalls ?? []).filter((call) => call.userId === user.id)
    : store.data.llmCalls ?? [];
  return {
    departments: store.data.departments.length,
    users: user?.role === "USER" ? 1 : store.data.users.length,
    knowledgeBases: dataStore.data.knowledgeBases.length,
    documents: dataStore.data.documents.length,
    chunks: dataStore.data.chunks.length,
    sessions: dataStore.data.sessions.length,
    messages: dataStore.data.messages.length,
    references: dataStore.data.references.length,
    llmCalls: llmCalls.length,
    auditLogs: user?.role === "USER" ? 0 : store.data.auditLogs?.length ?? 0,
    feedback: dataStore.data.feedback.length,
    workflows: store.data.workflows.length,
    workflowRuns: user?.role === "USER" ? store.data.workflowRuns.filter((run) => run.userId === user.id).length : store.data.workflowRuns.length,
    aiConfigured: Boolean(activeApiKey()),
    cacheDriver: cache.isEnabled ? "redis" : "memory",
    redisConnected: cache.isConnected,
    supportedFileTypes: [".pdf", ".docx", ".txt", ".md", ".markdown"]
  };
}

function previousUserQuestion(dataStore: ResourceStore, message: ChatMessage): string {
  const messages = dataStore.data.messages
    .filter((item) => item.sessionId === message.sessionId && item.id < message.id)
    .sort((left, right) => right.id - left.id);
  return messages.find((item) => item.role === "user")?.content ?? "";
}

function badFeedbackRows(user?: ReturnType<typeof currentUser>, limit = 50) {
  const dataStore = visibleDataStore(user);
  return dataStore.data.feedback
    .filter((feedback) => feedback.rating === "useless")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
    .map((feedback) => {
      const message = dataStore.data.messages.find((item) => item.id === feedback.messageId);
      const kb = dataStore.data.knowledgeBases.find((item) => item.id === feedback.kbId);
      return {
        ...feedback,
        question: message ? previousUserQuestion(dataStore, message) : "",
        answer: message?.content ?? "",
        kbName: kb?.name ?? "未知知识库"
      };
    });
}

function dashboardOverview(user?: ReturnType<typeof currentUser>) {
  const dataStore = visibleDataStore(user);
  const assistantMessages = dataStore.data.messages.filter((message) => message.role === "assistant");
  const useful = dataStore.data.feedback.filter((item) => item.rating === "useful").length;
  const useless = dataStore.data.feedback.filter((item) => item.rating === "useless").length;
  const feedbackTotal = useful + useless;
  const llmCalls = user?.role === "USER"
    ? (store.data.llmCalls ?? []).filter((call) => call.userId === user.id)
    : store.data.llmCalls ?? [];
  const totalDuration = llmCalls.reduce((sum, call) => sum + call.durationMs, 0);
  const documentReferenceMap = new Map<number, number>();
  for (const reference of dataStore.data.references) {
    documentReferenceMap.set(reference.documentId, (documentReferenceMap.get(reference.documentId) ?? 0) + 1);
  }

  return {
    totalQuestions: dataStore.data.messages.filter((message) => message.role === "user").length,
    usefulRate: feedbackTotal ? Number((useful / feedbackTotal).toFixed(4)) : 0,
    uselessRate: feedbackTotal ? Number((useless / feedbackTotal).toFixed(4)) : 0,
    noHitQuestions: assistantMessages.filter((message) => (message.retrievalCount ?? 0) === 0).length,
    totalModelCalls: llmCalls.length,
    totalTokens: llmCalls.reduce((sum, call) => sum + (call.totalTokens ?? 0), 0),
    avgLatencyMs: llmCalls.length ? Math.round(totalDuration / llmCalls.length) : 0,
    mostReferencedDocuments: [...documentReferenceMap.entries()]
      .map(([documentId, references]) => ({
        documentId,
        fileName: dataStore.data.documents.find((document) => document.id === documentId)?.fileName ?? "未知文档",
        references
      }))
      .sort((left, right) => right.references - left.references)
      .slice(0, 8)
  };
}

function hotQuestions(user?: ReturnType<typeof currentUser>, limit = 20) {
  const dataStore = visibleDataStore(user);
  const counter = new Map<string, number>();
  for (const message of dataStore.data.messages.filter((item) => item.role === "user")) {
    const question = message.content.trim();
    if (!question) continue;
    counter.set(question, (counter.get(question) ?? 0) + 1);
  }
  return [...counter.entries()]
    .map(([question, count]) => ({ question, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
}

function renderWorkflowPrompt(template: string, input: Record<string, unknown>, context: string): string {
  let prompt = template.replaceAll("{context}", context || "无");
  for (const [key, value] of Object.entries(input)) {
    prompt = prompt.replaceAll(`{${key}}`, value === undefined || value === null ? "" : String(value));
  }
  return `请直接执行下面的 AI 工作流任务。所有可用输入参数已经提供，不要要求用户再次补充同样信息；如果某个非必填字段为空，请按“未提供”处理并继续输出结果。\n\n${prompt}`;
}

function renderWorkflowContext(hits: ReturnType<typeof retrieveTopK>): string {
  if (hits.length === 0) return "无";
  return hits
    .map((hit, index) => {
      const source = hit.document?.fileName ?? "未知文档";
      return `[${index + 1}] 来源：${source}；标题：${hit.chunk.title}；相似度：${hit.score.toFixed(3)}
${hit.chunk.content}`;
    })
    .join("\n\n");
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const registerSchema = z.object({
  username: z.string().min(2).max(64).optional(),
  email: z.string().email().max(255).optional(),
  password: z.string().min(6).max(64),
  displayName: z.string().min(1).max(64).optional(),
  nickname: z.string().min(1).max(64).optional()
}).refine((body) => Boolean(body.username || body.email), {
  message: "username 或 email 至少填写一个"
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1).optional()
}).optional();

const passwordChangeSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(6).max(64)
});

function authPayload(user: (typeof store.data.users)[number]) {
  const accessToken = createToken(user);
  return {
    token: accessToken,
    accessToken,
    refreshToken: createRefreshToken(user),
    expiresIn: appConfig.auth.accessTokenExpiresInSeconds,
    user: publicUser(user)
  };
}

app.get("/api/health", (_req, res) => {
  ok(res, {
    status: "UP",
    time: new Date().toISOString(),
    aiConfigured: Boolean(activeApiKey()),
    databaseDriver: appConfig.database.driver,
    cacheDriver: cache.isEnabled ? "redis" : "memory",
    redisConnected: cache.isConnected
  });
});

app.get("/api/openapi.json", (_req, res) => res.json(openApiDocument));
app.get("/openapi.json", (_req, res) => res.json(openApiDocument));

app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    await enforceRateLimit(req, "login", appConfig.rateLimit.loginPerWindow);
    const body = loginSchema.parse(req.body);
    const user = store.data.users.find((item) => item.username === body.username && item.status === 1);
    if (!user || !(await verifyPassword(body.password, user))) {
      throw new HttpError(401, "用户名或密码错误");
    }
    audit(req, "auth.login", { userId: user.id });
    store.save();
    ok(res, authPayload(user));
  })
);

app.post(
  "/api/auth/register",
  asyncRoute(async (req, res) => {
    await enforceRateLimit(req, "login", appConfig.rateLimit.loginPerWindow);
    const body = registerSchema.parse(req.body);
    const username = (body.username || body.email || "").trim();
    if (store.data.users.some((item) => item.username === username)) {
      throw new HttpError(409, "用户名已存在");
    }
    const bcrypt = await import("bcryptjs");
    const createdAt = new Date().toISOString();
    const user = {
      id: store.nextId("user"),
      username,
      passwordHash: bcrypt.default.hashSync(body.password, 10),
      nickname: body.displayName || body.nickname || username,
      departmentId: store.data.departments[0]?.id,
      role: "USER" as const,
      status: 1 as const,
      createdAt,
      updatedAt: createdAt
    };
    store.data.users.push(user);
    audit(req, "auth.register", { userId: user.id, resourceType: "user", resourceId: user.id });
    store.save();
    ok(res, authPayload(user));
  })
);

app.post("/api/auth/refresh", (req, res) => {
  const body = refreshSchema.parse(req.body);
  ok(res, refreshAccessToken(body.refreshToken));
});

app.post("/api/auth/logout", (req, res) => {
  const body = logoutSchema.parse(req.body);
  const revoked = body?.refreshToken ? revokeRefreshToken(body.refreshToken) : false;
  ok(res, { revoked });
});

app.use("/api", authenticate);

app.get("/api/users/me", (req, res) => ok(res, currentUser(req)));

app.patch(
  "/api/users/me/password",
  asyncRoute(async (req, res) => {
    const authUser = currentUser(req);
    const user = assertFound(store.data.users.find((item) => item.id === authUser.id), "user not found");
    const body = passwordChangeSchema.parse(req.body);
    if (!(await verifyPassword(body.oldPassword, user))) {
      throw new HttpError(400, "old password is incorrect");
    }
    const bcrypt = await import("bcryptjs");
    user.passwordHash = bcrypt.default.hashSync(body.newPassword, 10);
    user.updatedAt = new Date().toISOString();
    audit(req, "user.password.update", { resourceType: "user", resourceId: user.id });
    store.save();
    ok(res, true);
  })
);

app.get("/api/departments", (_req, res) => {
  ok(
    res,
    [...store.data.departments].sort((left, right) => left.id - right.id)
  );
});

const departmentSchema = z.object({
  name: z.string().min(1).max(128),
  parentId: z.number().int().positive().optional()
});

app.post("/api/departments", (req, res) => {
  requireAdmin(currentUser(req));
  const body = departmentSchema.parse(req.body);
  if (body.parentId && !store.data.departments.some((department) => department.id === body.parentId)) {
    throw new HttpError(400, "上级部门不存在");
  }
  const createdAt = new Date().toISOString();
  const department = {
    id: store.nextId("department"),
    name: body.name,
    parentId: body.parentId,
    createdAt,
    updatedAt: createdAt
  };
  store.data.departments.push(department);
  store.save();
  ok(res, department);
});

app.put("/api/departments/:id", (req, res) => {
  requireAdmin(currentUser(req));
  const department = assertFound(store.data.departments.find((item) => item.id === idParam(req)), "部门不存在");
  const body = departmentSchema.partial().parse(req.body);
  if (body.parentId === department.id) throw new HttpError(400, "上级部门不能是自身");
  if (body.parentId && !store.data.departments.some((item) => item.id === body.parentId)) {
    throw new HttpError(400, "上级部门不存在");
  }
  Object.assign(department, body, { updatedAt: new Date().toISOString() });
  store.save();
  ok(res, department);
});

app.delete("/api/departments/:id", (req, res) => {
  requireAdmin(currentUser(req));
  const id = idParam(req);
  if (store.data.users.some((user) => user.departmentId === id)) throw new HttpError(400, "部门下仍有用户，不能删除");
  if (store.data.knowledgeBases.some((kb) => kb.departmentId === id)) throw new HttpError(400, "部门下仍有知识库，不能删除");
  store.data.departments = store.data.departments.filter((department) => department.id !== id);
  store.save();
  ok(res, true);
});

app.get("/api/users", (req, res) => {
  const user = currentUser(req);
  if (user.role !== "SUPER_ADMIN" && user.role !== "KB_ADMIN") {
    throw new HttpError(403, "需要管理员权限");
  }
  ok(res, maybePaginated(req, store.data.users.map(publicUserRow)));
});

const createUserSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(6).max(64),
  nickname: z.string().min(1).max(64),
  departmentId: z.number().int().positive().optional(),
  role: z.enum(["SUPER_ADMIN", "KB_ADMIN", "USER"]).default("USER")
});

app.post(
  "/api/users",
  asyncRoute(async (req, res) => {
    requireAdmin(currentUser(req));
    const body = createUserSchema.parse(req.body);
    if (store.data.users.some((user) => user.username === body.username)) {
      throw new HttpError(409, "用户名已存在");
    }
    const bcrypt = await import("bcryptjs");
    const createdAt = new Date().toISOString();
    const user = {
      id: store.nextId("user"),
      username: body.username,
      passwordHash: bcrypt.default.hashSync(body.password, 10),
      nickname: body.nickname,
      departmentId: body.departmentId ?? store.data.departments[0]?.id,
      role: body.role,
      status: 1 as const,
      createdAt,
      updatedAt: createdAt
    };
    store.data.users.push(user);
    store.save();
    ok(res, publicUser(user));
  })
);

app.get("/api/admin/users", (req, res) => {
  requireAdmin(currentUser(req));
  ok(res, maybePaginated(req, store.data.users.map(publicUserRow)));
});

app.patch("/api/admin/users/:userId/status", (req, res) => {
  const admin = currentUser(req);
  requireAdmin(admin);
  const user = assertFound(store.data.users.find((item) => item.id === idParam(req, "userId")), "user not found");
  if (user.id === admin.id) throw new HttpError(400, "cannot change your own status");
  const body = z.object({
    status: z.union([z.literal(0), z.literal(1), z.enum(["active", "disabled"])])
  }).parse(req.body);
  user.status = body.status === "active" ? 1 : body.status === "disabled" ? 0 : body.status;
  user.updatedAt = new Date().toISOString();
  audit(req, "admin.user.status.update", { resourceType: "user", resourceId: user.id, detail: { status: user.status } });
  store.save();
  ok(res, publicUserRow(user));
});

app.get("/api/admin/audit-logs", (req, res) => {
  requireAdmin(currentUser(req));
  const userId = req.query.userId ? Number(req.query.userId) : undefined;
  const action = typeof req.query.action === "string" ? req.query.action : undefined;
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 50)));
  const rows = [...(store.data.auditLogs ?? [])]
    .filter((row) => !Number.isFinite(userId) || row.userId === userId)
    .filter((row) => !action || row.action === action)
    .filter((row) => !from || row.createdAt >= from)
    .filter((row) => !to || row.createdAt <= to)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  ok(res, {
    items: rows.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total: rows.length
  });
});

app.get("/api/admin/stats", (req, res) => {
  requireAdmin(currentUser(req));
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const since = startOfDay.toISOString();
  ok(res, {
    ...systemStats(),
    userCount: store.data.users.length,
    knowledgeBaseCount: store.data.knowledgeBases.length,
    documentCount: store.data.documents.length,
    chunkCount: store.data.chunks.length,
    dailySearchCount: (store.data.auditLogs ?? []).filter((row) => row.action === "rag.search" && row.createdAt >= since).length,
    dailyChatCount: store.data.messages.filter((message) => message.role === "user" && message.createdAt >= since).length
  });
});

const kbSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(512).default(""),
  departmentId: z.number().int().positive().optional(),
  visibility: z.enum(["PUBLIC", "DEPARTMENT", "MEMBERS", "PRIVATE"]).default("PUBLIC"),
  tags: z.union([z.array(z.string()), z.string()]).optional()
});

function applyKnowledgeBaseUpdate(kb: KnowledgeBase, body: Partial<z.infer<typeof kbSchema>>): void {
  const { tags, ...updates } = body;
  if (kb.visibility === "PRIVATE") {
    delete updates.departmentId;
    delete updates.visibility;
  }
  if (updates.visibility === "PRIVATE" && kb.visibility !== "PRIVATE") {
    throw new HttpError(400, "不能在编辑时切换私有/非私有存储位置，请新建对应类型知识库");
  }
  Object.assign(kb, updates);
  if (kb.visibility === "PRIVATE") {
    kb.departmentId = undefined;
  }
  if (tags !== undefined) {
    kb.tags = normalizeTags(tags);
  }
  kb.updatedAt = new Date().toISOString();
}

function knowledgeBaseListPayload(req: Request) {
  const user = currentUser(req);
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword.trim().toLowerCase() : "";
  const role = typeof req.query.role === "string" ? req.query.role : "";
  const privateStore = getUserPrivateStore(user);
  const source = user.role === "USER"
    ? privateStore.data.knowledgeBases.map((kb) => ({ kb, privateData: true }))
    : store.data.knowledgeBases.map((kb) => ({ kb, privateData: false }));
  const list = source
    .filter(({ kb }) => canAccessKb(user, kb))
    .filter(({ kb }) => kb.status !== 0 || canManageKb(user, kb))
    .map(({ kb, privateData }) => publicKnowledgeBase(kb, user, privateData))
    .filter((kb) => !keyword || kb.name.toLowerCase().includes(keyword) || kb.description.toLowerCase().includes(keyword))
    .filter((kb) => !role || kb.myRole === role);
  return maybePaginated(req, list);
}

function createKnowledgeBase(req: Request, res: Response): void {
  const user = currentUser(req);
  const body = kbSchema.parse(req.body);
  if (user.role === "USER" && body.visibility !== "PRIVATE") {
    throw new HttpError(403, "普通用户只能创建私有知识库");
  }
  const isPrivate = body.visibility === "PRIVATE";
  const dataStore = isPrivate ? getUserPrivateStore(user) : store;
  const departmentId = isPrivate ? undefined : body.departmentId ?? user.departmentId ?? store.data.departments[0]?.id;
  if (!isPrivate && departmentId && !store.data.departments.some((department) => department.id === departmentId)) {
    throw new HttpError(400, "部门不存在");
  }
  const createdAt = new Date().toISOString();
  const kb: KnowledgeBase = {
    id: dataStore.nextId("knowledgeBase"),
    name: body.name,
    description: body.description,
    ownerId: user.id,
    departmentId,
    visibility: body.visibility as Visibility,
    tags: normalizeTags(body.tags),
    status: 1,
    documentCount: 0,
    chunkCount: 0,
    qaCount: 0,
    createdAt,
    updatedAt: createdAt
  };
  dataStore.data.knowledgeBases.push(kb);
  audit(req, "kb.create", { resourceType: "knowledgeBase", resourceId: kb.id, detail: { storageScope: isPrivate ? "user" : "server" } });
  dataStore.save();
  ok(res, publicKnowledgeBase(kb, user, isPrivate));
}

app.get("/api/kbs", (req, res) => {
  ok(res, knowledgeBaseListPayload(req));
});

app.post("/api/kbs", (req, res) => {
  createKnowledgeBase(req, res);
});

app.get("/api/knowledge-bases", (req, res) => {
  ok(res, knowledgeBaseListPayload(req));
});

app.post("/api/knowledge-bases", (req, res) => {
  createKnowledgeBase(req, res);
});

function kbMemberPayload(member: (typeof store.data.kbMembers)[number]) {
  const user = store.data.users.find((item) => item.id === member.userId);
  return {
    ...member,
    user: user ? publicUserRow(user) : undefined
  };
}

app.get("/api/kbs/:id/members", (req, res) => {
  const user = currentUser(req);
  const { kb, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  if (privateData) {
    ok(res, []);
    return;
  }
  if (!canManageKb(user, kb)) throw new HttpError(403, "无权管理该知识库成员");
  ok(
    res,
    store.data.kbMembers
      .filter((member) => member.kbId === kb.id)
      .map(kbMemberPayload)
  );
});

const kbMemberSchema = z.object({
  userId: z.number().int().positive(),
  permission: z.enum(["read", "manage"]).optional(),
  role: z.enum(["owner", "manager", "editor", "reader"]).optional()
}).transform((body) => ({
  userId: body.userId,
  permission: body.permission ?? (body.role === "owner" || body.role === "manager" ? "manage" : "read")
}));

app.post("/api/kbs/:id/members", (req, res) => {
  const user = currentUser(req);
  const { kb, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  if (privateData) throw new HttpError(400, "私有知识库不支持成员授权");
  if (!canManageKb(user, kb)) throw new HttpError(403, "无权管理该知识库成员");
  const body = kbMemberSchema.parse(req.body);
  if (!store.data.users.some((item) => item.id === body.userId && item.status === 1)) {
    throw new HttpError(400, "用户不存在或已禁用");
  }
  const existing = store.data.kbMembers.find((member) => member.kbId === kb.id && member.userId === body.userId);
  if (existing) {
    existing.permission = body.permission;
    store.save();
    ok(res, kbMemberPayload(existing));
    return;
  }
  const member = {
    id: store.nextId("kbMember"),
    kbId: kb.id,
    userId: body.userId,
    permission: body.permission,
    createdAt: new Date().toISOString()
  };
  store.data.kbMembers.push(member);
  store.save();
  ok(res, kbMemberPayload(member));
});

app.delete("/api/kbs/:id/members/:userId", (req, res) => {
  const user = currentUser(req);
  const { kb, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  if (privateData) throw new HttpError(400, "私有知识库不支持成员授权");
  if (!canManageKb(user, kb)) throw new HttpError(403, "无权管理该知识库成员");
  const userId = idParam(req, "userId");
  store.data.kbMembers = store.data.kbMembers.filter((member) => member.kbId !== kb.id || member.userId !== userId);
  store.save();
  ok(res, true);
});

app.get("/api/knowledge-bases/:id/members", (req, res) => {
  const user = currentUser(req);
  const { kb, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  if (privateData) {
    ok(res, []);
    return;
  }
  if (!canManageKb(user, kb)) throw new HttpError(403, "无权管理该知识库成员");
  ok(res, store.data.kbMembers.filter((member) => member.kbId === kb.id).map(kbMemberPayload));
});

app.post("/api/knowledge-bases/:id/members", (req, res) => {
  const user = currentUser(req);
  const { kb, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  if (privateData) throw new HttpError(400, "私有知识库不支持成员授权");
  if (!canManageKb(user, kb)) throw new HttpError(403, "无权管理该知识库成员");
  const body = kbMemberSchema.parse(req.body);
  if (!store.data.users.some((item) => item.id === body.userId && item.status === 1)) {
    throw new HttpError(400, "用户不存在或已禁用");
  }
  const existing = store.data.kbMembers.find((member) => member.kbId === kb.id && member.userId === body.userId);
  if (existing) {
    existing.permission = body.permission;
    store.save();
    ok(res, kbMemberPayload(existing));
    return;
  }
  const member = {
    id: store.nextId("kbMember"),
    kbId: kb.id,
    userId: body.userId,
    permission: body.permission,
    createdAt: new Date().toISOString()
  };
  store.data.kbMembers.push(member);
  store.save();
  ok(res, kbMemberPayload(member));
});

app.delete("/api/knowledge-bases/:id/members/:userId", (req, res) => {
  const user = currentUser(req);
  const { kb, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  if (privateData) throw new HttpError(400, "私有知识库不支持成员授权");
  if (!canManageKb(user, kb)) throw new HttpError(403, "无权管理该知识库成员");
  const userId = idParam(req, "userId");
  store.data.kbMembers = store.data.kbMembers.filter((member) => member.kbId !== kb.id || member.userId !== userId);
  store.save();
  ok(res, true);
});

app.get("/api/kbs/:id", (req, res) => {
  const user = currentUser(req);
  const { kb, privateData } = resolveKnowledgeBase(user, idParam(req));
  ok(res, publicKnowledgeBase(kb, user, privateData));
});

app.get("/api/knowledge-bases/:id", (req, res) => {
  const user = currentUser(req);
  const { kb, privateData } = resolveKnowledgeBase(user, idParam(req));
  ok(res, publicKnowledgeBase(kb, user, privateData));
});

app.put("/api/kbs/:id", (req, res) => {
  const user = currentUser(req);
  const { kb, dataStore, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  const body = kbSchema.partial().parse(req.body);
  if (!privateData && body.departmentId && !store.data.departments.some((department) => department.id === body.departmentId)) {
    throw new HttpError(400, "部门不存在");
  }
  applyKnowledgeBaseUpdate(kb, body);
  audit(req, "kb.update", { resourceType: "knowledgeBase", resourceId: kb.id });
  dataStore.save();
  ok(res, publicKnowledgeBase(kb, user, privateData));
});

app.put("/api/knowledge-bases/:id", (req, res) => {
  const user = currentUser(req);
  const { kb, dataStore, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  const body = kbSchema.partial().parse(req.body);
  if (!privateData && body.departmentId && !store.data.departments.some((department) => department.id === body.departmentId)) {
    throw new HttpError(400, "部门不存在");
  }
  applyKnowledgeBaseUpdate(kb, body);
  audit(req, "kb.update", { resourceType: "knowledgeBase", resourceId: kb.id });
  dataStore.save();
  ok(res, publicKnowledgeBase(kb, user, privateData));
});

app.patch("/api/kbs/:id", (req, res) => {
  const user = currentUser(req);
  const { kb, dataStore, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  const body = kbSchema.partial().parse(req.body);
  if (!privateData && body.departmentId && !store.data.departments.some((department) => department.id === body.departmentId)) {
    throw new HttpError(400, "department not found");
  }
  applyKnowledgeBaseUpdate(kb, body);
  audit(req, "kb.update", { resourceType: "knowledgeBase", resourceId: kb.id });
  dataStore.save();
  ok(res, publicKnowledgeBase(kb, user, privateData));
});

app.patch("/api/knowledge-bases/:id", (req, res) => {
  const user = currentUser(req);
  const { kb, dataStore, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  const body = kbSchema.partial().parse(req.body);
  if (!privateData && body.departmentId && !store.data.departments.some((department) => department.id === body.departmentId)) {
    throw new HttpError(400, "department not found");
  }
  applyKnowledgeBaseUpdate(kb, body);
  audit(req, "kb.update", { resourceType: "knowledgeBase", resourceId: kb.id });
  dataStore.save();
  ok(res, publicKnowledgeBase(kb, user, privateData));
});

const statusSchema = z.object({
  status: z.union([z.literal(0), z.literal(1)])
});

app.patch("/api/kbs/:id/status", (req, res) => {
  const user = currentUser(req);
  const { kb, dataStore, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  const body = statusSchema.parse(req.body);
  kb.status = body.status;
  kb.updatedAt = new Date().toISOString();
  dataStore.save();
  ok(res, publicKnowledgeBase(kb, user, privateData));
});

app.patch("/api/knowledge-bases/:id/status", (req, res) => {
  const user = currentUser(req);
  const { kb, dataStore, privateData } = resolveManagedKnowledgeBase(user, idParam(req));
  const body = statusSchema.parse(req.body);
  kb.status = body.status;
  kb.updatedAt = new Date().toISOString();
  dataStore.save();
  ok(res, publicKnowledgeBase(kb, user, privateData));
});

app.delete(
  "/api/kbs/:id",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { kb, dataStore } = resolveManagedKnowledgeBase(user, idParam(req));
    const docs = dataStore.data.documents.filter((document) => document.kbId === kb.id);
    for (const document of docs) {
      await fsp.rm(document.filePath, { force: true });
    }
    const removedSessionIds = new Set(dataStore.data.sessions.filter((session) => session.kbId === kb.id).map((session) => session.id));
    const removedMessageIds = new Set(
      dataStore.data.messages.filter((message) => removedSessionIds.has(message.sessionId)).map((message) => message.id)
    );
    dataStore.data.knowledgeBases = dataStore.data.knowledgeBases.filter((item) => item.id !== kb.id);
    dataStore.data.kbMembers = dataStore.data.kbMembers.filter((member) => member.kbId !== kb.id);
    dataStore.data.documents = dataStore.data.documents.filter((document) => document.kbId !== kb.id);
    dataStore.data.chunks = dataStore.data.chunks.filter((chunk) => chunk.kbId !== kb.id);
    dataStore.data.sessions = dataStore.data.sessions.filter((session) => session.kbId !== kb.id);
    const sessionIds = new Set(dataStore.data.sessions.map((session) => session.id));
    dataStore.data.messages = dataStore.data.messages.filter((message) => sessionIds.has(message.sessionId));
    dataStore.data.references = dataStore.data.references.filter((reference) => !removedMessageIds.has(reference.messageId));
    dataStore.data.feedback = dataStore.data.feedback.filter((feedback) => feedback.kbId !== kb.id);
    if (dataStore === store) store.data.workflowRuns = store.data.workflowRuns.filter((run) => run.kbId !== kb.id);
    dataStore.save();
    ok(res, true);
  })
);

app.delete(
  "/api/knowledge-bases/:id",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { kb, dataStore } = resolveManagedKnowledgeBase(user, idParam(req));
    const docs = dataStore.data.documents.filter((document) => document.kbId === kb.id);
    for (const document of docs) {
      await fsp.rm(document.filePath, { force: true });
    }
    const removedSessionIds = new Set(dataStore.data.sessions.filter((session) => session.kbId === kb.id).map((session) => session.id));
    const removedMessageIds = new Set(
      dataStore.data.messages.filter((message) => removedSessionIds.has(message.sessionId)).map((message) => message.id)
    );
    dataStore.data.knowledgeBases = dataStore.data.knowledgeBases.filter((item) => item.id !== kb.id);
    dataStore.data.kbMembers = dataStore.data.kbMembers.filter((member) => member.kbId !== kb.id);
    dataStore.data.documents = dataStore.data.documents.filter((document) => document.kbId !== kb.id);
    dataStore.data.chunks = dataStore.data.chunks.filter((chunk) => chunk.kbId !== kb.id);
    dataStore.data.sessions = dataStore.data.sessions.filter((session) => session.kbId !== kb.id);
    const sessionIds = new Set(dataStore.data.sessions.map((session) => session.id));
    dataStore.data.messages = dataStore.data.messages.filter((message) => sessionIds.has(message.sessionId));
    dataStore.data.references = dataStore.data.references.filter((reference) => !removedMessageIds.has(reference.messageId));
    dataStore.data.feedback = dataStore.data.feedback.filter((feedback) => feedback.kbId !== kb.id);
    if (dataStore === store) store.data.workflowRuns = store.data.workflowRuns.filter((run) => run.kbId !== kb.id);
    dataStore.save();
    ok(res, true);
  })
);

app.get("/api/kbs/:kbId/documents", (req, res) => {
  const user = currentUser(req);
  const { kb, dataStore } = resolveKnowledgeBase(user, idParam(req, "kbId"));
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "";
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword.trim().toLowerCase() : "";
  const list = dataStore.data.documents
    .filter((document) => document.kbId === kb.id)
    .filter((document) => !status || document.parseStatus === status)
    .filter((document) => !keyword || document.fileName.toLowerCase().includes(keyword) || (document.title ?? "").toLowerCase().includes(keyword))
    .sort((left, right) => right.id - left.id)
    .map(publicDocument);
  ok(res, maybePaginated(req, list));
});

app.get("/api/knowledge-bases/:kbId/documents", (req, res) => {
  const user = currentUser(req);
  const { kb, dataStore } = resolveKnowledgeBase(user, idParam(req, "kbId"));
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "";
  const keyword = typeof req.query.keyword === "string" ? req.query.keyword.trim().toLowerCase() : "";
  const list = dataStore.data.documents
    .filter((document) => document.kbId === kb.id)
    .filter((document) => !status || document.parseStatus === status)
    .filter((document) => !keyword || document.fileName.toLowerCase().includes(keyword) || (document.title ?? "").toLowerCase().includes(keyword))
    .sort((left, right) => right.id - left.id)
    .map(publicDocument);
  ok(res, maybePaginated(req, list));
});

app.post(
  "/api/kbs/:kbId/documents",
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    await enforceRateLimit(req, "upload", appConfig.rateLimit.uploadPerWindow);
    const { kb, dataStore, privateData } = resolveManagedKnowledgeBase(user, idParam(req, "kbId"));
    if (!req.file) throw new HttpError(400, "请选择上传文件");
    if (privateData) {
      const privatePath = path.join(userDataStore.uploadDir(user.id), path.basename(req.file.path));
      fs.mkdirSync(path.dirname(privatePath), { recursive: true });
      fs.renameSync(req.file.path, privatePath);
      req.file.path = privatePath;
    }

    const createdAt = new Date().toISOString();
    const document: KnowledgeDocument = {
      id: dataStore.nextId("document"),
      kbId: kb.id,
      title: typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim().slice(0, 255) : req.file.originalname,
      fileName: req.file.originalname,
      fileType: assertSupportedFile(req.file.originalname),
      fileSize: req.file.size,
      filePath: req.file.path,
      tags: normalizeTags(req.body?.tags),
      parseStatus: "PENDING",
      createdBy: user.id,
      referenceCount: 0,
      createdAt,
      updatedAt: createdAt
    };
    dataStore.data.documents.push(document);
    await parseAndIndexDocument(dataStore, document);
    audit(req, "document.upload", { resourceType: "document", resourceId: document.id, detail: { kbId: kb.id, storageScope: privateData ? "user" : "server" } });
    dataStore.save();
    ok(res, publicDocument(document));
  })
);

app.post(
  "/api/knowledge-bases/:kbId/documents",
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    await enforceRateLimit(req, "upload", appConfig.rateLimit.uploadPerWindow);
    const { kb, dataStore, privateData } = resolveManagedKnowledgeBase(user, idParam(req, "kbId"));
    if (!req.file) throw new HttpError(400, "请选择上传文件");
    if (privateData) {
      const privatePath = path.join(userDataStore.uploadDir(user.id), path.basename(req.file.path));
      fs.mkdirSync(path.dirname(privatePath), { recursive: true });
      fs.renameSync(req.file.path, privatePath);
      req.file.path = privatePath;
    }

    const createdAt = new Date().toISOString();
    const document: KnowledgeDocument = {
      id: dataStore.nextId("document"),
      kbId: kb.id,
      title: typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim().slice(0, 255) : req.file.originalname,
      fileName: req.file.originalname,
      fileType: assertSupportedFile(req.file.originalname),
      fileSize: req.file.size,
      filePath: req.file.path,
      tags: normalizeTags(req.body?.tags),
      parseStatus: "PENDING",
      createdBy: user.id,
      referenceCount: 0,
      createdAt,
      updatedAt: createdAt
    };
    dataStore.data.documents.push(document);
    await parseAndIndexDocument(dataStore, document);
    audit(req, "document.upload", { resourceType: "document", resourceId: document.id, detail: { kbId: kb.id, storageScope: privateData ? "user" : "server" } });
    dataStore.save();
    ok(res, publicDocument(document));
  })
);

app.get("/api/documents/:id", (req, res) => {
  const user = currentUser(req);
  const { document } = resolveDocument(user, idParam(req));
  ok(res, publicDocument(document));
});

app.delete(
  "/api/documents/:id",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { document, kb, dataStore } = resolveDocument(user, idParam(req));
    if (!canEditDocument(user, document, kb)) throw new HttpError(403, "无权删除该文档");
    await fsp.rm(document.filePath, { force: true });
    dataStore.data.documents = dataStore.data.documents.filter((item) => item.id !== document.id);
    dataStore.data.chunks = dataStore.data.chunks.filter((chunk) => chunk.documentId !== document.id);
    dataStore.data.references = dataStore.data.references.filter((reference) => reference.documentId !== document.id);
    dataStore.refreshKnowledgeBaseStats(document.kbId);
    audit(req, "document.delete", { resourceType: "document", resourceId: document.id, detail: { kbId: kb.id } });
    dataStore.save();
    ok(res, true);
  })
);

app.post(
  "/api/documents/:id/reparse",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { document, kb, dataStore } = resolveDocument(user, idParam(req));
    if (!canEditDocument(user, document, kb)) throw new HttpError(403, "无权重新解析该文档");
    await parseAndIndexDocument(dataStore, document);
    audit(req, "document.reparse", { resourceType: "document", resourceId: document.id, detail: { kbId: kb.id } });
    dataStore.save();
    ok(res, publicDocument(document));
  })
);

app.get("/api/tasks/:taskId", (req, res) => {
  const user = currentUser(req);
  const { document } = resolveDocument(user, idParam(req, "taskId"));
  ok(res, taskPayload(document));
});

app.get("/api/documents/:id/chunks", (req, res) => {
  const user = currentUser(req);
  const { document, dataStore } = resolveDocument(user, idParam(req));
  const list = dataStore.data.chunks
    .filter((chunk) => chunk.documentId === document.id)
    .sort((left, right) => left.chunkIndex - right.chunkIndex)
    .map(publicChunk);
  ok(res, maybePaginated(req, list));
});

app.get("/api/documents/:id/download", (req, res) => {
  const user = currentUser(req);
  const { document, kb, dataStore } = resolveDocument(user, idParam(req));
  if (!fs.existsSync(document.filePath)) throw new HttpError(404, "原文件不存在");
  audit(req, "document.download", { resourceType: "document", resourceId: document.id, detail: { kbId: kb.id } });
  dataStore.save();
  res.download(document.filePath, document.fileName);
});

const tagSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  tags: z.array(z.string().min(1).max(40)).optional()
});

function tagSummary(dataStore: ResourceStore, kb: KnowledgeBase) {
  const counts = new Map<string, number>();
  for (const tag of kb.tags ?? []) {
    counts.set(tag, counts.get(tag) ?? 0);
  }
  for (const document of dataStore.data.documents.filter((item) => item.kbId === kb.id)) {
    for (const tag of document.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, documentCount]) => ({ name, documentCount }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function listTags(req: Request, res: Response, kbId: number): void {
  const user = currentUser(req);
  const { kb, dataStore } = resolveKnowledgeBase(user, kbId);
  ok(res, tagSummary(dataStore, kb));
}

function createKbTag(req: Request, res: Response, kbId: number): void {
  const user = currentUser(req);
  const { kb, dataStore } = resolveManagedKnowledgeBase(user, kbId);
  const body = tagSchema.parse(req.body);
  const [tag] = normalizeTags(body.name ? [body.name] : body.tags ?? []);
  if (!tag) throw new HttpError(400, "tag name is required");
  kb.tags = normalizeTags([...(kb.tags ?? []), tag]);
  kb.updatedAt = new Date().toISOString();
  audit(req, "tag.create", { resourceType: "knowledgeBase", resourceId: kb.id, detail: { tag } });
  dataStore.save();
  ok(res, tagSummary(dataStore, kb).find((item) => item.name === tag) ?? { name: tag, documentCount: 0 });
}

app.get("/api/kbs/:kbId/tags", (req, res) => listTags(req, res, idParam(req, "kbId")));
app.get("/api/knowledge-bases/:kbId/tags", (req, res) => listTags(req, res, idParam(req, "kbId")));
app.post("/api/kbs/:kbId/tags", (req, res) => createKbTag(req, res, idParam(req, "kbId")));
app.post("/api/knowledge-bases/:kbId/tags", (req, res) => createKbTag(req, res, idParam(req, "kbId")));

app.post("/api/documents/:id/tags", (req, res) => {
  const user = currentUser(req);
  const { document, kb, dataStore } = resolveDocument(user, idParam(req));
  if (!canEditDocument(user, document, kb)) throw new HttpError(403, "无权更新该文档标签");
  const body = tagSchema.parse(req.body);
  document.tags = normalizeTags(body.tags ?? (body.name ? [body.name] : []));
  document.updatedAt = new Date().toISOString();
  kb.tags = normalizeTags([...(kb.tags ?? []), ...document.tags]);
  audit(req, "document.tags.update", { resourceType: "document", resourceId: document.id, detail: { kbId: kb.id, tags: document.tags } });
  dataStore.save();
  ok(res, publicDocument(document));
});

const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  mode: z.enum(["keyword", "vector", "hybrid"]).default("hybrid"),
  topK: z.number().int().positive().max(50).optional(),
  minScore: z.number().min(0).max(1).optional(),
  filters: z.object({
    documentIds: z.array(z.number().int().positive()).optional(),
    tags: z.array(z.string()).optional()
  }).optional()
});

async function runKnowledgeBaseSearch(req: Request, res: Response, kbId: number): Promise<void> {
  const user = currentUser(req);
  await enforceRateLimit(req, "search", appConfig.rateLimit.searchPerWindow);
  const { kb, dataStore, privateData } = resolveKnowledgeBase(user, kbId);
  assertKnowledgeBaseEnabled(kb);
  const body = searchSchema.parse(req.body);
  const cacheKey = `rag:search:${stableHash({
    userId: user.id,
    kbId: kb.id,
    storageScope: privateData ? "user" : "server",
    kbUpdatedAt: kb.updatedAt,
    query: body.query,
    mode: body.mode,
    topK: body.topK ?? appConfig.rag.topK,
    minScore: body.minScore ?? appConfig.rag.minScore,
    filters: body.filters ?? {}
  })}`;
  const cached = await cache.getJson<{
    query: string;
    mode: string;
    hits: ReturnType<typeof publicRetrievalHit>[];
    latencyMs: number;
  }>(cacheKey);
  if (cached) {
    audit(req, "rag.search", { resourceType: "knowledgeBase", resourceId: kb.id, detail: { mode: body.mode, cached: true } });
    dataStore.save();
    ok(res, { ...cached, cached: true });
    return;
  }
  const allowedDocumentIds = new Set(body.filters?.documentIds ?? []);
  const requiredTags = normalizeTags(body.filters?.tags ?? []);
  const documents = dataStore.data.documents
    .filter((document) => document.kbId === kb.id)
    .filter((document) => !allowedDocumentIds.size || allowedDocumentIds.has(document.id))
    .filter((document) => !requiredTags.length || requiredTags.every((tag) => (document.tags ?? []).includes(tag)));
  const searchableDocumentIds = new Set(documents.map((document) => document.id));
  const chunks = dataStore.data.chunks.filter((chunk) => chunk.kbId === kb.id && searchableDocumentIds.has(chunk.documentId));
  const startedAt = Date.now();
  const hits = retrieveTopK({
    question: body.query,
    kbId: kb.id,
    chunks,
    documents,
    topK: body.topK ?? appConfig.rag.topK,
    minScore: body.minScore ?? appConfig.rag.minScore
  });
  const payload = {
    query: body.query,
    mode: body.mode,
    hits: hits.map(publicRetrievalHit),
    latencyMs: Date.now() - startedAt
  };
  await cache.setJson(cacheKey, payload, appConfig.rag.searchCacheTtlSeconds);
  audit(req, "rag.search", { resourceType: "knowledgeBase", resourceId: kb.id, detail: { mode: body.mode, topK: body.topK ?? appConfig.rag.topK, cached: false } });
  dataStore.save();
  ok(res, payload);
}

app.post("/api/kbs/:id/search", asyncRoute(async (req, res) => runKnowledgeBaseSearch(req, res, idParam(req))));
app.post("/api/knowledge-bases/:kbId/search", asyncRoute(async (req, res) => runKnowledgeBaseSearch(req, res, idParam(req, "kbId"))));

const createSessionSchema = z.object({
  kbId: z.number().int().positive(),
  title: z.string().max(255).optional()
});

app.post("/api/chat/sessions", (req, res) => {
  const user = currentUser(req);
  const body = createSessionSchema.parse(req.body);
  const { kb, dataStore, privateData } = resolveKnowledgeBase(user, body.kbId);
  assertKnowledgeBaseEnabled(kb);
  const session = dataStore.addSession({
    kbId: kb.id,
    userId: user.id,
    title: body.title || "新的问答会话"
  });
  audit(req, "chat.session.create", {
    resourceType: "chatSession",
    resourceId: session.id,
    detail: { kbId: kb.id, storageScope: privateData ? "user" : "server" }
  });
  dataStore.save();
  ok(res, session);
});

app.post("/api/knowledge-bases/:kbId/chat/sessions", (req, res) => {
  const user = currentUser(req);
  const body = z.object({ title: z.string().max(255).optional() }).parse(req.body);
  const { kb, dataStore, privateData } = resolveKnowledgeBase(user, idParam(req, "kbId"));
  assertKnowledgeBaseEnabled(kb);
  const session = dataStore.addSession({
    kbId: kb.id,
    userId: user.id,
    title: body.title || "新的问答会话"
  });
  audit(req, "chat.session.create", {
    resourceType: "chatSession",
    resourceId: session.id,
    detail: { kbId: kb.id, storageScope: privateData ? "user" : "server" }
  });
  dataStore.save();
  ok(res, { ...session, sessionId: session.id });
});

app.get("/api/chat/sessions", (req, res) => {
  const user = currentUser(req);
  const kbId = req.query.kbId ? Number(req.query.kbId) : undefined;
  const status = String(req.query.status ?? "active");
  const dataStore = kbId ? resolveKnowledgeBase(user, kbId).dataStore : user.role === "USER" ? getUserPrivateStore(user) : store;
  const sessions = dataStore.data.sessions
    .filter((session) => session.userId === user.id || user.role === "SUPER_ADMIN")
    .filter((session) => !kbId || session.kbId === kbId)
    .filter((session) => status === "all" || session.status === status)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  ok(res, sessions);
});

const updateSessionSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: "至少提交一个可更新字段" });

function updateSessionArchiveState(req: Request, res: Response, archived: boolean): void {
  const user = currentUser(req);
  const { session, kb, dataStore } = resolveSession(user, idParam(req));
  assertCanAccessSession(user, session);
  const now = new Date().toISOString();
  session.status = archived ? "archived" : "active";
  session.archivedAt = archived ? now : undefined;
  session.updatedAt = now;
  audit(req, archived ? "chat.session.archive" : "chat.session.restore", {
    resourceType: "chatSession",
    resourceId: session.id,
    detail: { kbId: kb.id }
  });
  dataStore.save();
  ok(res, session);
}

app.patch("/api/chat/sessions/:id", (req, res) => {
  const user = currentUser(req);
  const { session, kb, dataStore } = resolveSession(user, idParam(req));
  assertCanAccessSession(user, session);
  const body = updateSessionSchema.parse(req.body);
  const now = new Date().toISOString();
  if (body.title) session.title = body.title;
  session.updatedAt = now;
  audit(req, "chat.session.update", { resourceType: "chatSession", resourceId: session.id, detail: { kbId: kb.id } });
  dataStore.save();
  ok(res, session);
});

app.post("/api/chat/sessions/:id/archive", (req, res) => updateSessionArchiveState(req, res, true));
app.post("/api/chat/sessions/:id/restore", (req, res) => updateSessionArchiveState(req, res, false));

app.delete("/api/chat/sessions/:id", (req, res) => {
  const user = currentUser(req);
  const { session, kb, dataStore } = resolveSession(user, idParam(req));
  assertCanAccessSession(user, session);
  const detail = { kbId: kb.id, ...deleteSessionCascade(dataStore, session) };
  audit(req, "chat.session.delete", { resourceType: "chatSession", resourceId: session.id, detail });
  dataStore.save();
  ok(res, true);
});

app.get("/api/chat/sessions/:id/messages", (req, res) => {
  const user = currentUser(req);
  const { session, dataStore } = resolveSession(user, idParam(req));
  assertCanAccessSession(user, session);
  const messages = dataStore.data.messages
    .filter((message) => message.sessionId === session.id)
    .map((message) => withMessageReferences(dataStore, message));
  ok(res, messages);
});

const questionSchema = z.object({
  question: z.string().min(1).max(2000),
  mode: z.enum(["strict", "general"]).default("strict")
});

app.post(
  "/api/chat/sessions/:id/messages",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { session, kb, dataStore } = resolveSession(user, idParam(req));
    assertCanAccessSession(user, session);
    assertSessionActive(session);
    assertKnowledgeBaseEnabled(kb);
    await enforceRateLimit(req, "chat", appConfig.rateLimit.chatPerWindow);
    const body = questionSchema.parse(req.body);
    const result = await answerQuestion({
      store: dataStore,
      session,
      user,
      question: body.question,
      mode: body.mode,
      prompts: effectivePromptsForUser(user)
    });
    ok(res, result);
  })
);

app.post(
  "/api/chat/sessions/:id/stream",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const { session, kb, dataStore } = resolveSession(user, idParam(req));
    assertCanAccessSession(user, session);
    assertSessionActive(session);
    assertKnowledgeBaseEnabled(kb);
    await enforceRateLimit(req, "chat", appConfig.rateLimit.chatPerWindow);
    const body = questionSchema.parse(req.body);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    const result = await answerQuestion({
      store: dataStore,
      session,
      user,
      question: body.question,
      mode: body.mode,
      prompts: effectivePromptsForUser(user)
    });
    const answer = result.assistantMessage.content;
    res.write(`event: retrieval\ndata: ${JSON.stringify({ hitCount: result.references.length })}\n\n`);
    for (let index = 0; index < answer.length; index += 18) {
      const content = answer.slice(index, index + 18);
      res.write(`event: delta\ndata: ${JSON.stringify({ text: content })}\n\n`);
    }
    const latestCall = [...(store.data.llmCalls ?? [])].reverse().find(
      (call) => call.userId === user.id && call.kbId === kb.id && call.purpose === "chat"
    );
    if (latestCall?.success) {
      res.write(
        `event: usage\ndata: ${JSON.stringify({
          promptTokens: latestCall.promptTokens,
          completionTokens: latestCall.completionTokens,
          totalTokens: latestCall.totalTokens,
          promptCacheHitTokens: latestCall.promptCacheHitTokens,
          promptCacheMissTokens: latestCall.promptCacheMissTokens,
          reasoningTokens: latestCall.reasoningTokens
        })}\n\n`
      );
    }
    res.write(`event: citations\ndata: ${JSON.stringify(result.references)}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ messageId: result.assistantMessage.id, references: result.references })}\n\n`);
    res.end();
  })
);

const feedbackSchema = z.object({
  rating: z.enum(["useful", "useless", "up", "down"]),
  reason: z.string().max(64).default("other"),
  comment: z.string().max(1000).default("")
});

app.post("/api/chat/messages/:messageId/feedback", (req, res) => {
  const user = currentUser(req);
  const messageId = idParam(req, "messageId");
  const { message, session, kb, dataStore } = resolveMessage(user, messageId);
  if (message.role !== "assistant") throw new HttpError(400, "只能评价助手回答");
  if (session.userId !== user.id && user.role !== "SUPER_ADMIN") throw new HttpError(403, "无权评价该回答");
  const body = feedbackSchema.parse(req.body);
  const rating: AnswerFeedback["rating"] = body.rating === "up" ? "useful" : body.rating === "down" ? "useless" : body.rating;
  const reasonMap: Record<string, AnswerFeedback["reason"]> = {
    accurate: "other",
    wrong: "inaccurate",
    no_citation: "no_reference",
    irrelevant: "other",
    inaccurate: "inaccurate",
    no_reference: "no_reference",
    too_long: "too_long",
    incomplete: "incomplete",
    other: "other"
  };
  const normalized = {
    rating,
    reason: reasonMap[body.reason] ?? "other",
    comment: body.comment
  };
  const createdAt = new Date().toISOString();
  const existing = dataStore.data.feedback.find((item) => item.messageId === message.id && item.userId === user.id);
  if (existing) {
    Object.assign(existing, normalized, { createdAt });
    audit(req, "feedback.update", { resourceType: "message", resourceId: message.id, detail: { kbId: kb.id, rating } });
    dataStore.save();
    ok(res, existing);
    return;
  }
  const feedback: AnswerFeedback = {
    id: dataStore.nextId("feedback"),
    messageId: message.id,
    sessionId: session.id,
    kbId: kb.id,
    userId: user.id,
    rating: normalized.rating,
    reason: normalized.reason,
    comment: normalized.comment,
    createdAt
  };
  dataStore.data.feedback.push(feedback);
  audit(req, "feedback.create", { resourceType: "message", resourceId: message.id, detail: { kbId: kb.id, rating } });
  dataStore.save();
  ok(res, feedback);
});

const promptSchema = z.object({
  name: z.string().min(1).max(80),
  scene: z.string().min(1).max(64).default("知识库问答"),
  content: z.string().min(10),
  variables: z.array(z.string().min(1).max(64)).default(["context", "history", "question"]),
  active: z.boolean().default(false)
});

function publicPrompt(prompt: PromptTemplate, user: ReturnType<typeof currentUser>, scope: "admin" | "user") {
  return {
    ...prompt,
    scope,
    canEdit: scope === "user" || user.role !== "USER",
    canDelete: scope === "user" || user.role !== "USER"
  };
}

function promptsForUser(user: ReturnType<typeof currentUser>) {
  if (user.role !== "USER") {
    return store.data.prompts.map((prompt) => publicPrompt(prompt, user, "admin"));
  }
  const userStore = getUserPrivateStore(user);
  const adminPrompts = store.data.prompts.map((prompt) => {
    const state = userStore.data.promptStates.find((item) => item.promptId === prompt.id);
    return publicPrompt(
      {
        ...prompt,
        status: state?.status ?? prompt.status,
        active: state?.active ?? prompt.active
      },
      user,
      "admin"
    );
  });
  const userPrompts = userStore.data.prompts.map((prompt) => publicPrompt(prompt, user, "user"));
  return [...adminPrompts, ...userPrompts];
}

function effectivePromptsForUser(user: ReturnType<typeof currentUser>): PromptTemplate[] {
  return promptsForUser(user)
    .filter((prompt) => prompt.status !== 0)
    .map(({ scope: _scope, canEdit: _canEdit, canDelete: _canDelete, ...prompt }) => prompt);
}

app.get("/api/prompts", (req, res) => ok(res, promptsForUser(currentUser(req))));

app.post("/api/prompts", (req, res) => {
  const user = currentUser(req);
  const body = promptSchema.parse(req.body);
  const createdAt = new Date().toISOString();
  const dataStore = user.role === "USER" ? getUserPrivateStore(user) : store;
  if (body.active) {
    dataStore.data.prompts.forEach((prompt) => {
      prompt.active = false;
    });
    if (user.role === "USER") {
      getUserPrivateStore(user).data.promptStates.forEach((state) => {
        state.active = false;
      });
    }
  }
  const prompt: PromptTemplate = {
    id: dataStore.nextId("prompt"),
    name: body.name,
    scene: body.scene,
    content: body.content,
    variables: body.variables,
    active: body.active,
    status: 1,
    createdBy: user.id,
    createdAt,
    updatedAt: createdAt
  };
  dataStore.data.prompts.push(prompt);
  dataStore.save();
  ok(res, publicPrompt(prompt, user, user.role === "USER" ? "user" : "admin"));
});

app.put("/api/prompts/:id", (req, res) => {
  const user = currentUser(req);
  const id = idParam(req);
  const userStore = getUserPrivateStore(user);
  const userPrompt = userStore.data.prompts.find((item) => item.id === id);
  const prompt = userPrompt ?? assertFound(store.data.prompts.find((item) => item.id === id), "Prompt 不存在");
  const scope: "admin" | "user" = userPrompt ? "user" : "admin";
  if (scope === "admin" && user.role === "USER") throw new HttpError(403, "无权编辑管理员 Prompt 模板");
  const dataStore = scope === "user" ? userStore : store;
  const body = promptSchema.partial().parse(req.body);
  if (body.active && prompt.status === 0) {
    throw new HttpError(400, "禁用的 Prompt 不能设为启用模板");
  }
  if (body.active) {
    dataStore.data.prompts.forEach((item) => {
      item.active = false;
    });
  }
  Object.assign(prompt, body, { updatedAt: new Date().toISOString() });
  if (!dataStore.data.prompts.some((item) => item.status !== 0 && item.active)) {
    const firstEnabledPrompt = dataStore.data.prompts.find((item) => item.status !== 0);
    if (firstEnabledPrompt) firstEnabledPrompt.active = true;
  }
  dataStore.save();
  ok(res, publicPrompt(prompt, user, scope));
});

app.patch("/api/prompts/:id/status", (req, res) => {
  const user = currentUser(req);
  const id = idParam(req);
  const body = statusSchema.parse(req.body);
  const userStore = getUserPrivateStore(user);
  const userPrompt = userStore.data.prompts.find((item) => item.id === id);
  if (userPrompt) {
    userPrompt.status = body.status;
    if (userPrompt.status === 0) userPrompt.active = false;
    userPrompt.updatedAt = new Date().toISOString();
    userStore.save();
    ok(res, publicPrompt(userPrompt, user, "user"));
    return;
  }

  const prompt = assertFound(store.data.prompts.find((item) => item.id === id), "Prompt 不存在");
  if (user.role === "USER") {
    let state = userStore.data.promptStates.find((item) => item.promptId === prompt.id);
    if (!state) {
      state = { promptId: prompt.id, status: prompt.status, active: prompt.active, updatedAt: new Date().toISOString() };
      userStore.data.promptStates.push(state);
    }
    state.status = body.status;
    if (body.status === 0) state.active = false;
    state.updatedAt = new Date().toISOString();
    userStore.save();
    ok(res, promptsForUser(user).find((item) => item.id === prompt.id));
    return;
  }

  prompt.status = body.status;
  if (prompt.status === 0) {
    prompt.active = false;
  }
  if (!store.data.prompts.some((item) => item.status !== 0 && item.active)) {
    const firstEnabledPrompt = store.data.prompts.find((item) => item.status !== 0);
    if (firstEnabledPrompt) firstEnabledPrompt.active = true;
  }
  prompt.updatedAt = new Date().toISOString();
  store.save();
  ok(res, publicPrompt(prompt, user, "admin"));
});

app.delete("/api/prompts/:id", (req, res) => {
  const user = currentUser(req);
  const id = idParam(req);
  const userStore = getUserPrivateStore(user);
  const userPrompt = userStore.data.prompts.find((item) => item.id === id);
  if (userPrompt) {
    userStore.data.prompts = userStore.data.prompts.filter((item) => item.id !== id);
    userStore.save();
    ok(res, true);
    return;
  }

  if (user.role === "USER") throw new HttpError(403, "无权删除管理员 Prompt 模板");
  if (store.data.prompts.length <= 1) throw new HttpError(400, "至少保留一个管理员 Prompt 模板");
  const prompt = assertFound(store.data.prompts.find((item) => item.id === id), "Prompt 不存在");
  store.data.prompts = store.data.prompts.filter((item) => item.id !== id);
  if (prompt.active && store.data.prompts[0]) {
    const firstEnabledPrompt = store.data.prompts.find((item) => item.status !== 0);
    if (firstEnabledPrompt) firstEnabledPrompt.active = true;
  }
  pruneAllUserPromptStates();
  store.save();
  ok(res, true);
});

app.get("/api/feedback/bad", (req, res) => {
  ok(res, badFeedbackRows(currentUser(req)));
});

const workflowFieldSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
  type: z.enum(["text", "textarea", "number"]).default("text"),
  required: z.boolean().optional()
});

const workflowSchema = z.object({
  name: z.string().min(1).max(128),
  scene: z.string().min(1).max(64),
  description: z.string().max(512).default(""),
  config: z.object({
    inputFields: z.array(workflowFieldSchema).default([]),
    prompt: z.string().min(1),
    requiresKb: z.boolean().optional()
  }),
  status: z.union([z.literal(0), z.literal(1)]).default(1)
});

app.get("/api/workflows", (req, res) => {
  const user = currentUser(req);
  const workflows = store.data.workflows
    .filter((workflow) => workflow.status !== 0 || user.role !== "USER")
    .sort((left, right) => left.id - right.id);
  ok(res, workflows);
});

app.get("/api/workflows/runs", (req, res) => {
  const user = currentUser(req);
  const runs = store.data.workflowRuns
    .filter((run) => user.role === "SUPER_ADMIN" || run.userId === user.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 100)
    .map((run) => ({
      ...run,
      workflow: store.data.workflows.find((workflow) => workflow.id === run.workflowId)
    }));
  ok(res, runs);
});

app.post("/api/workflows", (req, res) => {
  requireAdmin(currentUser(req));
  const body = workflowSchema.parse(req.body);
  const createdAt = new Date().toISOString();
  const workflow = {
    id: store.nextId("workflow"),
    ...body,
    createdAt,
    updatedAt: createdAt
  };
  store.data.workflows.push(workflow);
  store.save();
  ok(res, workflow);
});

app.get("/api/workflows/:id", (req, res) => {
  const workflow = assertFound(store.data.workflows.find((item) => item.id === idParam(req)), "工作流不存在");
  ok(res, workflow);
});

app.put("/api/workflows/:id", (req, res) => {
  requireAdmin(currentUser(req));
  const workflow = assertFound(store.data.workflows.find((item) => item.id === idParam(req)), "工作流不存在");
  const body = workflowSchema.partial().parse(req.body);
  Object.assign(workflow, body, { updatedAt: new Date().toISOString() });
  store.save();
  ok(res, workflow);
});

const workflowRunSchema = z.object({
  kbId: z.number().int().positive().optional(),
  input: z.record(z.string(), z.unknown()).default({})
});

app.post(
  "/api/workflows/:id/run",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const workflow = assertFound(store.data.workflows.find((item) => item.id === idParam(req)), "工作流不存在");
    if (workflow.status === 0) throw new HttpError(403, "工作流已禁用");
    const body = workflowRunSchema.parse(req.body);
    const input = { ...body.input };

    for (const field of workflow.config.inputFields) {
      const value = input[field.key];
      if (field.required && (value === undefined || value === null || String(value).trim() === "")) {
        throw new HttpError(400, `请填写${field.label}`);
      }
      if (field.type === "number" && value !== undefined && value !== null && String(value).trim() !== "") {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) throw new HttpError(400, `${field.label}必须是数字`);
        input[field.key] = numberValue;
      }
    }

    let kbId = body.kbId;
    let context = "无";
    if (workflow.config.requiresKb) {
      if (!kbId) throw new HttpError(400, "该工作流需要选择知识库");
      const { kb, dataStore } = resolveKnowledgeBase(user, kbId);
      assertKnowledgeBaseEnabled(kb);
      const query = Object.values(input).join("\n");
      context = renderWorkflowContext(
        retrieveTopK({
          question: query,
          kbId: kb.id,
          chunks: dataStore.data.chunks,
          documents: dataStore.data.documents,
          topK: appConfig.rag.topK,
          minScore: appConfig.rag.minScore
        })
      );
    } else {
      kbId = undefined;
    }

    const createdAt = new Date().toISOString();
    const prompt = renderWorkflowPrompt(workflow.config.prompt, input, context);
    if (!activeApiKey()) {
      const run = {
        id: store.nextId("workflowRun"),
        workflowId: workflow.id,
        userId: user.id,
        kbId,
        input,
        outputText: "",
        status: "FAILED" as const,
        errorMessage: "未配置 LLM API Key，无法执行 AI 工作流",
        createdAt,
        finishedAt: new Date().toISOString()
      };
      store.data.workflowRuns.push(run);
      store.save();
      throw new HttpError(400, run.errorMessage);
    }

    try {
      const outputText = await callChatCompletion(
        [
          {
            role: "system",
            content: "你是企业 AI 工作流助手。请严格根据用户提供的工作流任务、输入参数和参考资料生成可直接使用的业务结果。"
          },
          { role: "user", content: prompt }
        ],
        { userId: user.id, kbId }
      );
      const run = {
        id: store.nextId("workflowRun"),
        workflowId: workflow.id,
        userId: user.id,
        kbId,
        input,
        outputText,
        status: "SUCCESS" as const,
        createdAt,
        finishedAt: new Date().toISOString()
      };
      store.data.workflowRuns.push(run);
      store.save();
      ok(res, { ...run, workflow });
    } catch (error) {
      const run = {
        id: store.nextId("workflowRun"),
        workflowId: workflow.id,
        userId: user.id,
        kbId,
        input,
        outputText: "",
        status: "FAILED" as const,
        errorMessage: error instanceof Error ? error.message : "工作流执行失败",
        createdAt,
        finishedAt: new Date().toISOString()
      };
      store.data.workflowRuns.push(run);
      store.save();
      throw new HttpError(502, `工作流执行失败：${run.errorMessage}`);
    }
  })
);

app.get("/api/dashboard/overview", (req, res) => {
  ok(res, dashboardOverview(currentUser(req)));
});

app.get("/api/dashboard/questions/hot", (req, res) => {
  ok(res, hotQuestions(currentUser(req)));
});

app.get("/api/dashboard/feedback/bad", (req, res) => {
  ok(res, badFeedbackRows(currentUser(req)));
});

app.get("/api/dashboard/model-calls", (_req, res) => {
  ok(res, [...(store.data.llmCalls ?? [])].reverse().slice(0, 100));
});

app.get(
  "/api/model-config",
  asyncRoute(async (_req, res) => {
    const cached = await cache.getJson<ReturnType<typeof publicModelConfig>>("model-config:public");
    if (cached) {
      ok(res, cached);
      return;
    }

    const config = publicModelConfig();
    await cache.setJson("model-config:public", config);
    ok(res, config);
  })
);

app.get("/api/llm/calls", (_req, res) => {
  ok(res, [...(store.data.llmCalls ?? [])].reverse().slice(0, 30));
});

const modelConfigSchema = z.object({
  provider: z.string().min(1).max(40),
  apiKey: z.string().max(4096).optional(),
  baseUrl: z.string().url(),
  chatModel: z.string().min(1).max(80),
  reasoningModel: z.string().min(1).max(80).optional(),
  thinking: z.enum(["enabled", "disabled"]).default("disabled"),
  reasoningEffort: z.enum(["high", "max"]).default("high"),
  maxTokens: z.number().int().positive().max(384000).default(appConfig.ai.maxTokens),
  embeddingModel: z.string().min(1).max(80),
  clearApiKey: z.boolean().optional()
});

app.put(
  "/api/model-config",
  asyncRoute(async (req, res) => {
  requireAdmin(currentUser(req));
  const body = modelConfigSchema.parse(req.body);
  const candidateApiKey = body.clearApiKey
    ? appConfig.ai.apiKey
    : body.apiKey?.trim()
      ? body.apiKey.trim()
      : readModelApiKey(store.data.modelConfig) || appConfig.ai.apiKey;

  if (candidateApiKey) {
    try {
      await validateChatCompletionConfig({
        apiKey: candidateApiKey,
        baseUrl: body.baseUrl,
        chatModel: body.chatModel
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "未知错误";
      throw new HttpError(400, `LLM 配置验证失败：${detail}`);
    }
  }

  const nextApiKeyEncrypted = body.clearApiKey
    ? undefined
    : body.apiKey?.trim()
      ? encryptSecret(body.apiKey.trim())
      : store.data.modelConfig.apiKeyEncrypted;

  store.data.modelConfig = {
    provider: body.provider,
    apiKeyEncrypted: nextApiKeyEncrypted,
    baseUrl: body.baseUrl,
    chatModel: body.chatModel,
    reasoningModel: body.reasoningModel || appConfig.ai.reasoningModel,
    thinking: body.thinking,
    reasoningEffort: body.reasoningEffort,
    maxTokens: body.maxTokens,
    embeddingModel: body.embeddingModel,
    updatedAt: new Date().toISOString()
  };
  store.save();
  ok(res, publicModelConfig());
  })
);

app.get("/api/admin/llm-config", (req, res) => {
  requireAdmin(currentUser(req));
  ok(res, publicModelConfig());
});

app.put(
  "/api/admin/llm-config",
  asyncRoute(async (req, res) => {
    requireAdmin(currentUser(req));
    const body = modelConfigSchema.parse(req.body);
    const candidateApiKey = body.clearApiKey
      ? appConfig.ai.apiKey
      : body.apiKey?.trim()
        ? body.apiKey.trim()
        : readModelApiKey(store.data.modelConfig) || appConfig.ai.apiKey;

    if (candidateApiKey) {
      try {
        await validateChatCompletionConfig({
          apiKey: candidateApiKey,
          baseUrl: body.baseUrl,
          chatModel: body.chatModel
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "未知错误";
        throw new HttpError(400, `LLM 配置验证失败：${detail}`);
      }
    }

    const nextApiKeyEncrypted = body.clearApiKey
      ? undefined
      : body.apiKey?.trim()
        ? encryptSecret(body.apiKey.trim())
        : store.data.modelConfig.apiKeyEncrypted;

    store.data.modelConfig = {
      provider: body.provider,
      apiKeyEncrypted: nextApiKeyEncrypted,
      baseUrl: body.baseUrl,
      chatModel: body.chatModel,
      reasoningModel: body.reasoningModel || appConfig.ai.reasoningModel,
      thinking: body.thinking,
      reasoningEffort: body.reasoningEffort,
      maxTokens: body.maxTokens,
      embeddingModel: body.embeddingModel,
      updatedAt: new Date().toISOString()
    };
    store.save();
    ok(res, publicModelConfig());
  })
);

app.post(
  "/api/admin/llm-config/test",
  asyncRoute(async (req, res) => {
    requireAdmin(currentUser(req));
    const body = z.object({
      apiKey: z.string().min(1).max(4096),
      baseUrl: z.string().url(),
      model: z.string().min(1).max(80)
    }).parse(req.body);
    const startedAt = Date.now();
    await validateChatCompletionConfig({
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      chatModel: body.model
    });
    ok(res, {
      ok: true,
      latencyMs: Date.now() - startedAt,
      model: body.model
    });
  })
);

app.get(
  "/api/system/stats",
  asyncRoute(async (req, res) => {
    const user = currentUser(req);
    const cacheKey = `system:stats:${user.role}:${user.id}`;
    const cached = await cache.getJson<ReturnType<typeof systemStats>>(cacheKey);
    if (cached) {
      ok(res, cached);
      return;
    }

    const stats = systemStats(user);
    await cache.setJson(cacheKey, stats);
    ok(res, stats);
  })
);

const webDist = path.join(appConfig.rootDir, "dist-web");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, code: 400, message: "参数校验失败", data: error.flatten() });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ success: false, code: error.status, message: error.message, data: null });
    return;
  }
  if (error instanceof multer.MulterError) {
    res.status(400).json({ success: false, code: 400, message: error.message, data: null });
    return;
  }
  const message = error instanceof Error ? error.message : "服务器内部错误";
  res.status(500).json({ success: false, code: 500, message, data: null });
});

app.listen(appConfig.port, () => {
  console.log(`AI Knowledge Base API: http://127.0.0.1:${appConfig.port}`);
});
