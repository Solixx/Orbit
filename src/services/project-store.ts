import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { logger } from "../lib/logger.js";
import { canonicalProjectPath, projectIdFromPath } from "../lib/project-id.js";

export interface ProjectRecord {
  id: string;
  path: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

const STORE_PATH = join(process.cwd(), "projects.json");
const STORE_TMP = `${STORE_PATH}.tmp`;

class ProjectStore {
  private projectsById = new Map<string, ProjectRecord>();
  private idByPath = new Map<string, string>();

  constructor() {
    this.load();
  }

  list(): ProjectRecord[] {
    return Array.from(this.projectsById.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getById(projectId: string): ProjectRecord | undefined {
    return this.projectsById.get(projectId);
  }

  getIdByPath(projectPath: string): string {
    const canonical = canonicalProjectPath(projectPath);
    const existing = this.idByPath.get(canonical);
    if (existing) return existing;
    return this.registerPath(projectPath).id;
  }

  registerPath(projectPath: string): ProjectRecord {
    const canonical = canonicalProjectPath(projectPath);
    const existingId = this.idByPath.get(canonical);
    if (existingId) {
      const existing = this.projectsById.get(existingId);
      if (existing) {
        existing.lastSeenAt = Date.now();
        this.persist();
        return existing;
      }
    }

    const id = projectIdFromPath(canonical);
    const now = Date.now();
    const record: ProjectRecord = {
      id,
      path: canonical,
      name: basename(canonical) || canonical,
      createdAt: now,
      lastSeenAt: now,
    };

    this.projectsById.set(id, record);
    this.idByPath.set(canonical, id);
    this.persist();
    return record;
  }

  touch(projectId: string): void {
    const p = this.projectsById.get(projectId);
    if (!p) return;
    p.lastSeenAt = Date.now();
    this.persist();
  }

  private load(): void {
    if (!existsSync(STORE_PATH)) return;
    try {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const list = JSON.parse(raw) as ProjectRecord[];
      for (const p of list) {
        if (!p?.id || !p?.path) continue;
        const canonical = canonicalProjectPath(p.path);
        const normalized: ProjectRecord = {
          id: p.id,
          path: canonical,
          name: p.name || basename(canonical) || canonical,
          createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
          lastSeenAt: typeof p.lastSeenAt === "number" ? p.lastSeenAt : Date.now(),
        };
        this.projectsById.set(normalized.id, normalized);
        this.idByPath.set(normalized.path, normalized.id);
      }
    } catch {
      logger.warn("Project store file corrupted — starting fresh");
    }
  }

  private persist(): void {
    try {
      const list = Array.from(this.projectsById.values());
      writeFileSync(STORE_TMP, JSON.stringify(list, null, 2));
      renameSync(STORE_TMP, STORE_PATH);
    } catch (err) {
      logger.error({ err }, "Failed to persist project store");
    }
  }
}

export const projectStore = new ProjectStore();
