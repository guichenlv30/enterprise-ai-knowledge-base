export type UserRole = "SUPER_ADMIN" | "KB_ADMIN" | "USER";
export type Visibility = "PUBLIC" | "DEPARTMENT" | "MEMBERS" | "PRIVATE";
export type ParseStatus = "PENDING" | "PARSING" | "COMPLETED" | "FAILED" | "DISABLED";
export type ChatRole = "user" | "assistant";
export type ChatSessionStatus = "active" | "archived";

export interface Department {
  id: number;
  name: string;
  parentId?: number;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: number;
  username: string;
  passwordHash: string;
  nickname: string;
  departmentId?: number;
  role: UserRole;
  status: 0 | 1;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBase {
  id: number;
  name: string;
  description: string;
  ownerId: number;
  departmentId?: number;
  visibility: Visibility;
  tags?: string[];
  status: 0 | 1;
  documentCount: number;
  chunkCount: number;
  qaCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KbMember {
  id: number;
  kbId: number;
  userId: number;
  permission: "read" | "manage";
  createdAt: string;
}

export interface KnowledgeDocument {
  id: number;
  kbId: number;
  title?: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath: string;
  tags?: string[];
  parseStatus: ParseStatus;
  errorMessage?: string;
  createdBy: number;
  referenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentChunk {
  id: number;
  documentId: number;
  kbId: number;
  chunkIndex: number;
  title: string;
  content: string;
  vectorId: string;
  vector: number[];
  tokenCount: number;
  pageNumber?: number;
  createdAt: string;
}

export interface ChatSession {
  id: number;
  kbId: number;
  userId: number;
  title: string;
  status: ChatSessionStatus;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  sessionId: number;
  role: ChatRole;
  content: string;
  promptSnapshot?: string;
  llmUsed?: boolean;
  llmProvider?: string;
  llmModel?: string;
  answerSource?: "llm" | "local-fallback";
  retrievalCount?: number;
  llmError?: string;
  llmFinishReason?: string;
  createdAt: string;
}

export interface AnswerReference {
  id: number;
  messageId: number;
  chunkId: number;
  documentId: number;
  score: number;
  createdAt: string;
}

export interface PromptTemplate {
  id: number;
  name: string;
  scene: string;
  content: string;
  variables: string[];
  active: boolean;
  status: 0 | 1;
  createdBy?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerFeedback {
  id: number;
  messageId: number;
  sessionId: number;
  kbId: number;
  userId: number;
  rating: "useful" | "useless";
  reason: "inaccurate" | "no_reference" | "too_long" | "incomplete" | "other";
  comment: string;
  createdAt: string;
}

export interface WorkflowDefinition {
  id: number;
  name: string;
  scene: string;
  description: string;
  config: {
    inputFields: Array<{ key: string; label: string; type: "text" | "textarea" | "number"; required?: boolean }>;
    prompt: string;
    requiresKb?: boolean;
  };
  status: 0 | 1;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: number;
  workflowId: number;
  userId: number;
  kbId?: number;
  input: Record<string, unknown>;
  outputText: string;
  status: "SUCCESS" | "FAILED";
  errorMessage?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface ModelConfig {
  provider: string;
  // Legacy plaintext field. It is migrated to apiKeyEncrypted on startup.
  apiKey?: string;
  apiKeyEncrypted?: string;
  baseUrl: string;
  chatModel: string;
  reasoningModel?: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
  maxTokens?: number;
  embeddingModel: string;
  updatedAt: string;
}

export interface LlmCallLog {
  id: string;
  purpose: "validation" | "chat";
  userId?: number;
  kbId?: number;
  provider: string;
  baseUrl: string;
  model: string;
  success: boolean;
  statusCode?: number;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
  finishReason?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface RefreshTokenRecord {
  id: number;
  userId: number;
  tokenHash: string;
  expiresAt: string;
  revokedAt?: string;
  replacedByTokenHash?: string;
  createdAt: string;
}

export interface AuditLog {
  id: number;
  userId?: number;
  action: string;
  resourceType?: string;
  resourceId?: number | string;
  detail?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  createdAt: string;
}

export interface IdCounters {
  department: number;
  user: number;
  knowledgeBase: number;
  kbMember: number;
  document: number;
  chunk: number;
  session: number;
  message: number;
  reference: number;
  prompt: number;
  feedback: number;
  refreshToken: number;
  workflow: number;
  workflowRun: number;
  auditLog: number;
}

export interface AppDatabase {
  meta: {
    ids: IdCounters;
    createdAt: string;
    updatedAt: string;
  };
  departments: Department[];
  users: User[];
  knowledgeBases: KnowledgeBase[];
  kbMembers: KbMember[];
  documents: KnowledgeDocument[];
  chunks: DocumentChunk[];
  sessions: ChatSession[];
  messages: ChatMessage[];
  references: AnswerReference[];
  feedback: AnswerFeedback[];
  prompts: PromptTemplate[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRun[];
  llmCalls: LlmCallLog[];
  refreshTokens: RefreshTokenRecord[];
  auditLogs: AuditLog[];
  modelConfig: ModelConfig;
}

export interface AuthUser {
  id: number;
  username: string;
  nickname: string;
  departmentId?: number;
  role: UserRole;
}

export interface RetrievalHit {
  chunk: DocumentChunk;
  document?: KnowledgeDocument;
  score: number;
}
