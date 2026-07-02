import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { endpoints, setAuthToken, streamAsk } from "../api";
import type {
  AnswerReference,
  AuthUser,
  BadFeedbackItem,
  ChatMessage,
  ChatSession,
  ChatSessionStatus,
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
  SystemStats,
  UserListItem,
  WorkflowDefinition,
  WorkflowRun
} from "../types";

export const useAppStore = defineStore("app", () => {
  const token = ref(localStorage.getItem("aikb_token") || "");
  const refreshToken = ref(localStorage.getItem("aikb_refresh_token") || "");
  const user = ref<AuthUser | null>(null);
  const users = ref<UserListItem[]>([]);
  const departments = ref<Department[]>([]);
  const kbs = ref<KnowledgeBase[]>([]);
  const kbMembers = ref<KbMember[]>([]);
  const selectedKbId = ref<number | null>(null);
  const documents = ref<KnowledgeDocument[]>([]);
  const chunks = ref<DocumentChunk[]>([]);
  const selectedDocumentId = ref<number | null>(null);
  const sessions = ref<ChatSession[]>([]);
  const sessionStatus = ref<ChatSessionStatus>("active");
  const selectedSessionId = ref<number | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const prompts = ref<PromptTemplate[]>([]);
  const stats = ref<SystemStats | null>(null);
  const modelConfig = ref<ModelConfig | null>(null);
  const llmCalls = ref<LlmCallLog[]>([]);
  const dashboardOverview = ref<DashboardOverview | null>(null);
  const hotQuestions = ref<HotQuestion[]>([]);
  const badFeedback = ref<BadFeedbackItem[]>([]);
  const workflows = ref<WorkflowDefinition[]>([]);
  const workflowRuns = ref<WorkflowRun[]>([]);
  const loading = ref(false);

  const currentKb = computed(() => kbs.value.find((kb) => kb.id === selectedKbId.value) ?? null);
  const currentSession = computed(() => sessions.value.find((session) => session.id === selectedSessionId.value) ?? null);
  const currentDocument = computed(() => documents.value.find((document) => document.id === selectedDocumentId.value) ?? null);
  const latestReferences = computed<AnswerReference[]>(() => {
    const assistant = [...messages.value].reverse().find((message) => message.role === "assistant");
    return assistant?.references ?? [];
  });

  async function bootstrap() {
    if (!token.value && !refreshToken.value) return;
    if (!token.value && refreshToken.value) {
      try {
        const result = await endpoints.refresh({ refreshToken: refreshToken.value });
        token.value = result.accessToken || result.token;
        refreshToken.value = result.refreshToken || refreshToken.value;
        localStorage.setItem("aikb_token", token.value);
        localStorage.setItem("aikb_refresh_token", refreshToken.value);
      } catch {
        logout();
        return;
      }
    }
    setAuthToken(token.value);
    try {
      user.value = await endpoints.me();
      await loadDashboard();
    } catch {
      if (!refreshToken.value) {
        logout();
        return;
      }
      try {
        const result = await endpoints.refresh({ refreshToken: refreshToken.value });
        token.value = result.accessToken || result.token;
        refreshToken.value = result.refreshToken || refreshToken.value;
        localStorage.setItem("aikb_token", token.value);
        localStorage.setItem("aikb_refresh_token", refreshToken.value);
        setAuthToken(token.value);
        user.value = result.user;
        await loadDashboard();
      } catch {
        logout();
      }
    }
  }

  async function login(username: string, password: string) {
    const result = await endpoints.login({ username, password });
    token.value = result.accessToken || result.token;
    refreshToken.value = result.refreshToken || "";
    user.value = result.user;
    localStorage.setItem("aikb_token", token.value);
    if (refreshToken.value) localStorage.setItem("aikb_refresh_token", refreshToken.value);
    setAuthToken(token.value);
    await loadDashboard();
  }

  function logout() {
    const tokenToRevoke = refreshToken.value;
    token.value = "";
    refreshToken.value = "";
    user.value = null;
    users.value = [];
    departments.value = [];
    kbs.value = [];
    kbMembers.value = [];
    documents.value = [];
    sessions.value = [];
    sessionStatus.value = "active";
    messages.value = [];
    prompts.value = [];
    stats.value = null;
    modelConfig.value = null;
    llmCalls.value = [];
    dashboardOverview.value = null;
    hotQuestions.value = [];
    badFeedback.value = [];
    workflows.value = [];
    workflowRuns.value = [];
    selectedKbId.value = null;
    selectedSessionId.value = null;
    selectedDocumentId.value = null;
    localStorage.removeItem("aikb_token");
    localStorage.removeItem("aikb_refresh_token");
    setAuthToken(null);
    if (tokenToRevoke) {
      void endpoints.logout({ refreshToken: tokenToRevoke }).catch(() => undefined);
    }
  }

  async function loadDashboard() {
    loading.value = true;
    try {
      const [
        departmentList,
        userList,
        kbList,
        promptList,
        statResult,
        modelResult,
        llmCallResult,
        overviewResult,
        hotQuestionResult,
        badFeedbackResult,
        workflowResult,
        workflowRunResult
      ] = await Promise.all([
        endpoints.departments(),
        user.value?.role !== "USER" ? endpoints.users() : Promise.resolve([]),
        endpoints.kbs(),
        endpoints.prompts(),
        endpoints.stats(),
        endpoints.modelConfig(),
        endpoints.llmCalls(),
        endpoints.dashboardOverview(),
        endpoints.hotQuestions(),
        endpoints.badFeedback(),
        endpoints.workflows(),
        endpoints.workflowRuns()
      ]);
      departments.value = departmentList;
      users.value = userList;
      kbs.value = kbList;
      prompts.value = promptList;
      stats.value = statResult;
      modelConfig.value = modelResult;
      llmCalls.value = llmCallResult;
      dashboardOverview.value = overviewResult;
      hotQuestions.value = hotQuestionResult;
      badFeedback.value = badFeedbackResult;
      workflows.value = workflowResult;
      workflowRuns.value = workflowRunResult;
      if (!selectedKbId.value && kbs.value[0]) {
        selectedKbId.value = (kbs.value.find((kb) => kb.status !== 0) ?? kbs.value[0]).id;
      }
      if (selectedKbId.value && kbs.value.find((kb) => kb.id === selectedKbId.value)?.status === 0) {
        selectedKbId.value = kbs.value.find((kb) => kb.status !== 0)?.id ?? null;
      }
      if (selectedKbId.value) {
        await selectKb(selectedKbId.value);
      }
    } finally {
      loading.value = false;
    }
  }

  async function selectKb(kbId: number) {
    selectedKbId.value = kbId;
    const [docList, sessionList, memberList] = await Promise.all([
      endpoints.documents(kbId),
      endpoints.sessions(kbId, sessionStatus.value),
      currentKb.value && (user.value?.role === "SUPER_ADMIN" || user.value?.role === "KB_ADMIN")
        ? endpoints.kbMembers(kbId).catch(() => [])
        : Promise.resolve([])
    ]);
    documents.value = docList;
    sessions.value = sessionList;
    kbMembers.value = memberList;
    selectedDocumentId.value = documents.value[0]?.id ?? null;
    if (selectedDocumentId.value) {
      await loadChunks(selectedDocumentId.value);
    } else {
      chunks.value = [];
    }
    selectedSessionId.value = sessions.value[0]?.id ?? null;
    if (selectedSessionId.value) {
      await loadMessages(selectedSessionId.value);
    } else {
      messages.value = [];
    }
  }

  async function createKb(payload: { name: string; description: string; visibility: string; departmentId?: number }) {
    const kb = await endpoints.createKb(payload);
    await loadDashboard();
    selectedKbId.value = kb.id;
    await selectKb(kb.id);
  }

  async function updateKb(id: number, payload: { name: string; description: string; visibility: string; departmentId?: number }) {
    await endpoints.updateKb(id, {
      ...payload,
      visibility: payload.visibility as KnowledgeBase["visibility"]
    });
    await loadDashboard();
    selectedKbId.value = id;
    await selectKb(id);
  }

  async function deleteKb(id: number) {
    await endpoints.deleteKb(id);
    selectedKbId.value = null;
    await loadDashboard();
  }

  async function toggleKbStatus(id: number, status: 0 | 1) {
    await endpoints.updateKbStatus(id, status);
    if (status === 0 && selectedKbId.value === id) {
      selectedKbId.value = null;
      selectedDocumentId.value = null;
      selectedSessionId.value = null;
      documents.value = [];
      chunks.value = [];
      sessions.value = [];
      messages.value = [];
    }
    await loadDashboard();
  }

  async function addKbMember(userId: number, permission: "read" | "manage") {
    if (!selectedKbId.value) throw new Error("请先选择知识库");
    await endpoints.addKbMember(selectedKbId.value, { userId, permission });
    kbMembers.value = await endpoints.kbMembers(selectedKbId.value);
  }

  async function removeKbMember(userId: number) {
    if (!selectedKbId.value) throw new Error("请先选择知识库");
    await endpoints.removeKbMember(selectedKbId.value, userId);
    kbMembers.value = await endpoints.kbMembers(selectedKbId.value);
  }

  async function uploadDocument(file: File) {
    if (!selectedKbId.value) throw new Error("请先选择知识库");
    const document = await endpoints.uploadDocument(selectedKbId.value, file);
    await selectKb(selectedKbId.value);
    selectedDocumentId.value = document.id;
    await loadChunks(document.id);
  }

  async function deleteDocument(id: number) {
    await endpoints.deleteDocument(id);
    if (selectedKbId.value) await selectKb(selectedKbId.value);
  }

  async function reparseDocument(id: number) {
    await endpoints.reparseDocument(id);
    if (selectedKbId.value) await selectKb(selectedKbId.value);
  }

  async function loadChunks(documentId: number) {
    selectedDocumentId.value = documentId;
    chunks.value = await endpoints.chunks(documentId);
  }

  async function loadSessionList() {
    if (!selectedKbId.value) {
      sessions.value = [];
      selectedSessionId.value = null;
      messages.value = [];
      return;
    }
    sessions.value = await endpoints.sessions(selectedKbId.value, sessionStatus.value);
    if (selectedSessionId.value && sessions.value.some((session) => session.id === selectedSessionId.value)) return;
    selectedSessionId.value = sessions.value[0]?.id ?? null;
    if (selectedSessionId.value) {
      await loadMessages(selectedSessionId.value);
    } else {
      messages.value = [];
    }
  }

  async function changeSessionStatus(status: ChatSessionStatus) {
    sessionStatus.value = status;
    selectedSessionId.value = null;
    messages.value = [];
    await loadSessionList();
  }

  async function createSession() {
    if (!selectedKbId.value) throw new Error("请先选择知识库");
    sessionStatus.value = "active";
    const session = await endpoints.createSession({ kbId: selectedKbId.value });
    sessions.value = [session, ...sessions.value];
    selectedSessionId.value = session.id;
    messages.value = [];
    return session;
  }

  async function loadMessages(sessionId: number) {
    selectedSessionId.value = sessionId;
    messages.value = await endpoints.messages(sessionId);
  }

  async function renameSession(id: number, title: string) {
    const session = await endpoints.updateSession(id, { title });
    sessions.value = sessions.value.map((item) => (item.id === id ? session : item));
    return session;
  }

  async function archiveSession(id: number) {
    await endpoints.archiveSession(id);
    await loadSessionList();
  }

  async function restoreSession(id: number) {
    await endpoints.restoreSession(id);
    await loadSessionList();
  }

  async function deleteSession(id: number) {
    await endpoints.deleteSession(id);
    await loadSessionList();
    const [statResult, overviewResult, badFeedbackResult] = await Promise.all([
      endpoints.stats(),
      endpoints.dashboardOverview(),
      endpoints.badFeedback()
    ]);
    stats.value = statResult;
    dashboardOverview.value = overviewResult;
    badFeedback.value = badFeedbackResult;
  }

  async function refreshLlmTelemetry() {
    const [statResult, llmCallResult] = await Promise.all([endpoints.stats(), endpoints.llmCalls()]);
    stats.value = statResult;
    llmCalls.value = llmCallResult;
  }

  async function ask(question: string, mode: "strict" | "general") {
    let session = currentSession.value;
    if (!session) {
      session = await createSession();
    }
    if (session.status === "archived") throw new Error("归档会话不能继续提问，请先恢复会话");
    const result = await endpoints.ask(session.id, { question, mode });
    messages.value = [...messages.value, result.userMessage, { ...result.assistantMessage, references: result.references }];
    if (selectedKbId.value) sessions.value = await endpoints.sessions(selectedKbId.value, sessionStatus.value);
    await refreshLlmTelemetry();
  }

  async function askStream(question: string, mode: "strict" | "general") {
    let session = currentSession.value;
    if (!session) {
      session = await createSession();
    }
    if (session.status === "archived") throw new Error("归档会话不能继续提问，请先恢复会话");

    const timestamp = new Date().toISOString();
    const assistant: ChatMessage = {
      id: -Date.now(),
      sessionId: session.id,
      role: "assistant",
      content: "",
      references: [],
      createdAt: timestamp
    };
    messages.value = [
      ...messages.value,
      {
        id: assistant.id - 1,
        sessionId: session.id,
        role: "user",
        content: question,
        references: [],
        createdAt: timestamp
      },
      assistant
    ];

    await streamAsk(session.id, { question, mode }, token.value, (content) => {
      assistant.content += content;
    });
    await loadMessages(session.id);
    if (selectedKbId.value) sessions.value = await endpoints.sessions(selectedKbId.value, sessionStatus.value);
    await refreshLlmTelemetry();
  }

  async function submitFeedback(messageId: number, rating: "useful" | "useless", reason = "other", comment = "") {
    await endpoints.feedback(messageId, { rating, reason, comment });
    const [overviewResult, badFeedbackResult] = await Promise.all([
      endpoints.dashboardOverview(),
      endpoints.badFeedback()
    ]);
    dashboardOverview.value = overviewResult;
    badFeedback.value = badFeedbackResult;
  }

  async function runWorkflow(workflowId: number, input: Record<string, unknown>, kbId?: number) {
    const run = await endpoints.runWorkflow(workflowId, { input, kbId });
    workflowRuns.value = [run, ...workflowRuns.value.filter((item) => item.id !== run.id)].slice(0, 100);
    await refreshLlmTelemetry();
    dashboardOverview.value = await endpoints.dashboardOverview();
    return run;
  }

  async function savePrompt(payload: {
    id?: number;
    name: string;
    scene?: string;
    content: string;
    variables?: string[];
    active: boolean;
  }) {
    if (payload.id) {
      await endpoints.updatePrompt(payload.id, payload);
    } else {
      await endpoints.createPrompt(payload);
    }
    prompts.value = await endpoints.prompts();
  }

  async function deletePrompt(id: number) {
    await endpoints.deletePrompt(id);
    prompts.value = await endpoints.prompts();
  }

  async function togglePromptStatus(id: number, status: 0 | 1) {
    await endpoints.updatePromptStatus(id, status);
    prompts.value = await endpoints.prompts();
  }

  async function saveModelConfig(payload: ModelConfigUpdate) {
    modelConfig.value = await endpoints.updateModelConfig(payload);
    await refreshLlmTelemetry();
  }

  return {
    token,
    refreshToken,
    user,
    users,
    departments,
    kbs,
    kbMembers,
    selectedKbId,
    documents,
    chunks,
    selectedDocumentId,
    sessions,
    sessionStatus,
    selectedSessionId,
    messages,
    prompts,
    stats,
    modelConfig,
    llmCalls,
    dashboardOverview,
    hotQuestions,
    badFeedback,
    workflows,
    workflowRuns,
    loading,
    currentKb,
    currentSession,
    currentDocument,
    latestReferences,
    bootstrap,
    login,
    logout,
    loadDashboard,
    selectKb,
    createKb,
    updateKb,
    deleteKb,
    toggleKbStatus,
    addKbMember,
    removeKbMember,
    uploadDocument,
    deleteDocument,
    reparseDocument,
    loadChunks,
    loadSessionList,
    changeSessionStatus,
    createSession,
    loadMessages,
    renameSession,
    archiveSession,
    restoreSession,
    deleteSession,
    ask,
    askStream,
    submitFeedback,
    runWorkflow,
    savePrompt,
    deletePrompt,
    togglePromptStatus,
    saveModelConfig
  };
});
