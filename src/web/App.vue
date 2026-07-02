<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch, type Component } from "vue";
import { ElMessage, ElMessageBox, type UploadRequestOptions } from "element-plus";
import {
  ChatDotRound,
  ChatLineRound,
  Collection,
  DataAnalysis,
  Delete,
  Document,
  Edit,
  MoreFilled,
  OfficeBuilding,
  Operation,
  Plus,
  Refresh,
  RefreshLeft,
  Setting,
  SwitchButton,
  TakeawayBox,
  TrendCharts,
  UploadFilled
} from "@element-plus/icons-vue";
import { useAppStore } from "./stores/app";
import type { ChatSession, ChatSessionStatus, KnowledgeBase, PromptTemplate, Visibility, WorkflowDefinition } from "./types";

type SectionKey = "dashboard" | "chat" | "kbs" | "prompts" | "workflows" | "feedback" | "system";

const app = useAppStore();
const activeSection = ref<SectionKey>("dashboard");
const loginLoading = ref(false);
const actionLoading = ref(false);
const workflowRunning = ref(false);
const streamEnabled = ref(true);
const answerMode = ref<"strict" | "general">("strict");
const question = ref("");
const messageListRef = ref<HTMLElement | null>(null);
const selectedWorkflowId = ref<number | null>(null);
const workflowResult = ref("");

const loginForm = reactive({
  username: "admin",
  password: "admin123"
});

const kbDialogVisible = ref(false);
const kbForm = reactive({
  id: 0,
  name: "",
  description: "",
  departmentId: null as number | null,
  scope: "private" as "private" | "shared",
  visibility: "PUBLIC" as Visibility
});

const promptDialogVisible = ref(false);
const promptForm = reactive({
  id: 0,
  name: "",
  scene: "知识库问答",
  content: "",
  active: false
});

const memberForm = reactive({
  userId: null as number | null,
  permission: "read" as "read" | "manage"
});

const workflowForm = reactive<Record<string, unknown>>({});

const modelForm = reactive({
  provider: "deepseek",
  apiKey: "",
  clearApiKey: false,
  baseUrl: "https://api.deepseek.com",
  chatModel: "deepseek-v4-flash",
  reasoningModel: "deepseek-v4-pro",
  thinking: "disabled" as "enabled" | "disabled",
  reasoningEffort: "high" as "high" | "max",
  maxTokens: 4096,
  embeddingModel: "local-hashing"
});

const menuItems: Array<{ key: SectionKey; label: string; icon: Component }> = [
  { key: "dashboard", label: "数据看板", icon: DataAnalysis },
  { key: "chat", label: "智能问答", icon: ChatDotRound },
  { key: "kbs", label: "知识库", icon: Collection },
  { key: "prompts", label: "Prompt", icon: Document },
  { key: "workflows", label: "AI 工作流", icon: Operation },
  { key: "feedback", label: "质量反馈", icon: ChatLineRound },
  { key: "system", label: "系统", icon: Setting }
];

const selectedKb = computed(() => app.currentKb);
const selectedDocument = computed(() => app.currentDocument);
const canManage = computed(() => app.user?.role === "SUPER_ADMIN" || app.user?.role === "KB_ADMIN");
const canCreateSharedKb = computed(() => app.user?.role !== "USER");
const selectedWorkflow = computed(() => app.workflows.find((workflow) => workflow.id === selectedWorkflowId.value) ?? null);
const visibleMenuItems = computed(() => app.user?.role === "USER" ? menuItems.filter((item) => item.key !== "system") : menuItems);
const sessionStatusOptions: Array<{ label: string; value: ChatSessionStatus }> = [
  { label: "会话", value: "active" },
  { label: "归档", value: "archived" }
];

watch(
  () => app.modelConfig,
  (value) => {
    if (!value) return;
    modelForm.provider = value.provider;
    modelForm.apiKey = "";
    modelForm.clearApiKey = false;
    modelForm.baseUrl = value.baseUrl;
    modelForm.chatModel = value.chatModel;
    modelForm.reasoningModel = value.reasoningModel || "deepseek-v4-pro";
    modelForm.thinking = value.thinking || "disabled";
    modelForm.reasoningEffort = value.reasoningEffort || "high";
    modelForm.maxTokens = value.maxTokens || 4096;
    modelForm.embeddingModel = value.embeddingModel;
  },
  { immediate: true }
);

onMounted(async () => {
  await app.bootstrap();
  if (!selectedWorkflowId.value && app.workflows[0]) {
    selectWorkflow(app.workflows[0]);
  }
});

watch(
  () => app.workflows,
  (workflows) => {
    if (!selectedWorkflowId.value && workflows[0]) {
      selectWorkflow(workflows[0]);
    }
  }
);

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function llmPurposeLabel(value: "validation" | "chat") {
  return value === "validation" ? "配置验证" : "智能问答";
}

function visibilityLabel(value: Visibility) {
  const labels: Record<Visibility, string> = {
    PUBLIC: "公开",
    DEPARTMENT: "部门可见",
    MEMBERS: "指定成员",
    PRIVATE: "私有"
  };
  return labels[value] ?? value;
}

function departmentLabel(id?: number) {
  return app.departments.find((department) => department.id === id)?.name ?? "未分配";
}

function percent(value?: number) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function roleLabel(value: string) {
  const labels: Record<string, string> = {
    SUPER_ADMIN: "超级管理员",
    KB_ADMIN: "部门管理员",
    USER: "普通员工"
  };
  return labels[value] ?? value;
}

function canEditKb(kb: KnowledgeBase) {
  return kb.myRole === "owner" || kb.myRole === "manager" || canManage.value;
}

function statusType(status: string) {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "PARSING") return "warning";
  return "info";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    PENDING: "待解析",
    PARSING: "解析中",
    COMPLETED: "已完成",
    FAILED: "解析失败"
  };
  return labels[status] ?? status;
}

