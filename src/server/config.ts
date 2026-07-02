import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const rootDir = process.cwd();

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.join(rootDir, value);
}

export const appConfig = {
  rootDir,
  port: envNumber("PORT", 8080),
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || "change-me-refresh-secret",
  encryptionSecret: process.env.APP_ENCRYPTION_SECRET || process.env.JWT_SECRET || "change-me-to-a-long-random-secret",
  auth: {
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL || "15m",
    refreshTokenTtl: process.env.REFRESH_TOKEN_TTL || "7d",
    accessTokenExpiresInSeconds: envNumber("ACCESS_TOKEN_EXPIRES_SECONDS", 900)
  },
  uploadDir: resolveFromRoot(process.env.UPLOAD_DIR || "storage/uploads"),
  upload: {
    maxMb: envNumber("MAX_UPLOAD_MB", 30),
    maxBytes: envNumber("MAX_UPLOAD_MB", 30) * 1024 * 1024
  },
  dataFile: resolveFromRoot(process.env.DATA_FILE || "data/app.json"),
  database: {
    driver: process.env.DB_DRIVER === "mysql" ? "mysql" : "json",
    mysql: {
      host: process.env.MYSQL_HOST || "127.0.0.1",
      port: envNumber("MYSQL_PORT", 3306),
      user: process.env.MYSQL_USER || "root",
      password: process.env.MYSQL_PASSWORD || "",
      database: process.env.MYSQL_DATABASE || "enterprise_ai_kb",
      connectionLimit: envNumber("MYSQL_CONNECTION_LIMIT", 10)
    }
  },
  redis: {
    enabled: process.env.REDIS_ENABLED === "true",
    url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    keyPrefix: process.env.REDIS_KEY_PREFIX || "aikb:",
    cacheTtlSeconds: envNumber("REDIS_CACHE_TTL_SECONDS", 60)
  },
  ai: {
    provider: process.env.LLM_PROVIDER || process.env.AI_PROVIDER || "deepseek",
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.AI_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || process.env.AI_BASE_URL || "https://api.deepseek.com",
    chatModel: process.env.DEEPSEEK_CHAT_MODEL || process.env.AI_CHAT_MODEL || "deepseek-v4-flash",
    reasoningModel: process.env.DEEPSEEK_REASONING_MODEL || "deepseek-v4-pro",
    thinking: process.env.DEEPSEEK_THINKING === "enabled" ? "enabled" : "disabled",
    reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT === "max" ? "max" : "high",
    maxTokens: envNumber("DEEPSEEK_MAX_TOKENS", 4096),
    timeoutMs: envNumber("DEEPSEEK_TIMEOUT_MS", 900000),
    streamIncludeUsage: envBool("DEEPSEEK_STREAM_INCLUDE_USAGE", true)
  },
  rag: {
    topK: envNumber("RAG_TOP_K", 5),
    minScore: envNumber("RAG_MIN_SCORE", 0.08),
    chunkSize: envNumber("RAG_CHUNK_SIZE", 700),
    chunkOverlap: envNumber("RAG_CHUNK_OVERLAP", 120),
    searchCacheTtlSeconds: envNumber("RAG_SEARCH_CACHE_TTL_SECONDS", 300)
  },
  rateLimit: {
    windowSeconds: envNumber("RATE_LIMIT_WINDOW_SECONDS", 60),
    loginPerWindow: envNumber("RATE_LIMIT_LOGIN_PER_WINDOW", 10),
    uploadPerWindow: envNumber("RATE_LIMIT_UPLOAD_PER_WINDOW", 10),
    searchPerWindow: envNumber("RATE_LIMIT_SEARCH_PER_WINDOW", 60),
    chatPerWindow: envNumber("RATE_LIMIT_CHAT_PER_WINDOW", 30)
  }
};
