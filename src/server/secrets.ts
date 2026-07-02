import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appConfig } from "./config.js";

const PREFIX = "v1";

function encryptionKey(): Buffer {
  return createHash("sha256").update(appConfig.encryptionSecret, "utf8").digest();
}

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptSecret(value: string): string {
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(":");
  if (version !== PREFIX || !ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("不支持的密钥密文格式");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 10) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function readModelApiKey(config: { apiKey?: string; apiKeyEncrypted?: string }): string {
  if (config.apiKeyEncrypted) return decryptSecret(config.apiKeyEncrypted);
  return config.apiKey ?? "";
}
