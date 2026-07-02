import fs from "node:fs";
import path from "node:path";
import { cache } from "./cache.js";
import { appConfig } from "./config.js";
import type {
  AnswerFeedback,
  AnswerReference,
  ChatMessage,
  ChatSession,
  DocumentChunk,
  IdCounters,
  KbMember,
  KnowledgeBase,
  KnowledgeDocument,
  PromptTemplate
} from "./models.js";

type UserIdKey = "knowledgeBase" | "kbMember" | "document" | "chunk" | "session" | "message" | "reference" | "prompt" | "feedback";

export interface UserPromptState {
  promptId: number;
  status: 0 | 1;
  active?: boolean;
  updatedAt: string;
}

export interface UserDatabase {
  meta: {
    ownerId: number;
    ids: Pick<IdCounters, UserIdKey>;
    createdAt: string;
    updatedAt: string;
  };
  knowledgeBases: KnowledgeBase[];
  kbMembers: KbMember[];
  documents: KnowledgeDocument[];
  chunks: DocumentChunk[];
  sessions: ChatSession[];
  messages: ChatMessage[];
  references: AnswerReference[];
  feedback: AnswerFeedback[];
  prompts: PromptTemplate[];
  promptStates: UserPromptState[];
}

function now(): string {
  return new Date().toISOString();
}

function idBase(userId: number): number {
  return 1_000_000_000 + userId * 1_000_000;
}

function emptyIds(userId: number): Pick<IdCounters, UserIdKey> {
  const base = idBase(userId);
  return {
    knowledgeBase: base + 1,
    kbMember: base + 1,
    document: base + 1,
    chunk: base + 1,
    session: base + 1,
    message: base + 1,
    reference: base + 1,
    prompt: base + 1,
    feedback: base + 1
  };
}

function createUserDatabase(userId: number): UserDatabase {
  const createdAt = now();
  return {
    meta: {
      ownerId: userId,
      ids: emptyIds(userId),
      createdAt,
      updatedAt: createdAt
    },
    knowledgeBases: [],
    kbMembers: [],
    documents: [],
    chunks: [],
    sessions: [],
    messages: [],
    references: [],
    feedback: [],
    prompts: [],
    promptStates: []
  };
}

export class UserScopedStore {
  constructor(
    private readonly filePath: string,
    private readonly userId: number,
    private db: UserDatabase
  ) {
    this.migrate();
  }

  get data(): UserDatabase {
    return this.db;
  }

  nextId(key: UserIdKey): number {
    const base = idBase(this.userId);
    const current = this.db.meta.ids[key] || base + 1;
    this.db.meta.ids[key] = current + 1;
    return current;
  }

  addMessage(message: Omit<ChatMessage, "id" | "createdAt">): ChatMessage {
    const createdAt = now();
    const record: ChatMessage = {
      id: this.nextId("message"),
      createdAt,
      ...message
    };
    this.db.messages.push(record);
    return record;
  }

  addSession(
    session: Omit<ChatSession, "id" | "createdAt" | "updatedAt" | "status" | "archivedAt"> &
      Partial<Pick<ChatSession, "status" | "archivedAt">>
  ): ChatSession {
    const createdAt = now();
    const record: ChatSession = {
      id: this.nextId("session"),
      createdAt,
      updatedAt: createdAt,
      status: "active",
      ...session
    };
    this.db.sessions.push(record);
    return record;
  }

  addChunks(chunks: DocumentChunk[]): DocumentChunk[] {
    const inserted = chunks.map((chunk) => ({
      ...chunk,
      id: this.nextId("chunk")
    }));
    this.db.chunks.push(...inserted);
    return inserted;
  }

  refreshKnowledgeBaseStats(kbId?: number): void {
    const targets = kbId
      ? this.db.knowledgeBases.filter((kb) => kb.id === kbId)
      : this.db.knowledgeBases;

    for (const kb of targets) {
      kb.documentCount = this.db.documents.filter((document) => document.kbId === kb.id).length;
      kb.chunkCount = this.db.chunks.filter((chunk) => chunk.kbId === kb.id).length;
      kb.updatedAt = now();
    }
  }

  save(): void {
    this.db.meta.updatedAt = now();
    void cache.invalidateDashboard();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.db, null, 2), "utf8");
  }

  private migrate(): void {
    this.db.meta.ids = { ...emptyIds(this.userId), ...this.db.meta.ids };
    this.db.kbMembers ??= [];
    this.db.documents ??= [];
    this.db.chunks ??= [];
    this.db.sessions ??= [];
    this.db.messages ??= [];
    this.db.references ??= [];
    this.db.feedback ??= [];
    this.db.prompts ??= [];
    this.db.promptStates ??= [];
    for (const kb of this.db.knowledgeBases) {
      kb.visibility = "PRIVATE";
      kb.ownerId = this.userId;
      kb.departmentId = undefined;
      kb.status ??= 1;
      kb.tags ??= [];
      kb.qaCount ??= this.db.sessions.filter((session) => session.kbId === kb.id).length;
    }
    for (const document of this.db.documents) {
      document.title ??= document.fileName;
      document.tags ??= [];
    }
    for (const session of this.db.sessions) {
      session.status = session.status === "archived" ? "archived" : "active";
      if (session.status === "active") delete session.archivedAt;
    }
    for (const prompt of this.db.prompts) {
      prompt.createdBy = this.userId;
      prompt.scene ??= "知识库问答";
      prompt.variables ??= ["context", "history", "question"];
      prompt.status ??= 1;
      if (prompt.status === 0) prompt.active = false;
    }
  }
}

export class UserDataStore {
  private readonly stores = new Map<number, UserScopedStore>();
  private readonly rootDir = path.join(path.dirname(appConfig.dataFile), "users");

  get(userId: number): UserScopedStore {
    const cached = this.stores.get(userId);
    if (cached) return cached;
    const filePath = this.databasePath(userId);
    const db = fs.existsSync(filePath)
      ? JSON.parse(fs.readFileSync(filePath, "utf8")) as UserDatabase
      : createUserDatabase(userId);
    const store = new UserScopedStore(filePath, userId, db);
    this.stores.set(userId, store);
    store.save();
    return store;
  }

  databasePath(userId: number): string {
    return path.join(this.rootDir, String(userId), "private.json");
  }

  existingUserIds(): number[] {
    if (!fs.existsSync(this.rootDir)) return [];
    return fs.readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => Number(entry.name))
      .filter((userId) => Number.isInteger(userId) && userId > 0 && fs.existsSync(this.databasePath(userId)));
  }

  uploadDir(userId: number): string {
    return path.join(appConfig.rootDir, "storage", "users", String(userId), "uploads");
  }
}

export const userDataStore = new UserDataStore();