async function submitLogin() {
  loginLoading.value = true;
  try {
    await app.login(loginForm.username, loginForm.password);
    ElMessage.success("登录成功");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "登录失败");
  } finally {
    loginLoading.value = false;
  }
}

async function handleKbChange(value: number) {
  const kb = app.kbs.find((item) => item.id === value);
  if (kb?.status === 0) {
    ElMessage.warning("知识库已禁用");
    return;
  }
  await app.selectKb(value);
}

async function enterKnowledgeBase(value: number) {
  const kb = app.kbs.find((item) => item.id === value);
  if (kb?.status === 0) {
    ElMessage.warning("知识库已禁用");
    return;
  }
  await app.selectKb(value);
  activeSection.value = "kbs";
}

function openKbDialog(kb?: KnowledgeBase) {
  kbForm.id = kb?.id ?? 0;
  kbForm.name = kb?.name ?? "";
  kbForm.description = kb?.description ?? "";
  kbForm.scope = kb?.visibility === "PRIVATE" || !canCreateSharedKb.value ? "private" : "shared";
  kbForm.departmentId = kbForm.scope === "private" ? null : kb?.departmentId ?? app.user?.departmentId ?? app.departments[0]?.id ?? null;
  kbForm.visibility = kbForm.scope === "private" ? "PRIVATE" : kb?.visibility && kb.visibility !== "PRIVATE" ? kb.visibility : "PUBLIC";
  kbDialogVisible.value = true;
}

async function submitKb() {
  if (!kbForm.name.trim()) {
    ElMessage.warning("请输入知识库名称");
    return;
  }
  actionLoading.value = true;
  try {
    if (kbForm.id) {
      await app.updateKb(kbForm.id, {
        name: kbForm.name,
        description: kbForm.description,
        departmentId: kbForm.scope === "private" ? undefined : kbForm.departmentId ?? undefined,
        visibility: kbForm.scope === "private" ? "PRIVATE" : kbForm.visibility
      });
      ElMessage.success("知识库已更新");
    } else {
      await app.createKb({
        name: kbForm.name,
        description: kbForm.description,
        departmentId: kbForm.scope === "private" ? undefined : kbForm.departmentId ?? undefined,
        visibility: kbForm.scope === "private" ? "PRIVATE" : kbForm.visibility
      });
      ElMessage.success("知识库已创建");
    }
    kbDialogVisible.value = false;
  } finally {
    actionLoading.value = false;
  }
}

