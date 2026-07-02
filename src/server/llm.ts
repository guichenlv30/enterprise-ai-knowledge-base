import { createHash, randomUUID } from "node:crypto";
import { appConfig } from "./config.js";
import { readModelApiKey } from "./secrets.js";
import { store } from "./store.js";
import type { ModelConfig } from "./models.js";

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  reasoningTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  finishReason?: string;
  usage: ChatCompletionUsage;
}

export interface ChatCompletionRuntimeConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  chatModel: string;
  reasoningModel?: string;
  thinking: "enabled" | "disabled";
  reasoningEffort: "high" | "max";
  maxTokens: number;
  timeoutMs: number;
  streamIncludeUsage: boolean;
}

function normalizeDeepSeekModelName(model: string): string {
  if (model === "deepseek-chat") return "deepseek-v4-flash";
  if (model === "deepseek-reasoner") return "deepseek-v4-pro";
  return model;
}

function runtimeConfig(modelConfig: ModelConfig): ChatCompletionRuntimeConfig {
  const thinking = modelConfig.thinking ?? (appConfig.ai.thinking as "enabled" | "disabled");
  const configuredModel = thinking === "enabled"
    ? modelConfig.reasoningModel || modelConfig.chatModel || appConfig.ai.reasoningModel
    : modelConfig.chatModel || appConfig.ai.chatModel;

  return {
    provider: modelConfig.provider || appConfig.ai.provider,
    apiKey: readModelApiKey(modelConfig) || appConfig.ai.apiKey,
    baseUrl: modelConfig.baseUrl || appConfig.ai.baseUrl,
    chatModel: normalizeDeepSeekModelName(configuredModel),
    reasoningModel: normalizeDeepSeekModelName(modelConfig.reasoningModel || appConfig.ai.reasoningModel),
    thinking,
    reasoningEffort: modelConfig.reasoningEffort === "max" ? "max" : appConfig.ai.reasoningEffort as "high" | "max",
    maxTokens: Number.isFinite(modelConfig.maxTokens) ? modelConfig.maxTokens! : appConfig.ai.maxTokens,
    timeoutMs: appConfig.ai.timeoutMs,
    streamIncludeUsage: appConfig.ai.streamIncludeUsage
  };
}

function deepSeekUserId(userId?: number): string | undefined {
  if (!userId) return undefined;
  const digest = createHash("sha256")
    .update(`${userId}:${appConfig.encryptionSecret}`)
    .digest("base64url")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 32);
  return `u_${digest}`;
}

async function requestChatCompletion(params: {
  config: ChatCompletionRuntimeConfig;
  messages: ChatCompletionMessage[];
  purpose: "validation" | "chat";
  userId?: number;
  kbId?: number;
  maxTokens?: number;
}): Promise<ChatCompletionResult> {
  const apiKey = params.config.apiKey.trim();
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), params.config.timeoutMs);
  const baseUrl = params.config.baseUrl.replace(/\/$/, "");
  let statusCode: number | undefined;

  function recordCall(success: boolean, extra: {
    errorMessage?: string;
    usage?: ChatCompletionUsage;
    finishReason?: string;
  } = {}) {
    store.data.llmCalls ??= [];
    store.data.llmCalls.push({
      id: randomUUID(),
      purpose: params.purpose,
      userId: params.userId,
      kbId: params.kbId,
      provider: params.config.provider || "deepseek",
      baseUrl,
      model: params.config.chatModel,
      success,
      statusCode,
      durationMs: Date.now() - startedAt,
      promptTokens: extra.usage?.promptTokens,
      completionTokens: extra.usage?.completionTokens,
      totalTokens: extra.usage?.totalTokens,
      promptCacheHitTokens: extra.usage?.promptCacheHitTokens,
      promptCacheMissTokens: extra.usage?.promptCacheMissTokens,
      reasoningTokens: extra.usage?.reasoningTokens,
      finishReason: extra.finishReason,
      errorMessage: extra.errorMessage?.slice(0, 500),
      createdAt: new Date().toISOString()
    });
    store.data.llmCalls = store.data.llmCalls.slice(-100);
    store.save();
  }

  try {
    const body: Record<string, unknown> = {
      model: params.config.chatModel,
      messages: params.messages,
      thinking: { type: params.config.thinking },
      max_tokens: params.maxTokens ?? params.config.maxTokens,
      stream: false,
      user_id: deepSeekUserId(params.userId)
    };
    if (params.config.thinking === "enabled") {
      body.reasoning_effort = params.config.reasoningEffort;
    } else {
      body.temperature = 0;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    statusCode = response.status;

    if (!response.ok) {
      const text = await response.text();
      recordCall(false, { errorMessage: text || response.statusText });
      throw new Error(`LLM request failed: ${response.status} ${text}`);
    }

    const payload = (await response.json()) as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
    };
    const choice = payload.choices?.[0];
    const usage: ChatCompletionUsage = {
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      totalTokens: payload.usage?.total_tokens,
      promptCacheHitTokens: payload.usage?.prompt_cache_hit_tokens,
      promptCacheMissTokens: payload.usage?.prompt_cache_miss_tokens,
      reasoningTokens: payload.usage?.completion_tokens_details?.reasoning_tokens
    };
    const content = choice?.message?.content?.trim();
    if (!content) {
      const hasReasoning = Boolean(choice?.message?.reasoning_content?.trim());
      const reason = hasReasoning
        ? "模型只返回了 reasoning_content，未返回最终 content"
        : `finish_reason=${choice?.finish_reason ?? "unknown"}`;
      recordCall(false, {
        errorMessage: `LLM returned empty content (${reason})`,
        usage,
        finishReason: choice?.finish_reason
      });
      throw new Error(`LLM returned empty content (${reason})`);
    }
    recordCall(true, { usage, finishReason: choice?.finish_reason });
    return { content, usage, finishReason: choice?.finish_reason };
  } catch (error) {
    if (statusCode === undefined) {
      recordCall(false, { errorMessage: error instanceof Error ? error.message : "请求失败" });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callChatCompletion(
  messages: ChatCompletionMessage[],
  meta: { userId?: number; kbId?: number } = {}
): Promise<string> {
  const result = await callChatCompletionDetailed(messages, meta);
  return result.content;
}

export async function callChatCompletionDetailed(
  messages: ChatCompletionMessage[],
  meta: { userId?: number; kbId?: number } = {}
): Promise<ChatCompletionResult> {
  const modelConfig = store.data.modelConfig;
  return requestChatCompletion({
    config: runtimeConfig(modelConfig),
    messages,
    userId: meta.userId,
    kbId: meta.kbId,
    purpose: "chat"
  });
}

export async function validateChatCompletionConfig(params: {
  apiKey: string;
  baseUrl: string;
  chatModel: string;
}): Promise<void> {
  try {
    await requestChatCompletion({
      config: {
        ...runtimeConfig(store.data.modelConfig),
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
        chatModel: normalizeDeepSeekModelName(params.chatModel),
        thinking: "disabled",
        maxTokens: 32,
        timeoutMs: 20000
      },
      purpose: "validation",
      maxTokens: 32,
      messages: [
        { role: "system", content: "You are a connectivity checker. Reply with OK only." },
        { role: "user", content: "ping" }
      ]
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("请求超时，请检查 Base URL 或网络连接");
    }
    throw error;
  }
}
