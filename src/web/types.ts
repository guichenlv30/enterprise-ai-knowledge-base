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

export interface AuthUser {
  id: number;
  username: string;
  nickname: string;
  departmentId?: number;
  role: UserRole;
}

export interface UserListItem extends AuthUser {
  departmentName?: string;
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
  storageScope?: "server" | "user";
  myRole?: "owner" | "manager" | "reader";
  createdAt: string;
  updatedAt: string;
}

export interface KbMember {
  id: number;
  kbId: number;
  userId: number;
  permission: "read" | "manage";
  createdAt: string;
  user?: UserListItem;
}

export interface KnowledgeDocument {
  id: number;
  kbId: number;
  title?: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath?: string;
  tags?: string[];
  taskId?: number;
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

export interface AnswerReference {
  id: number;
  messageId: number;
  chunkId: number;
  documentId: number;
  score: number;
  preview: string;
  chunk?: DocumentChunk;
  document?: KnowledgeDocument;
  createdAt: string;
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
  references?: AnswerReference[];
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
  scope?: "admin" | "user";
  canEdit?: boolean;
  canDelete?: boolean;
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
  workflow?: WorkflowDefinition;
}

export interface SystemStats {
  departments: number;
  users: number;
  knowledgeBases: number;
  documents: number;
  chunks: number;
  sessions: number;
  messages: number;
  references: number;
  llmCalls: number;
  feedback: number;
  workflows: number;
  workflowRuns: number;
  aiConfigured: boolean;
  cacheDriver?: string;
  redisConnected?: boolean;
  supportedFileTypes: string[];
}

export interface ModelConfig {
  provider: string;
  baseUrl: string;
  chatModel: string;
  reasoningModel?: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
  maxTokens?: number;
  embeddingModel: string;
  apiKeyConfigured?: boolean;
  hasApiKey?: boolean;
  apiKeyPreview?: string;
  apiKeySource?: "database" | "environment" | "none";
  updatedAt: string;
}

export interface ModelConfigUpdate {
  provider: string;
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl: string;
  chatModel: string;
  reasoningModel?: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
  maxTokens?: number;
  embeddingModel: string;
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

export interface DashboardOverview {
  totalQuestions: number;
  usefulRate: number;
  uselessRate: number;
  noHitQuestions: number;
  totalModelCalls: number;
  totalTokens: number;
  avgLatencyMs: number;
  mostReferencedDocuments: Array<{ documentId: number; fileName: string; references: number }>;
}

export interface HotQuestion {
  question: string;
  count: number;
}

export interface BadFeedbackItem extends AnswerFeedback {
  question?: string;
  answer?: string;
  kbName?: string;
}
