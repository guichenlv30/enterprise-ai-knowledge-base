import { createClient, type RedisClientType } from "redis";
import { appConfig } from "./config.js";

export class AppCache {
  private client?: RedisClientType;
  private connectPromise?: Promise<void>;
  private connected = false;
  private nextRetryAt = 0;
  private readonly memory = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly enabled: boolean,
    private readonly url: string,
    private readonly keyPrefix: string,
    private readonly ttlSeconds: number
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const client = await this.getClient();
    if (!client) return this.getMemoryJson<T>(key);
    try {
      const raw = await client.get(this.key(key));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (error) {
      this.logCacheError("Redis get failed", error);
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds = this.ttlSeconds): Promise<void> {
    const client = await this.getClient();
    if (!client) {
      this.setMemoryJson(key, value, ttlSeconds);
      return;
    }
    try {
      await client.set(this.key(key), JSON.stringify(value), { EX: ttlSeconds });
    } catch (error) {
      this.logCacheError("Redis set failed", error);
    }
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.memory.delete(this.key(key));
    }
    const client = await this.getClient();
    if (!client || keys.length === 0) return;
    try {
      await client.del(keys.map((key) => this.key(key)));
    } catch (error) {
      this.logCacheError("Redis del failed", error);
    }
  }

  async invalidateDashboard(): Promise<void> {
    await this.del(["system:stats", "model-config:public"]);
  }

  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const client = await this.getClient();
    if (!client) return this.incrementMemory(key, ttlSeconds);
    const redisKey = this.key(key);
    try {
      const count = await client.incr(redisKey);
      if (count === 1) {
        await client.expire(redisKey, ttlSeconds);
      }
      return count;
    } catch (error) {
      this.logCacheError("Redis incr failed", error);
      return this.incrementMemory(key, ttlSeconds);
    }
  }

  private key(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private getMemoryJson<T>(key: string): T | null {
    const cacheKey = this.key(key);
    const item = this.memory.get(cacheKey);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.memory.delete(cacheKey);
      return null;
    }
    return JSON.parse(item.value) as T;
  }

  private setMemoryJson(key: string, value: unknown, ttlSeconds: number): void {
    this.memory.set(this.key(key), {
      value: JSON.stringify(value),
      expiresAt: Date.now() + ttlSeconds * 1000
    });
  }

  private incrementMemory(key: string, ttlSeconds: number): number {
    const cacheKey = this.key(key);
    const now = Date.now();
    const item = this.memory.get(cacheKey);
    if (!item || item.expiresAt <= now) {
      this.memory.set(cacheKey, { value: "1", expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    const next = Number(item.value || "0") + 1;
    item.value = String(next);
    return next;
  }

  private async getClient(): Promise<RedisClientType | null> {
    if (!this.enabled) return null;
    if (!this.connected && this.nextRetryAt > Date.now()) return null;
    if (!this.client) {
      this.client = createClient({
        url: this.url,
        socket: {
          reconnectStrategy: false
        }
      });
      this.client.on("error", (error) => {
        this.connected = false;
        this.logCacheError("Redis client error", error);
      });
      this.client.on("ready", () => {
        this.connected = true;
      });
      this.client.on("end", () => {
        this.connected = false;
      });
    }

    if (!this.client.isOpen) {
      this.connectPromise ??= this.client.connect().then(
        () => {
          this.connected = true;
          this.connectPromise = undefined;
        },
        (error) => {
          this.connected = false;
          this.nextRetryAt = Date.now() + 30_000;
          this.connectPromise = undefined;
          this.logCacheError("Redis connect failed", error);
        }
      );
      await this.connectPromise;
    }

    return this.client.isReady ? this.client : null;
  }

  private logCacheError(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`${message}: ${detail}`);
  }
}

export const cache = new AppCache(
  appConfig.redis.enabled,
  appConfig.redis.url,
  appConfig.redis.keyPrefix,
  appConfig.redis.cacheTtlSeconds
);
