import { appConfig } from "./config.js";
import { callChatCompletionDetailed, type ChatCompletionMessage } from "./llm.js";
import { readModelApiKey } from "./secrets.js";
import { store as globalStore } from "./store.js";
import { retrieveTopK } from "./vector.js";
import type { AnswerReference, AuthUser, ChatSession, KnowledgeDocument, DocumentChunk, PromptTemplate, RetrievalHit } from "./models.js";

export interface RagDataStore {
  data: {
    messages: import("./models.js").ChatMessage[];
    chunks: DocumentChunk[];
    documents: KnowledgeDocument[];
    references: AnswerReference[];
    knowledgeBases: import("./models.js").KnowledgeBase[];
    prompts: PromptTemplate[];
  };
  addMessage(message: Omit<import("./models.js").ChatMessage, "id" | "createdAt">): import("./models.js").ChatMessage;
  nextId(key: "reference"): number;
  save(): void;
}

function renderContext(hits: RetrievalHit[]): string {
  if (hits.length === 0) return "无";
  return hits
    .map((hit, index) => {
      const source = hit.document?.fileName ?? "未知文档";
      return `[${index + 1}] 来源：${source}；标题：${hit.chunk.title}；相似度：${hit.score.toFixed(3)}
${hit.chunk.content}`;
    })
    .join("\n\n");
}