async function confirmDeleteKb(id: number) {
  await ElMessageBox.confirm("删除知识库会同时删除文档、片段和会话记录。", "删除知识库", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  await app.deleteKb(id);
  ElMessage.success("知识库已删除");
}

async function toggleKbStatus(kb: KnowledgeBase) {
  await app.toggleKbStatus(kb.id, kb.status === 1 ? 0 : 1);
  ElMessage.success(kb.status === 1 ? "知识库已禁用" : "知识库已启用");
}

async function uploadRequest(options: UploadRequestOptions) {
  try {
    await app.uploadDocument(options.file as File);
    options.onSuccess?.({});
    ElMessage.success("文档解析完成");
  } catch (error) {
    options.onError?.(
      Object.assign(new Error(error instanceof Error ? error.message : "上传失败"), {
        status: 0,
        method: "POST",
        url: ""
      })
    );
    ElMessage.error(error instanceof Error ? error.message : "上传失败");
  }
}

async function selectDocument(id: number) {
  await app.loadChunks(id);
}

async function handleDocumentRowClick(row: { id: number }) {
  await selectDocument(row.id);
}

async function confirmDeleteDocument(id: number) {
  await ElMessageBox.confirm("删除后对应知识片段和引用记录会同步移除。", "删除文档", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  await app.deleteDocument(id);
  ElMessage.success("文档已删除");
}

async function handleSessionStatusChange(value: string | number | boolean) {
  await app.changeSessionStatus(value as ChatSessionStatus);
}

async function renameSession(session: ChatSession) {
  const result = await ElMessageBox.prompt("请输入新的会话标题。", "重命名会话", {
    inputValue: session.title,
    inputPattern: /\S+/,
    inputErrorMessage: "标题不能为空",
    confirmButtonText: "保存",
    cancelButtonText: "取消"
  });
  const title = result.value.trim();
  if (!title) return;
  await app.renameSession(session.id, title);
  ElMessage.success("会话已重命名");
}

async function archiveSession(session: ChatSession) {
  await app.archiveSession(session.id);
  ElMessage.success("会话已归档");
}

async function restoreSession(session: ChatSession) {
  await app.restoreSession(session.id);
  ElMessage.success("会话已恢复");
}

async function deleteSession(session: ChatSession) {
  await ElMessageBox.confirm("删除会同步移除该会话下的全部消息、引用和反馈记录。", "删除会话", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  await app.deleteSession(session.id);
  ElMessage.success("会话已删除");
}

async function handleSessionCommand(command: string | number | object, session: ChatSession) {
  if (command === "rename") await renameSession(session);
  if (command === "archive") await archiveSession(session);
  if (command === "restore") await restoreSession(session);
  if (command === "delete") await deleteSession(session);
}

async function sendQuestion() {
  const text = question.value.trim();
  if (!text) return;
  if (app.currentSession?.status === "archived") {
    ElMessage.warning("归档会话仅可查看，请先恢复后再提问");
    return;
  }
  question.value = "";
  actionLoading.value = true;
  try {
    if (streamEnabled.value) {
      await app.askStream(text, answerMode.value);
    } else {
      await app.ask(text, answerMode.value);
    }
    await nextTick();
    messageListRef.value?.scrollTo({ top: messageListRef.value.scrollHeight, behavior: "smooth" });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "问答失败");
  } finally {
    actionLoading.value = false;
  }
}

function openPromptDialog(prompt?: PromptTemplate) {
  promptForm.id = prompt?.id ?? 0;
  promptForm.name = prompt?.name ?? "";
  promptForm.scene = prompt?.scene ?? "知识库问答";
  promptForm.content = prompt?.content ?? `你是企业内部知识库助手。
请根据【参考资料】回答问题。

【参考资料】
{context}

【历史对话】
{history}

【用户问题】
{question}`;
  promptForm.active = prompt?.active ?? false;
  promptDialogVisible.value = true;
}

async function submitPrompt() {
  if (!promptForm.name.trim() || !promptForm.content.trim()) {
    ElMessage.warning("请完整填写 Prompt");
    return;
  }
  await app.savePrompt({
    id: promptForm.id || undefined,
    name: promptForm.name,
    scene: promptForm.scene,
    content: promptForm.content,
    active: promptForm.active
  });
  promptDialogVisible.value = false;
  ElMessage.success("Prompt 已保存");
}

async function confirmDeletePrompt(id: number) {
  await ElMessageBox.confirm("确认删除该 Prompt 模板？", "删除 Prompt", {
    type: "warning",
    confirmButtonText: "删除",
    cancelButtonText: "取消"
  });
  await app.deletePrompt(id);
  ElMessage.success("Prompt 已删除");
}

async function togglePromptStatus(prompt: PromptTemplate) {
  await app.togglePromptStatus(prompt.id, prompt.status === 1 ? 0 : 1);
  ElMessage.success(prompt.status === 1 ? "Prompt 已禁用" : "Prompt 已启用");
}

async function saveModelConfig() {
  const apiKey = modelForm.apiKey.trim();
  actionLoading.value = true;
  try {
    await app.saveModelConfig({
      provider: modelForm.provider,
      apiKey: apiKey || undefined,
      clearApiKey: modelForm.clearApiKey,
      baseUrl: modelForm.baseUrl,
      chatModel: modelForm.chatModel,
      reasoningModel: modelForm.reasoningModel,
      thinking: modelForm.thinking,
      reasoningEffort: modelForm.reasoningEffort,
      maxTokens: modelForm.maxTokens,
      embeddingModel: modelForm.embeddingModel
    });
    modelForm.apiKey = "";
    modelForm.clearApiKey = false;
    ElMessage.success(app.modelConfig?.apiKeyConfigured ? "模型配置验证通过并已保存" : "模型配置已保存，本地答案模式继续可用");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "模型配置验证失败");
  } finally {
    actionLoading.value = false;
  }
}

async function submitAnswerFeedback(messageId: number, rating: "useful" | "useless", comment = "") {
  await app.submitFeedback(messageId, rating, rating === "useful" ? "other" : "other", comment);
  ElMessage.success(rating === "useful" ? "已标记为有用" : "已提交无用反馈");
}

async function submitBadFeedback(messageId: number) {
  const result = await ElMessageBox.prompt("可以补充说明哪里不准确、缺引用或不完整。", "标记为无用", {
    inputType: "textarea",
    inputPlaceholder: "可选：补充反馈原因",
    confirmButtonText: "提交",
    cancelButtonText: "取消"
  });
  await submitAnswerFeedback(messageId, "useless", result.value || "");
}

async function addMember() {
  if (!memberForm.userId) {
    ElMessage.warning("请选择用户");
    return;
  }
  await app.addKbMember(memberForm.userId, memberForm.permission);
  memberForm.userId = null;
  memberForm.permission = "read";
  ElMessage.success("成员已更新");
}

async function removeMember(userId: number) {
  await app.removeKbMember(userId);
  ElMessage.success("成员已移除");
}

function selectWorkflow(workflow: WorkflowDefinition) {
  selectedWorkflowId.value = workflow.id;
  workflowResult.value = "";
  for (const key of Object.keys(workflowForm)) {
    delete workflowForm[key];
  }
  for (const field of workflow.config.inputFields) {
    workflowForm[field.key] = field.type === "number" ? undefined : "";
  }
}

function setWorkflowField(key: string, value: unknown) {
  workflowForm[key] = value;
}

async function runSelectedWorkflow() {
  if (!selectedWorkflow.value) return;
  workflowRunning.value = true;
  try {
    const run = await app.runWorkflow(
      selectedWorkflow.value.id,
      { ...workflowForm },
      selectedWorkflow.value.config.requiresKb ? app.selectedKbId ?? undefined : undefined
    );
    workflowResult.value = run.outputText;
    ElMessage.success("工作流执行完成");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "工作流执行失败");
  } finally {
    workflowRunning.value = false;
  }
}
</script>

