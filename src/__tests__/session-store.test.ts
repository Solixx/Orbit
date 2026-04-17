import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const STORE_PATH = join(process.cwd(), "session-store.json");
const STORE_TMP = `${STORE_PATH}.tmp`;
const PROJECTS_PATH = join(process.cwd(), "projects.json");
const PROJECTS_TMP = `${PROJECTS_PATH}.tmp`;

describe("SessionStore", () => {
  beforeEach(() => {
    for (const f of [STORE_PATH, STORE_TMP, PROJECTS_PATH, PROJECTS_TMP]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  afterEach(() => {
    for (const f of [STORE_PATH, STORE_TMP, PROJECTS_PATH, PROJECTS_TMP]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  it("returns default session for unknown user", async () => {
    const { sessionStore } = await import("../services/session-store.js");
    const session = sessionStore.get("test-user");
    expect(session.projectId).toBeNull();
    expect(session.model).toBe("composer-1.5");
    expect(session.lastPromptAt).toBeNull();
  });

  it("persists project selection", async () => {
    const { projectStore } = await import("../services/project-store.js");
    const { sessionStore } = await import("../services/session-store.js");
    const proj = projectStore.registerPath("/tmp/test-project");
    sessionStore.setProjectId("test-user", proj.id);
    const session = sessionStore.get("test-user");
    expect(session.projectId).toBe(proj.id);
    expect(existsSync(STORE_PATH)).toBe(true);
  });

  it("persists model selection", async () => {
    const { sessionStore } = await import("../services/session-store.js");
    sessionStore.setModel("test-user", "opus-4.6");
    const session = sessionStore.get("test-user");
    expect(session.model).toBe("opus-4.6");
  });

  it("updates lastPromptAt on touchPrompt", async () => {
    const { sessionStore } = await import("../services/session-store.js");
    sessionStore.touchPrompt("test-user");
    const session = sessionStore.get("test-user");
    expect(session.lastPromptAt).toBeTypeOf("number");
    expect(session.lastPromptAt!).toBeGreaterThan(0);
  });
});
