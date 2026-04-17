import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../lib/logger.js";
import { projectStore } from "./project-store.js";

export interface UserSession {
  projectId: string | null;
  model: string;
  lastPromptAt: number | null;
  activeChatId: string | null;
}

const STORE_PATH = join(process.cwd(), "session-store.json");
const STORE_TMP = `${STORE_PATH}.tmp`;
const DEFAULT_MODEL = "composer-1.5";

class SessionStore {
  private sessions = new Map<string, UserSession>();

  constructor() {
    this.load();
  }

  get(userId: string): UserSession {
    let session = this.sessions.get(userId);
    if (!session) {
      session = { projectId: null, model: DEFAULT_MODEL, lastPromptAt: null, activeChatId: null };
      this.sessions.set(userId, session);
    }
    if (session.activeChatId === undefined) {
      session.activeChatId = null;
    }
    if ((session as unknown as { projectId?: string | null }).projectId === undefined) {
      session.projectId = null;
    }
    return session;
  }

  setProjectId(userId: string, projectId: string): void {
    const session = this.get(userId);
    session.projectId = projectId;
    this.persist();
  }

  setModel(userId: string, model: string): void {
    const session = this.get(userId);
    session.model = model;
    this.persist();
  }

  setActiveChatId(userId: string, chatId: string | null): void {
    const session = this.get(userId);
    session.activeChatId = chatId;
    this.persist();
  }

  touchPrompt(userId: string): void {
    const session = this.get(userId);
    session.lastPromptAt = Date.now();
    this.persist();
  }

  private load(): void {
    if (!existsSync(STORE_PATH)) return;
    try {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const data = JSON.parse(raw) as Record<string, UserSession & { projectPath?: string | null }>;
      let migrated = false;
      for (const [k, v] of Object.entries(data)) {
        // Migration: legacy sessions stored `projectPath`; convert to stable `projectId`.
        if ((!v.projectId || v.projectId === null) && v.projectPath) {
          try {
            v.projectId = projectStore.getIdByPath(v.projectPath);
            migrated = true;
          } catch {
            v.projectId = null;
          }
        }
        this.sessions.set(k, v);
      }
      if (migrated) this.persist();
    } catch {
      logger.warn("Session store file corrupted — starting fresh");
    }
  }

  private persist(): void {
    const obj: Record<string, UserSession> = {};
    for (const [k, v] of this.sessions) {
      obj[k] = v;
    }
    try {
      writeFileSync(STORE_TMP, JSON.stringify(obj, null, 2));
      renameSync(STORE_TMP, STORE_PATH);
    } catch (err) {
      logger.error({ err }, "Failed to persist session store");
    }
  }
}

export const sessionStore = new SessionStore();