<template>
  <div v-if="!app.user" class="login-screen">
    <section class="login-panel">
      <div class="brand-lockup">
        <span class="brand-mark">AIKB</span>
        <div>
          <h1>企业 AI 知识库问答系统</h1>
          <p>文档入库、语义检索、问答引用、会话追溯</p>
        </div>
      </div>

      <el-form class="login-form" @submit.prevent="submitLogin">
        <el-form-item>
          <el-input v-model="loginForm.username" size="large" placeholder="用户名" />
        </el-form-item>
        <el-form-item>
          <el-input v-model="loginForm.password" size="large" placeholder="密码" type="password" show-password />
        </el-form-item>
        <el-alert title="演示账号：admin / admin123，demo / demo123" type="info" :closable="false" />
        <el-button class="full-button" type="primary" size="large" :loading="loginLoading" @click="submitLogin">
          登录
        </el-button>
      </el-form>
    </section>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="brand-mark compact">AI</span>
        <span>知识库</span>
      </div>
      <nav class="main-nav">
        <button
          v-for="item in visibleMenuItems"
          :key="item.key"
          :class="['nav-button', { active: activeSection === item.key }]"
          @click="activeSection = item.key"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </button>
      </nav>
      <div class="sidebar-user">
        <div>
          <strong>{{ app.user.nickname }}</strong>
          <span>{{ app.user.role }}</span>
        </div>
        <el-button :icon="SwitchButton" circle @click="app.logout" />
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div>
          <h2>{{ menuItems.find((item) => item.key === activeSection)?.label }}</h2>
          <p v-if="selectedKb">{{ selectedKb.name }} · {{ selectedKb.documentCount }} 份文档 · {{ selectedKb.chunkCount }} 个片段</p>
        </div>
        <div class="topbar-actions">
          <el-select
            v-if="app.kbs.length"
            v-model="app.selectedKbId"
            class="kb-select"
            placeholder="选择知识库"
            @change="handleKbChange"
          >
            <el-option
              v-for="kb in app.kbs"
              :key="kb.id"
              :label="kb.status === 0 ? `${kb.name}（已禁用）` : kb.name"
              :value="kb.id"
              :disabled="kb.status === 0"
            />
          </el-select>
          <el-tag :type="app.stats?.aiConfigured ? 'success' : 'info'" effect="plain">
            {{ app.stats?.aiConfigured ? "LLM 已配置" : "本地答案" }}
          </el-tag>
          <el-button :icon="Refresh" @click="app.loadDashboard">刷新</el-button>
        </div>
      </header>

      <section v-if="activeSection === 'dashboard'" class="dashboard-layout">
        <div class="overview-grid">
          <article class="overview-card primary">
            <span>总问答</span>
            <strong>{{ app.dashboardOverview?.totalQuestions ?? 0 }}</strong>
            <p>当前累计用户问题数量</p>
          </article>
          <article class="overview-card">
            <span>有用率</span>
            <strong>{{ percent(app.dashboardOverview?.usefulRate) }}</strong>
            <p>来自用户答案反馈</p>
          </article>
          <article class="overview-card">
            <span>无召回问题</span>
            <strong>{{ app.dashboardOverview?.noHitQuestions ?? 0 }}</strong>
            <p>用于发现知识缺口</p>
          </article>
          <article class="overview-card">
            <span>模型调用</span>
            <strong>{{ app.dashboardOverview?.totalModelCalls ?? 0 }}</strong>
            <p>平均耗时 {{ app.dashboardOverview?.avgLatencyMs ?? 0 }} ms</p>
          </article>
        </div>

        <section class="dashboard-columns">
          <article class="data-panel">
            <div class="panel-title-row">
              <h3>高频问题</h3>
              <el-tag effect="plain">{{ app.hotQuestions.length }} 条</el-tag>
            </div>
            <div class="rank-list">
              <div v-for="(item, index) in app.hotQuestions" :key="item.question" class="rank-row">
                <span>{{ index + 1 }}</span>
                <strong>{{ item.question }}</strong>
                <em>{{ item.count }} 次</em>
              </div>
              <el-empty v-if="!app.hotQuestions.length" description="暂无问题数据" :image-size="72" />
            </div>
          </article>

          <article class="data-panel">
            <div class="panel-title-row">
              <h3>引用最多文档</h3>
              <el-tag effect="plain">{{ app.dashboardOverview?.mostReferencedDocuments.length ?? 0 }} 份</el-tag>
            </div>
            <div class="rank-list">
              <div
                v-for="(item, index) in app.dashboardOverview?.mostReferencedDocuments ?? []"
                :key="item.documentId"
                class="rank-row"
              >
                <span>{{ index + 1 }}</span>
                <strong>{{ item.fileName }}</strong>
                <em>{{ item.references }} 引用</em>
              </div>
              <el-empty
                v-if="!(app.dashboardOverview?.mostReferencedDocuments.length)"
                description="暂无引用数据"
                :image-size="72"
              />
            </div>
          </article>

          <article class="data-panel">
            <div class="panel-title-row">
              <h3>低质量反馈</h3>
              <el-tag type="danger" effect="plain">{{ app.badFeedback.length }} 条</el-tag>
            </div>
            <div class="feedback-preview-list">
              <article v-for="item in app.badFeedback.slice(0, 5)" :key="item.id" class="feedback-preview-item">
                <strong>{{ item.question || "未记录问题" }}</strong>
                <p>{{ item.comment || item.answer || "用户未补充说明" }}</p>
              </article>
              <el-empty v-if="!app.badFeedback.length" description="暂无低质量反馈" :image-size="72" />
            </div>
          </article>
        </section>
      </section>

      <section v-if="activeSection === 'chat'" class="chat-layout">
        <aside class="session-rail">
          <el-button class="full-button" type="primary" :icon="Plus" @click="app.createSession">新会话</el-button>
          <el-segmented
            class="session-filter"
            :model-value="app.sessionStatus"
            :options="sessionStatusOptions"
            @change="handleSessionStatusChange"
          />
          <div class="session-list">
            <div
              v-for="session in app.sessions"
              :key="session.id"
              :class="['session-item', { active: app.selectedSessionId === session.id }]"
            >
              <button class="session-main" @click="app.loadMessages(session.id)">
                <div class="session-title-row">
                  <strong>{{ session.title }}</strong>
                  <el-tag v-if="session.status === 'archived'" size="small" type="info">归档</el-tag>
                </div>
                <span>{{ formatDate(session.updatedAt) }}</span>
              </button>
              <el-dropdown trigger="click" @command="handleSessionCommand($event, session)">
                <el-button class="session-action" text circle :icon="MoreFilled" @click.stop />
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="rename" :icon="Edit">重命名</el-dropdown-item>
                    <el-dropdown-item v-if="session.status !== 'archived'" command="archive" :icon="TakeawayBox">归档</el-dropdown-item>
                    <el-dropdown-item v-else command="restore" :icon="RefreshLeft">恢复</el-dropdown-item>
                    <el-dropdown-item command="delete" :icon="Delete" divided>删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
            <el-empty v-if="!app.sessions.length" description="暂无会话" :image-size="80" />
          </div>
        </aside>

        <section class="conversation">
          <div ref="messageListRef" class="message-list">
            <div v-for="message in app.messages" :key="message.id" :class="['message', message.role]">
              <div class="message-role">{{ message.role === "user" ? "用户" : "助手" }}</div>
              <div class="message-bubble">{{ message.content }}</div>
              <div v-if="message.role === 'assistant'" class="message-meta">
                <el-tag size="small" :type="message.llmUsed ? 'success' : 'info'">
                  {{ message.llmUsed ? `LLM · ${message.llmModel || '已调用'}` : '本地兜底' }}
                </el-tag>
                <el-tag size="small" effect="plain">召回 {{ message.retrievalCount ?? 0 }} 条</el-tag>
                <el-tooltip v-if="message.llmError" :content="message.llmError" placement="top">
                  <el-tag size="small" type="warning">LLM 失败</el-tag>
                </el-tooltip>
                <el-button size="small" text @click="submitAnswerFeedback(message.id, 'useful')">有用</el-button>
                <el-button size="small" text type="danger" @click="submitBadFeedback(message.id)">无用</el-button>
              </div>
            </div>
            <el-empty v-if="!app.messages.length" description="选择或新建会话后开始提问" />
          </div>

          <div v-if="app.currentSession?.status === 'archived'" class="composer-locked">
            <strong>归档会话仅可查看</strong>
            <span>恢复后可以继续提问。</span>
          </div>
          <div v-else class="composer">
            <div class="composer-tools">
              <el-segmented
                v-model="answerMode"
                :options="[
                  { label: '严格知识库', value: 'strict' },
                  { label: '通用增强', value: 'general' }
                ]"
              />
              <el-switch v-model="streamEnabled" active-text="流式" inactive-text="普通" />
            </div>
            <el-input
              v-model="question"
              type="textarea"
              :rows="3"
              resize="none"
              placeholder="输入问题，例如：年假申请需要提前多久？"
              @keydown.ctrl.enter.prevent="sendQuestion"
            />
            <div class="composer-actions">
              <span>Ctrl + Enter</span>
              <el-button type="primary" :loading="actionLoading" @click="sendQuestion">发送</el-button>
            </div>
          </div>
        </section>

        <aside class="reference-panel">
          <h3>引用来源</h3>
          <div v-if="app.latestReferences.length" class="reference-list">
            <article v-for="reference in app.latestReferences" :key="reference.id" class="reference-item">
              <div class="reference-head">
                <strong>{{ reference.document?.fileName || "未知文档" }}</strong>
                <el-tag size="small" type="success">{{ reference.score.toFixed(3) }}</el-tag>
              </div>
              <p>{{ reference.preview }}</p>
            </article>
          </div>
          <el-empty v-else description="暂无引用" :image-size="80" />
        </aside>
      </section>

      <section v-if="activeSection === 'kbs'" class="section-area">
        <div class="section-toolbar">
          <h3>知识库列表</h3>
          <el-button type="primary" :icon="Plus" @click="openKbDialog()">新建知识库</el-button>
        </div>
        <div class="kb-grid">
          <article
            v-for="kb in app.kbs"
            :key="kb.id"
            :class="['kb-card', { disabled: kb.status === 0 }]"
            @click="enterKnowledgeBase(kb.id)"
          >
            <div class="kb-card-main">
              <h3>
                {{ kb.name }}
                <el-tag v-if="kb.status === 0" size="small" type="info">已禁用</el-tag>
                <el-tag v-if="kb.visibility === 'PRIVATE'" size="small" type="success">私有</el-tag>
              </h3>
              <p>{{ kb.description || "暂无描述" }}</p>
            </div>
            <div class="metric-row">
              <span>{{ kb.documentCount }} 文档</span>
              <span>{{ kb.chunkCount }} 片段</span>
              <span>{{ kb.qaCount }} 问答</span>
              <span>{{ visibilityLabel(kb.visibility) }}</span>
              <span v-if="kb.visibility !== 'PRIVATE'">{{ departmentLabel(kb.departmentId) }}</span>
              <span>{{ kb.storageScope === "user" ? "用户库" : "组织库" }}</span>
            </div>
            <div class="card-actions">
              <el-button text :disabled="kb.status === 0" @click.stop="enterKnowledgeBase(kb.id)">进入</el-button>
              <el-button v-if="canEditKb(kb)" text @click.stop="openKbDialog(kb)">编辑</el-button>
              <el-button v-if="canEditKb(kb)" text :type="kb.status === 1 ? 'warning' : 'success'" @click.stop="toggleKbStatus(kb)">
                {{ kb.status === 1 ? "禁用" : "启用" }}
              </el-button>
              <el-button v-if="canEditKb(kb)" text type="danger" @click.stop="confirmDeleteKb(kb.id)">删除</el-button>
            </div>
          </article>
        </div>

        <section v-if="selectedKb" class="documents-layout embedded-documents">
          <section class="document-table-panel">
            <div class="section-toolbar">
              <div>
                <h3>文档管理</h3>
                <p>{{ selectedKb.name }}</p>
              </div>
              <el-upload :show-file-list="false" :http-request="uploadRequest" accept=".pdf,.docx,.txt,.md,.markdown">
                <el-button type="primary" :icon="UploadFilled" :disabled="selectedKb.status === 0">上传文档</el-button>
              </el-upload>
            </div>
            <el-table :data="app.documents" height="420" stripe @row-click="handleDocumentRowClick">
              <el-table-column prop="fileName" label="文件名" min-width="220" />
              <el-table-column prop="fileType" label="类型" width="90" />
              <el-table-column label="大小" width="100">
                <template #default="{ row }">{{ formatBytes(row.fileSize) }}</template>
              </el-table-column>
              <el-table-column label="状态" width="110">
                <template #default="{ row }">
                  <el-tag :type="statusType(row.parseStatus)">{{ statusLabel(row.parseStatus) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="referenceCount" label="引用" width="90" />
              <el-table-column label="操作" width="180" fixed="right">
                <template #default="{ row }">
                  <el-button text :disabled="selectedKb.status === 0" @click.stop="app.reparseDocument(row.id)">重解析</el-button>
                  <el-button text type="danger" @click.stop="confirmDeleteDocument(row.id)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>

          <aside class="chunk-panel">
            <h3>{{ selectedDocument?.fileName || "片段预览" }}</h3>
            <div class="chunk-list">
              <article v-for="chunk in app.chunks" :key="chunk.id" class="chunk-item">
                <div>
                  <strong>#{{ chunk.chunkIndex + 1 }} {{ chunk.title }}</strong>
                  <span>{{ chunk.tokenCount }} 字符</span>
                </div>
                <p>{{ chunk.content }}</p>
              </article>
              <el-empty v-if="!app.chunks.length" description="暂无片段" :image-size="80" />
            </div>
          </aside>
        </section>

        <section v-if="selectedKb && selectedKb.visibility !== 'PRIVATE' && canEditKb(selectedKb)" class="member-panel">
          <div class="panel-title-row">
            <h3>成员授权</h3>
            <el-tag effect="plain">{{ selectedKb.name }}</el-tag>
          </div>
          <div class="member-form">
            <el-select v-model="memberForm.userId" filterable placeholder="选择用户">
              <el-option
                v-for="item in app.users"
                :key="item.id"
                :label="`${item.nickname} / ${item.username} / ${item.departmentName || '未分配'}`"
                :value="item.id"
              />
            </el-select>
            <el-segmented
              v-model="memberForm.permission"
              :options="[
                { label: '可读', value: 'read' },
                { label: '管理', value: 'manage' }
              ]"
            />
            <el-button type="primary" @click="addMember">添加成员</el-button>
          </div>
          <div class="member-list">
            <article v-for="member in app.kbMembers" :key="member.id" class="member-item">
              <div>
                <strong>{{ member.user?.nickname || `用户 ${member.userId}` }}</strong>
                <span>{{ member.user?.username }} · {{ member.user?.departmentName || "未分配" }}</span>
              </div>
              <el-tag>{{ member.permission === "manage" ? "管理" : "可读" }}</el-tag>
              <el-button text type="danger" @click="removeMember(member.userId)">移除</el-button>
            </article>
            <el-empty v-if="!app.kbMembers.length" description="暂无指定成员" :image-size="72" />
          </div>
        </section>
      </section>

      <section v-if="activeSection === 'prompts'" class="section-area">
        <div class="section-toolbar">
          <h3>Prompt 模板</h3>
          <el-button type="primary" :icon="Plus" @click="openPromptDialog()">新建 Prompt</el-button>
        </div>
        <div class="prompt-list">
          <article v-for="prompt in app.prompts" :key="prompt.id" :class="['prompt-row', { disabled: prompt.status === 0 }]">
            <div>
              <div class="row-title">
                <strong>{{ prompt.name }}</strong>
                <el-tag size="small" effect="plain">{{ prompt.scene }}</el-tag>
                <el-tag v-if="prompt.scope === 'admin'" size="small" effect="plain">管理员模板</el-tag>
                <el-tag v-if="prompt.scope === 'user'" size="small" type="success" effect="plain">我的模板</el-tag>
                <el-tag v-if="prompt.active" size="small" type="success">启用</el-tag>
                <el-tag v-if="prompt.status === 0" size="small" type="info">已禁用</el-tag>
              </div>
              <p>{{ prompt.content.slice(0, 180) }}</p>
            </div>
            <div class="row-actions">
              <el-button v-if="prompt.canEdit" @click="openPromptDialog(prompt)">编辑</el-button>
              <el-button :type="prompt.status === 1 ? 'warning' : 'success'" plain @click="togglePromptStatus(prompt)">
                {{ prompt.status === 1 ? "禁用" : "启用" }}
              </el-button>
              <el-button v-if="prompt.canDelete" type="danger" plain @click="confirmDeletePrompt(prompt.id)">删除</el-button>
            </div>
          </article>
        </div>
      </section>

      <section v-if="activeSection === 'workflows'" class="workflow-layout">
        <aside class="workflow-list-panel">
          <div class="section-toolbar compact">
            <h3>工作流中心</h3>
          </div>
          <button
            v-for="workflow in app.workflows"
            :key="workflow.id"
            :class="['workflow-nav-item', { active: selectedWorkflowId === workflow.id, disabled: workflow.status === 0 }]"
            @click="selectWorkflow(workflow)"
          >
            <strong>{{ workflow.name }}</strong>
            <span>{{ workflow.description }}</span>
            <em>{{ workflow.config.requiresKb ? "需要知识库" : "纯输入生成" }}</em>
          </button>
          <el-empty v-if="!app.workflows.length" description="暂无工作流" :image-size="80" />
        </aside>

        <section class="workflow-run-panel">
          <div class="panel-title-row">
            <div>
              <h3>{{ selectedWorkflow?.name || "选择工作流" }}</h3>
              <p>{{ selectedWorkflow?.description || "选择左侧工作流后填写参数执行" }}</p>
            </div>
            <el-tag v-if="selectedWorkflow?.config.requiresKb" type="success" effect="plain">
              {{ selectedKb?.name || "请选择知识库" }}
            </el-tag>
          </div>

          <el-alert
            v-if="selectedWorkflow?.config.requiresKb && !selectedKb"
            title="该工作流需要知识库上下文，请先在顶部选择知识库。"
            type="warning"
            :closable="false"
          />

          <el-form v-if="selectedWorkflow" class="workflow-form" label-position="top">
            <el-form-item v-for="field in selectedWorkflow.config.inputFields" :key="field.key" :label="field.label">
              <el-input-number
                v-if="field.type === 'number'"
                :model-value="workflowForm[field.key] as number | undefined"
                @update:model-value="setWorkflowField(field.key, $event)"
                :min="1"
                controls-position="right"
              />
              <el-input
                v-else-if="field.type === 'textarea'"
                :model-value="String(workflowForm[field.key] ?? '')"
                @update:model-value="setWorkflowField(field.key, $event)"
                type="textarea"
                :rows="5"
                resize="vertical"
              />
              <el-input
                v-else
                :model-value="String(workflowForm[field.key] ?? '')"
                @update:model-value="setWorkflowField(field.key, $event)"
              />
            </el-form-item>
            <el-button type="primary" :loading="workflowRunning" @click="runSelectedWorkflow">执行工作流</el-button>
          </el-form>

          <section v-if="workflowResult" class="workflow-result">
            <div class="panel-title-row">
              <h3>生成结果</h3>
              <el-tag type="success" effect="plain">已完成</el-tag>
            </div>
            <pre>{{ workflowResult }}</pre>
          </section>
        </section>

        <aside class="workflow-history-panel">
          <div class="panel-title-row">
            <h3>运行记录</h3>
            <el-tag effect="plain">{{ app.workflowRuns.length }} 条</el-tag>
          </div>
          <div class="workflow-run-list">
            <article v-for="run in app.workflowRuns.slice(0, 12)" :key="run.id" class="workflow-run-item">
              <div>
                <strong>{{ run.workflow?.name || `工作流 ${run.workflowId}` }}</strong>
                <span>{{ formatDate(run.createdAt) }}</span>
              </div>
              <el-tag :type="run.status === 'SUCCESS' ? 'success' : 'danger'" effect="plain">
                {{ run.status === "SUCCESS" ? "成功" : "失败" }}
              </el-tag>
            </article>
            <el-empty v-if="!app.workflowRuns.length" description="暂无运行记录" :image-size="72" />
          </div>
        </aside>
      </section>

      <section v-if="activeSection === 'feedback'" class="feedback-layout">
        <section class="data-panel">
          <div class="panel-title-row">
            <h3>低质量反馈列表</h3>
            <el-tag type="danger" effect="plain">{{ app.badFeedback.length }} 条</el-tag>
          </div>
          <el-table :data="app.badFeedback" height="calc(100vh - 260px)" stripe>
            <el-table-column prop="kbName" label="知识库" width="180" />
            <el-table-column prop="question" label="问题" min-width="220" show-overflow-tooltip />
            <el-table-column prop="answer" label="回答" min-width="260" show-overflow-tooltip />
            <el-table-column prop="comment" label="反馈说明" min-width="180" show-overflow-tooltip />
            <el-table-column label="时间" width="130">
              <template #default="{ row }">{{ formatDate(row.createdAt) }}</template>
            </el-table-column>
          </el-table>
        </section>

        <aside class="data-panel">
          <div class="panel-title-row">
            <h3>优化线索</h3>
            <el-tag effect="plain">闭环</el-tag>
          </div>
          <div class="quality-metrics">
            <article>
              <span>无用率</span>
              <strong>{{ percent(app.dashboardOverview?.uselessRate) }}</strong>
            </article>
            <article>
              <span>无召回问题</span>
              <strong>{{ app.dashboardOverview?.noHitQuestions ?? 0 }}</strong>
            </article>
            <article>
              <span>总反馈</span>
              <strong>{{ app.stats?.feedback ?? 0 }}</strong>
            </article>
          </div>
          <div class="rank-list">
            <div v-for="item in app.hotQuestions.slice(0, 8)" :key="item.question" class="rank-row">
              <span>{{ item.count }}</span>
              <strong>{{ item.question }}</strong>
            </div>
          </div>
        </aside>
      </section>

      <section v-if="activeSection === 'system'" class="system-layout">
        <div class="system-main-column">
          <div class="stats-grid">
            <article class="stat-box">
              <span>用户</span>
              <strong>{{ app.stats?.users ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>部门</span>
              <strong>{{ app.stats?.departments ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>知识库</span>
              <strong>{{ app.stats?.knowledgeBases ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>文档</span>
              <strong>{{ app.stats?.documents ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>片段</span>
              <strong>{{ app.stats?.chunks ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>会话</span>
              <strong>{{ app.stats?.sessions ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>引用</span>
              <strong>{{ app.stats?.references ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>LLM 调用</span>
              <strong>{{ app.stats?.llmCalls ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>反馈</span>
              <strong>{{ app.stats?.feedback ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>工作流</span>
              <strong>{{ app.stats?.workflows ?? 0 }}</strong>
            </article>
            <article class="stat-box">
              <span>缓存</span>
              <strong>{{ app.stats?.cacheDriver === "redis" && app.stats?.redisConnected ? "Redis" : "本地" }}</strong>
            </article>
          </div>

          <section class="settings-panel">
            <div class="panel-title-row">
              <h3>组织与用户</h3>
              <el-tag effect="plain">{{ app.departments.length }} 部门</el-tag>
            </div>
            <div class="org-grid">
              <article class="org-panel">
                <h4>部门</h4>
                <div v-for="department in app.departments" :key="department.id" class="org-row">
                  <span>{{ department.name }}</span>
                  <em>ID {{ department.id }}</em>
                </div>
              </article>
              <article class="org-panel">
                <h4>用户</h4>
                <div v-for="item in app.users" :key="item.id" class="org-row">
                  <span>{{ item.nickname }} / {{ roleLabel(item.role) }}</span>
                  <em>{{ item.departmentName || "未分配" }}</em>
                </div>
                <el-empty v-if="!app.users.length" description="当前账号无用户列表权限" :image-size="72" />
              </article>
            </div>
          </section>

          <section class="settings-panel llm-log-panel">
            <div class="panel-title-row">
              <h3>最近 LLM 调用</h3>
              <el-tag effect="plain">{{ app.llmCalls.length }} 条</el-tag>
            </div>
            <el-empty v-if="!app.llmCalls.length" description="暂无调用记录" :image-size="72" />
            <div v-else class="llm-call-list">
              <article v-for="call in app.llmCalls" :key="call.id" class="llm-call-item">
                <div class="llm-call-head">
                  <strong>{{ llmPurposeLabel(call.purpose) }}</strong>
                  <el-tag :type="call.success ? 'success' : 'danger'" effect="plain">
                    {{ call.success ? "成功" : "失败" }}
                  </el-tag>
                </div>
                <div class="llm-call-meta">
                  <span>{{ formatDate(call.createdAt) }}</span>
                  <span>{{ call.provider }} / {{ call.model }}</span>
                  <span>{{ call.durationMs }} ms</span>
                  <span v-if="call.statusCode">HTTP {{ call.statusCode }}</span>
                  <span v-if="call.totalTokens">Tokens {{ call.totalTokens }}</span>
                  <span v-if="call.promptCacheHitTokens">Cache hit {{ call.promptCacheHitTokens }}</span>
                  <span v-if="call.reasoningTokens">Reasoning {{ call.reasoningTokens }}</span>
                  <span v-if="call.finishReason">Finish {{ call.finishReason }}</span>
                </div>
                <p v-if="call.errorMessage" class="llm-call-error">{{ call.errorMessage }}</p>
              </article>
            </div>
          </section>
        </div>
        <section class="settings-panel">
          <h3>模型配置</h3>
          <el-alert
            class="model-alert"
            :title="
              app.modelConfig?.apiKeyConfigured
                ? `API Key 已配置：${app.modelConfig.apiKeyPreview}（来源：${app.modelConfig.apiKeySource === 'environment' ? '.env' : '后台配置'}）`
                : '未配置 API Key，问答会使用本地抽取式答案'
            "
            :type="app.modelConfig?.apiKeyConfigured ? 'success' : 'warning'"
            :closable="false"
          />
          <p class="settings-hint">
            保存时会先调用一次对话接口验证 API Key、Base URL 和模型名；验证失败不会保存配置。
          </p>
          <el-form label-position="top">
            <el-form-item label="Provider">
              <el-input v-model="modelForm.provider" />
            </el-form-item>
            <el-form-item label="API Key">
              <el-input
                v-model="modelForm.apiKey"
                type="password"
                show-password
                placeholder="输入新的 API Key；留空则保持当前配置"
                :disabled="modelForm.clearApiKey"
              />
              <el-checkbox v-model="modelForm.clearApiKey" class="clear-key-check">
                清空后台保存的 API Key
              </el-checkbox>
            </el-form-item>
            <el-form-item label="Base URL">
              <el-input v-model="modelForm.baseUrl" />
            </el-form-item>
            <el-form-item label="Chat Model">
              <el-input v-model="modelForm.chatModel" />
            </el-form-item>
            <el-form-item label="Reasoning Model">
              <el-input v-model="modelForm.reasoningModel" />
            </el-form-item>
            <el-form-item label="Thinking">
              <el-segmented
                v-model="modelForm.thinking"
                :options="[
                  { label: '关闭', value: 'disabled' },
                  { label: '开启', value: 'enabled' }
                ]"
              />
            </el-form-item>
            <el-form-item label="Reasoning Effort">
              <el-segmented
                v-model="modelForm.reasoningEffort"
                :disabled="modelForm.thinking === 'disabled'"
                :options="[
                  { label: 'High', value: 'high' },
                  { label: 'Max', value: 'max' }
                ]"
              />
            </el-form-item>
            <el-form-item label="Max Tokens">
              <el-input-number v-model="modelForm.maxTokens" :min="256" :max="384000" :step="512" />
            </el-form-item>
            <el-form-item label="Embedding Model">
              <el-input v-model="modelForm.embeddingModel" />
            </el-form-item>
            <el-button type="primary" :loading="actionLoading" @click="saveModelConfig">
              保存并验证
            </el-button>
          </el-form>
        </section>
      </section>
    </main>

    <el-dialog v-model="kbDialogVisible" :title="kbForm.id ? '编辑知识库' : '新建知识库'" width="560px">
      <el-form label-position="top">
        <el-form-item label="名称">
          <el-input v-model="kbForm.name" />
        </el-form-item>
        <el-form-item v-if="canCreateSharedKb" label="知识库类型">
          <el-segmented
            v-model="kbForm.scope"
            :disabled="Boolean(kbForm.id)"
            :options="[
              { label: '私有', value: 'private' },
              { label: '组织', value: 'shared' }
            ]"
          />
        </el-form-item>
        <el-form-item v-if="kbForm.scope === 'shared'" label="所属部门">
          <el-select v-model="kbForm.departmentId" placeholder="选择部门" clearable>
            <el-option v-for="item in app.departments" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="kbForm.description" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item v-if="kbForm.scope === 'shared'" label="可见范围">
          <el-segmented
            v-model="kbForm.visibility"
            :options="[
              { label: '公开', value: 'PUBLIC' },
              { label: '部门', value: 'DEPARTMENT' },
              { label: '成员', value: 'MEMBERS' }
            ]"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="kbDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="actionLoading" @click="submitKb">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="promptDialogVisible" title="Prompt 模板" width="760px">
      <el-form label-position="top">
        <el-form-item label="名称">
          <el-input v-model="promptForm.name" />
        </el-form-item>
        <el-form-item label="业务场景">
          <el-input v-model="promptForm.scene" placeholder="例如：知识库问答、培训题库、客服话术" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="promptForm.content" type="textarea" :rows="12" />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="promptForm.active">设为当前启用模板</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="promptDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPrompt">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
