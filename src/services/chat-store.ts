import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../lib/logger.js";
import { projectStore } from "./project-store.js";

export interface ChatThread {
  id: string;
  projectId: string;
  projectPath?: string;
  model: string;
  title: string;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  preview: string;
}

const STORE_PATH = join(process.cwd(), "chats.json");
const STORE_TMP = `${STORE_PATH}.tmp`;
const MAX_CHATS = 200;

class ChatStore {
  private chats: ChatThread[] = [];

  constructor() {
    this.load();
  }

  list(projectId?: string): ChatThread[] {
    const filtered = projectId ? this.chats.filter((c) => c.projectId === projectId) : this.chats;
    return filtered.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  get(chatId: string): ChatThread | undefined {
    return this.chats.find((c) => c.id === chatId);
  }

  create(chatId: string, projectId: string, model: string, preview: string): ChatThread {
    const thread: ChatThread = {
      id: chatId,
      projectId,
      model,
      title: preview.slice(0, 60) || "New chat",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
      preview: preview.slice(0, 80),
    };
    this.chats.unshift(thread);
    this.prune();
    this.persist();
    return thread;
  }

  update(
    chatId: string,
    patch: Partial<Pick<ChatThread, "title" | "lastMessageAt" | "messageCount" | "preview">>,
  ): ChatThread | undefined {
    const thread = this.chats.find((c) => c.id === chatId);
    if (!thread) return undefined;
    Object.assign(thread, patch);
    this.persist();
    return thread;
  }

  touch(chatId: string): void {
    const thread = this.chats.find((c) => c.id === chatId);
    if (thread) {
      thread.lastMessageAt = Date.now();
      thread.messageCount++;
      this.persist();
    }
  }

  delete(chatId: string): boolean {
    const idx = this.chats.findIndex((c) => c.id === chatId);
    if (idx === -1) return false;
    this.chats.splice(idx, 1);
    this.persist();
    return true;
  }

  private prune(): void {
    if (this.chats.length > MAX_CHATS) {
      this.chats.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      this.chats = this.chats.slice(0, MAX_CHATS);
    }
  }

  private load(): void {
    if (!existsSync(STORE_PATH)) return;
    try {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const loaded = JSON.parse(raw) as Array<
        ChatThread & { projectPath?: string; projectId?: string }
      >;
      let migrated = false;
      this.chats = loaded
        .map((c) => {
          const chat: ChatThread = {
            ...c,
            projectId: c.projectId || "",
          };
          if (!chat.projectId && c.projectPath) {
            chat.projectId = projectStore.getIdByPath(c.projectPath);
            // Keep for a transition period (helps UI grouping during rollout / debugging).
            chat.projectPath = c.projectPath;
            migrated = true;
          }
          return chat;
        })
        .filter((c) => !!c.projectId);
      if (migrated) this.persist();
    } catch {
      logger.warn("Chat store file corrupted — starting fresh");
    }
  }

  private persist(): void {
    try {
      writeFileSync(STORE_TMP, JSON.stringify(this.chats, null, 2));
      renameSync(STORE_TMP, STORE_PATH);
    } catch (err) {
      logger.error({ err }, "Failed to persist chat store");
    }
  }
}

export const chatStore = new ChatStore();