function renderHistory(store: RagDataStore, sessionId: number): string {
  const messages = store.data.messages
    .filter((message) => message.sessionId === sessionId)
    .slice(-8)
    .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`);
  return messages.length ? messages.join("\n") : "无";
}

function activePrompt(prompts: PromptTemplate[]): string | null {
  return prompts.find((prompt) => prompt.status !== 0 && prompt.active)?.content ?? null;
}

function fillPrompt(template: string, params: { context: string; history: string; question: string }): string {
  return template
    .replaceAll("{context}", params.context)
    .replaceAll("{history}", params.history)
    .replaceAll("{question}", params.question)
    .replaceAll("{role}", "企业内部知识库助手")
    .replaceAll("{format}", "简洁回答，并保留引用依据");
}

function defaultQuestionPrompt(params: { context: string; history: string; question: string; hasReferences: boolean }): string {
  const referenceBlock = params.hasReferences ? `【参考资料】\n${params.context}\n\n` : "";
  return `${referenceBlock}【历史对话】\n${params.history}\n\n【用户问题】\n${params.question}`;
}

function systemInstruction(mode: "strict" | "general", hasActivePrompt: boolean): string {
  if (hasActivePrompt) {
    return "你是企业内部知识库问答助手。必须遵循用户消息中【当前启用 Prompt】里的最新规则；该规则优先级高于历史对话中的旧回答风格、旧 Prompt 规则和系统默认问答模式。不要套用已修改或已禁用 Prompt 的旧规则。";
  }

  return mode === "strict"
    ? "你是企业内部知识库问答助手。当前没有启用 Prompt 模板，不要套用已禁用模板中的固定规则。可优先参考检索资料回答；如果没有参考资料且问题是问候、身份、能力或通用问题，请直接自然回答；如果用户明确询问知识库中的制度、流程或文档内容但没有依据，再说明当前知识库中没有找到明确依据。"
    : "你是企业内部知识库问答助手。当前没有启用 Prompt 模板，请正常回答用户问题；有参考资料时优先参考资料，没有参考资料时可以给出通用回答并说明未检索到知识库依据。";
}

function fallbackAnswer(question: string, hits: RetrievalHit[], mode: string): string {
  if (hits.length === 0) {
    if (mode === "general") {
      return `当前知识库中没有找到明确依据。建议补充上传包含“${question}”相关内容的制度、SOP 或 FAQ 文档后再检索。`;
    }
    return "当前知识库中没有找到明确依据";
  }

  const evidence = hits
    .slice(0, 3)
    .map((hit, index) => {
      const source = hit.document?.fileName ?? "未知文档";
      const snippet = hit.chunk.content.replace(/\s+/g, " ").slice(0, 260);
      return `${index + 1}. ${snippet}（来源：${source}）`;
    })
    .join("\n");

  return `根据知识库中检索到的资料，可以参考以下结论：\n${evidence}\n\n请以右侧引用来源为准核对原文。`;
}

function referencePayload(store: RagDataStore, refs: AnswerReference[]) {
  return refs.map((reference) => {
    const chunk = store.data.chunks.find((item) => item.id === reference.chunkId);
    const document = store.data.documents.find((item) => item.id === reference.documentId);
    const publicChunk = chunk ? (({ vector: _vector, ...rest }) => rest)(chunk) : undefined;
    const publicDocument = document ? (({ filePath: _filePath, ...rest }) => rest)(document) : undefined;
    return {
      ...reference,
      chunk: publicChunk,
      document: publicDocument,
      preview: chunk?.content.slice(0, 220) ?? ""
    };
  });
}

export async function answerQuestion(params: {
  store: RagDataStore;
  session: ChatSession;
  user: AuthUser;
  question: string;
  mode?: "strict" | "general";
  prompts?: PromptTemplate[];
}) {
  const mode = params.mode ?? "strict";
  const userMessage = params.store.addMessage({
    sessionId: params.session.id,
    role: "user",
    content: params.question
  });

  const hits = retrieveTopK({
    question: params.question,
    kbId: params.session.kbId,
    chunks: params.store.data.chunks,
    documents: params.store.data.documents,
    topK: appConfig.rag.topK,
    minScore: appConfig.rag.minScore
  });

  const context = renderContext(hits);
  const history = renderHistory(params.store, params.session.id);
  const promptTemplate = activePrompt(params.prompts ?? params.store.data.prompts);
  const prompt = promptTemplate
    ? `【当前启用 Prompt】\n${fillPrompt(promptTemplate, {
        context,
        history,
        question: params.question
      })}`
    : defaultQuestionPrompt({
        context,
        history,
        question: params.question,
        hasReferences: hits.length > 0
      });

  let answer = "";
  let llmUsed = false;
  let llmError: string | undefined;
  let llmFinishReason: string | undefined;
  const modelConfig = globalStore.data.modelConfig;
  const llmProvider = modelConfig.provider;
  const llmModel =
    modelConfig.thinking === "enabled"
      ? modelConfig.reasoningModel || modelConfig.chatModel || appConfig.ai.reasoningModel
      : modelConfig.chatModel || appConfig.ai.chatModel;
  const hasLlmConfig = Boolean((readModelApiKey(modelConfig) || appConfig.ai.apiKey).trim());
  const messages: ChatCompletionMessage[] = [
    {
      role: "system",
      content: systemInstruction(mode, Boolean(promptTemplate))
    },
    { role: "user", content: prompt }
  ];

  if (hasLlmConfig) {
    try {
      const result = await callChatCompletionDetailed(messages, { userId: params.user.id, kbId: params.session.kbId });
      answer = result.content;
      llmFinishReason = result.finishReason;
      llmUsed = true;
    } catch (error) {
      llmError = error instanceof Error ? error.message : "LLM 调用失败";
      answer = fallbackAnswer(params.question, hits, mode);
    }
  } else {
    answer = fallbackAnswer(params.question, hits, mode);
  }

  const assistantMessage = params.store.addMessage({
    sessionId: params.session.id,
    role: "assistant",
    content: answer,
    promptSnapshot: prompt,
    llmUsed,
    llmProvider,
    llmModel,
    answerSource: llmUsed ? "llm" : "local-fallback",
    retrievalCount: hits.length,
    llmError,
    llmFinishReason
  });

  const createdAt = new Date().toISOString();
  const references = hits.map((hit) => {
    const record: AnswerReference = {
      id: params.store.nextId("reference"),
      messageId: assistantMessage.id,
      chunkId: hit.chunk.id,
      documentId: hit.chunk.documentId,
      score: hit.score,
      createdAt
    };
    params.store.data.references.push(record);
    const document = params.store.data.documents.find((item) => item.id === hit.chunk.documentId);
    if (document) document.referenceCount += 1;
    return record;
  });

  params.session.title =
    params.session.title === "新的问答会话" ? params.question.slice(0, 28) : params.session.title;
  params.session.updatedAt = createdAt;
  const kb = params.store.data.knowledgeBases.find((item) => item.id === params.session.kbId);
  if (kb) kb.qaCount += 1;
  params.store.save();

  return {
    userMessage,
    assistantMessage,
    references: referencePayload(params.store, references)
  };
}

export function referencesForMessage(store: RagDataStore, messageId: number) {
  const refs = store.data.references.filter((reference) => reference.messageId === messageId);
  return referencePayload(store, refs);
}
