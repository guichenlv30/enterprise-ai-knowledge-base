import axios from "axios";
import type {
  AnswerReference,
  AuthUser,
  BadFeedbackItem,
  ChatMessage,
  ChatSession,
  DashboardOverview,
  Department,
  DocumentChunk,
  HotQuestion,
  KnowledgeBase,
  KnowledgeDocument,
  KbMember,
  LlmCallLog,
  ModelConfig,
  ModelConfigUpdate,
  PromptTemplate,
  ChatSessionStatus,
  SystemStats,
  UserListItem,
  WorkflowDefinition,
  WorkflowRun
} from "./types";

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface LoginResult {
  token: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  user: AuthUser;
}

export interface AnswerResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  references: AnswerReference[];
}

export const api = axios.create({
  baseURL: "/api",
  timeout: 60000
});

export function setAuthToken(token: string | null): void {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}

async function unwrap<T>(request: Promise<{ data: ApiResponse<T> }>): Promise<T> {
  try {
    const response = await request;
    return response.data.data;
  } catch (error) {
    if (axios.isAxiosError<ApiResponse<unknown>>(error)) {
      throw new Error(error.response?.data?.message || error.message);
    }
    throw error;
  }
}

export const endpoints = {
  login: (payload: { username: string; password: string }) =>
    unwrap<LoginResult>(api.post("/auth/login", payload)),
  refresh: (payload: { refreshToken: string }) =>
    unwrap<LoginResult>(api.post("/auth/refresh", payload)),
  logout: (payload: { refreshToken?: string }) =>
    unwrap<{ revoked: boolean }>(api.post("/auth/logout", payload)),
  me: () => unwrap<AuthUser>(api.get("/users/me")),
  changePassword: (payload: { oldPassword: string; newPassword: string }) =>
    unwrap<boolean>(api.patch("/users/me/password", payload)),
  departments: () => unwrap<Department[]>(api.get("/departments")),
  users: () => unwrap<UserListItem[]>(api.get("/users")),
  kbs: () => unwrap<KnowledgeBase[]>(api.get("/kbs")),
  createKb: (payload: { name: string; description: string; visibility: string; departmentId?: number }) =>
    unwrap<KnowledgeBase>(api.post("/kbs", payload)),
  updateKb: (id: number, payload: Partial<Pick<KnowledgeBase, "name" | "description" | "visibility" | "departmentId">>) =>
    unwrap<KnowledgeBase>(api.put(`/kbs/${id}`, payload)),
  updateKbStatus: (id: number, status: 0 | 1) =>
    unwrap<KnowledgeBase>(api.patch(`/kbs/${id}/status`, { status })),
  deleteKb: (id: number) => unwrap<boolean>(api.delete(`/kbs/${id}`)),
  kbMembers: (id: number) => unwrap<KbMember[]>(api.get(`/kbs/${id}/members`)),
  addKbMember: (id: number, payload: { userId: number; permission: "read" | "manage" }) =>
    unwrap<KbMember>(api.post(`/kbs/${id}/members`, payload)),
  removeKbMember: (id: number, userId: number) => unwrap<boolean>(api.delete(`/kbs/${id}/members/${userId}`)),
  documents: (kbId: number) => unwrap<KnowledgeDocument[]>(api.get(`/kbs/${kbId}/documents`)),
  uploadDocument: (kbId: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return unwrap<KnowledgeDocument>(
      api.post(`/kbs/${kbId}/documents`, form, {
        headers: { "Content-Type": "multipart/form-data" }
      })
    );
  },
  deleteDocument: (id: number) => unwrap<boolean>(api.delete(`/documents/${id}`)),
  reparseDocument: (id: number) => unwrap<KnowledgeDocument>(api.post(`/documents/${id}/reparse`)),
  chunks: (documentId: number) => unwrap<DocumentChunk[]>(api.get(`/documents/${documentId}/chunks`)),
  task: (taskId: number) => unwrap(api.get(`/tasks/${taskId}`)),
  kbTags: (kbId: number) => unwrap<Array<{ name: string; documentCount: number }>>(api.get(`/knowledge-bases/${kbId}/tags`)),
  createKbTag: (kbId: number, name: string) => unwrap(api.post(`/knowledge-bases/${kbId}/tags`, { name })),
  updateDocumentTags: (documentId: number, tags: string[]) =>
    unwrap<KnowledgeDocument>(api.post(`/documents/${documentId}/tags`, { tags })),
  sessions: (kbId?: number, status: ChatSessionStatus | "all" = "active") =>
    unwrap<ChatSession[]>(api.get("/chat/sessions", { params: { ...(kbId ? { kbId } : {}), status } })),
  createSession: (payload: { kbId: number; title?: string }) =>
    unwrap<ChatSession>(api.post("/chat/sessions", payload)),
  updateSession: (id: number, payload: { title: string }) =>
    unwrap<ChatSession>(api.patch(`/chat/sessions/${id}`, payload)),
  archiveSession: (id: number) => unwrap<ChatSession>(api.post(`/chat/sessions/${id}/archive`)),
  restoreSession: (id: number) => unwrap<ChatSession>(api.post(`/chat/sessions/${id}/restore`)),
  deleteSession: (id: number) => unwrap<boolean>(api.delete(`/chat/sessions/${id}`)),
  messages: (sessionId: number) => unwrap<ChatMessage[]>(api.get(`/chat/sessions/${sessionId}/messages`)),
  ask: (sessionId: number, payload: { question: string; mode: "strict" | "general" }) =>
    unwrap<AnswerResult>(api.post(`/chat/sessions/${sessionId}/messages`, payload)),
  feedback: (messageId: number, payload: { rating: "useful" | "useless"; reason?: string; comment?: string }) =>
    unwrap(api.post(`/chat/messages/${messageId}/feedback`, payload)),
  prompts: () => unwrap<PromptTemplate[]>(api.get("/prompts")),
  createPrompt: (payload: { name: string; scene?: string; content: string; variables?: string[]; active: boolean }) =>
    unwrap<PromptTemplate>(api.post("/prompts", payload)),
  updatePrompt: (id: number, payload: Partial<Pick<PromptTemplate, "name" | "scene" | "content" | "variables" | "active">>) =>
    unwrap<PromptTemplate>(api.put(`/prompts/${id}`, payload)),
  updatePromptStatus: (id: number, status: 0 | 1) =>
    unwrap<PromptTemplate>(api.patch(`/prompts/${id}/status`, { status })),
  deletePrompt: (id: number) => unwrap<boolean>(api.delete(`/prompts/${id}`)),
  stats: () => unwrap<SystemStats>(api.get("/system/stats")),
  dashboardOverview: () => unwrap<DashboardOverview>(api.get("/dashboard/overview")),
  hotQuestions: () => unwrap<HotQuestion[]>(api.get("/dashboard/questions/hot")),
  badFeedback: () => unwrap<BadFeedbackItem[]>(api.get("/dashboard/feedback/bad")),
  workflows: () => unwrap<WorkflowDefinition[]>(api.get("/workflows")),
  workflowRuns: () => unwrap<WorkflowRun[]>(api.get("/workflows/runs")),
  runWorkflow: (id: number, payload: { kbId?: number; input: Record<string, unknown> }) =>
    unwrap<WorkflowRun>(api.post(`/workflows/${id}/run`, payload)),
  modelConfig: () => unwrap<ModelConfig>(api.get("/model-config")),
  llmCalls: () => unwrap<LlmCallLog[]>(api.get("/llm/calls")),
  updateModelConfig: (payload: ModelConfigUpdate) => unwrap<ModelConfig>(api.put("/model-config", payload))
};

export async function streamAsk(
  sessionId: number,
  payload: { question: string; mode: "strict" | "general" },
  token: string,
  onMessage: (content: string) => void
): Promise<{ messageId: number; references: AnswerReference[] }> {
  const response = await fetch(`/api/chat/sessions/${sessionId}/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    throw new Error(`流式问答失败：${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload: { messageId: number; references: AnswerReference[] } | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const eventName = event
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.replace("event:", "")
        .trim();
      const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
      if (!eventName || !dataLine) continue;
      const data = JSON.parse(dataLine.replace("data:", "").trim());
      if (eventName === "message" || eventName === "delta") {
        onMessage(data.content ?? data.text ?? "");
      }
      if (eventName === "done") {
        donePayload = data;
      }
    }
  }

  if (!donePayload) throw new Error("流式问答没有返回完成事件");
  return donePayload;
}
