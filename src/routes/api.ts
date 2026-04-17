import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Request, Response } from "express";
import { Router } from "express";
import { ZodError, type ZodSchema } from "zod";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import {
  approvalsRequestSchema,
  approvalsResolveSchema,
  chatIdParamSchema,
  chatTitleSchema,
  devStartSchema,
  gitBranchSchema,
  gitCommitSchema,
  gitCreateBranchSchema,
  gitDeleteBranchSchema,
  gitFilesSchema,
  gitPushSchema,
  gitResetSchema,
  gitStashIndexSchema,
  gitStashSchema,
  setModelSchema,
  setProjectSchema,
  tunnelStartSchema,
} from "../lib/validation.js";
import { destructiveLimiter } from "../middleware/security.js";
import { chatStore } from "../services/chat-store.js";
import { cancelRun, createChat, isRunning } from "../services/cursor-runner.js";
import { getDevServer, startDevServer, stopDevServer } from "../services/dev-server.js";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCreateBranch,
  gitDeleteBranch,
  gitDiff,
  gitDiscard,
  gitDiscardAll,
  gitFetch,
  gitLog,
  gitMerge,
  gitMergeAbort,
  gitPush,
  gitReset,
  gitShowNewFile,
  gitStage,
  gitStash,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStatus,
  gitUnstage,
  type ResetMode,
} from "../services/git-runner.js";
import { projectStore } from "../services/project-store.js";
import { sessionStore } from "../services/session-store.js";
import { getTunnel, startTunnel, stopTunnel } from "../services/tunnel-manager.js";

const USER_ID = "local";
const startedAt = Date.now();

type ApprovalRecord = {
  id: string;
  action: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
  resolved: "approved" | "rejected" | null;
  token: string | null;
  used: boolean;
};

const approvalsById = new Map<string, ApprovalRecord>();
const approvalsByToken = new Map<string, ApprovalRecord>();
const APPROVAL_TTL_MS = 2 * 60_000;

function cleanupApprovals(now: number) {
  for (const [id, rec] of approvalsById) {
    if (rec.expiresAt <= now || rec.used) {
      approvalsById.delete(id);
      if (rec.token) approvalsByToken.delete(rec.token);
    }
  }
}

function getApprovalToken(req: Request): string | undefined {
  const header = req.header("x-approval-token") ?? undefined;
  const body = req.body as Record<string, unknown> | undefined;
  const bodyToken =
    typeof body?.["approvalToken"] === "string" ? (body["approvalToken"] as string) : undefined;
  return header ?? bodyToken;
}

function requireApproval(req: Request, res: Response, action: string): ApprovalRecord | null {
  cleanupApprovals(Date.now());
  const token = getApprovalToken(req);
  if (!token) {
    res.status(403).json({ error: "Approval required", action });
    return null;
  }
  const rec = approvalsByToken.get(token);
  if (!rec) {
    res.status(403).json({ error: "Invalid or expired approval token", action });
    return null;
  }
  if (rec.used) {
    res.status(403).json({ error: "Approval token already used", action });
    return null;
  }
  if (rec.expiresAt <= Date.now()) {
    res.status(403).json({ error: "Approval token expired", action });
    return null;
  }
  if (rec.resolved !== "approved") {
    res.status(403).json({ error: "Approval not granted", action });
    return null;
  }
  if (rec.action !== action) {
    res.status(403).json({ error: "Approval token does not match action", action });
    return null;
  }
  rec.used = true;
  approvalsById.delete(rec.id);
  if (rec.token) approvalsByToken.delete(rec.token);
  return rec;
}

const KNOWN_MODELS = [
  "composer-2",
  "composer-1.5",
  "opus-4.6-thinking",
  "opus-4.6",
  "opus-4.5-thinking",
  "opus-4.5",
  "sonnet-4.6-thinking",
  "sonnet-4.6",
  "sonnet-4.5-thinking",
  "sonnet-4.5",
  "gpt-5.3-codex-high-fast",
  "gpt-5.3-codex-high",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.1-high",
  "gemini-3.1-pro",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok",
  "kimi-k2.5",
];

function validate<T>(schema: ZodSchema<T>, data: unknown, res: Response): T | null {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const messages = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      res.status(400).json({ error: "Validation failed", details: messages });
    } else {
      res.status(400).json({ error: "Invalid request body" });
    }
    return null;
  }
}

function requireProjectPath(res: Response): string | null {
  const session = sessionStore.get(USER_ID);
  if (!session.projectId) {
    res.status(400).json({ error: "Set a project first" });
    return null;
  }
  const proj = projectStore.getById(session.projectId);
  if (!proj) {
    res.status(400).json({ error: "Selected project not found" });
    return null;
  }
  projectStore.touch(proj.id);
  return proj.path;
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const apiRouter = Router();

// ── Health ──────────────────────────────────────────────────────────────────
apiRouter.get("/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    },
    promptRunning: isRunning(USER_ID),
    devServer: getDevServer() !== null,
    tunnel: getTunnel() !== null,
  });
});

// ── Approvals (server-side gates) ───────────────────────────────────────────
apiRouter.post("/approvals/request", (req: Request, res: Response) => {
  const body = validate(approvalsRequestSchema, req.body, res);
  if (!body) return;
  const now = Date.now();
  cleanupApprovals(now);
  const id = randomUUID();
  const rec: ApprovalRecord = {
    id,
    action: body.action,
    summary: body.summary,
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    resolved: null,
    token: null,
    used: false,
  };
  approvalsById.set(id, rec);
  res.json({ approvalId: id, expiresAt: rec.expiresAt, action: rec.action, summary: rec.summary });
});

apiRouter.post("/approvals/resolve", (req: Request, res: Response) => {
  const body = validate(approvalsResolveSchema, req.body, res);
  if (!body) return;
  const rec = approvalsById.get(body.approvalId);
  if (!rec || rec.expiresAt <= Date.now()) {
    res.status(404).json({ error: "Approval request not found or expired" });
    return;
  }
  if (rec.resolved) {
    res.status(400).json({ error: "Approval request already resolved" });
    return;
  }
  if (body.decision === "reject") {
    rec.resolved = "rejected";
    approvalsById.delete(rec.id);
    res.json({ approved: false });
    return;
  }
  rec.resolved = "approved";
  rec.token = randomUUID();
  approvalsByToken.set(rec.token, rec);
  res.json({ approved: true, approvalToken: rec.token, expiresAt: rec.expiresAt });
});

// ── Status ──────────────────────────────────────────────────────────────────
apiRouter.get("/status", (_req, res) => {
  const session = sessionStore.get(USER_ID);
  const tunnel = getTunnel();
  const devServer = getDevServer();
  const project = session.projectId ? projectStore.getById(session.projectId) : undefined;

  res.json({
    // Backward compat: keep `project` as a path.
    project: project?.path ?? null,
    projectId: session.projectId,
    model: session.model,
    activeChatId: session.activeChatId,
    promptRunning: isRunning(USER_ID),
    devServer: devServer
      ? { command: devServer.command, cwd: devServer.cwd, port: devServer.port }
      : null,
    tunnel: tunnel ? { url: tunnel.url, port: tunnel.port } : null,
  });
});

// ── Projects ────────────────────────────────────────────────────────────────
apiRouter.get("/projects", (_req, res) => {
  const paths = listProjects();
  const projects = paths.map((p) => projectStore.registerPath(p));
  res.json({ projects });
});

apiRouter.post("/project", (req: Request, res: Response) => {
  const body = validate(setProjectSchema, req.body, res);
  if (!body) return;

  if (body.projectId) {
    const proj = projectStore.getById(body.projectId);
    if (!proj) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    sessionStore.setProjectId(USER_ID, proj.id);
    logger.info({ projectId: proj.id, project: proj.path }, "Project set");
    res.json({ project: proj.path, projectId: proj.id });
    return;
  }

  // Backward compat: accept raw path and register it.
  if (!body.path) {
    res.status(400).json({ error: "projectId or path is required" });
    return;
  }
  const projectPath = resolve(body.path.replace(/^~/, process.env["HOME"] ?? "~"));
  if (!existsSync(projectPath)) {
    res.status(404).json({ error: `Directory not found: ${projectPath}` });
    return;
  }
  const proj = projectStore.registerPath(projectPath);
  sessionStore.setProjectId(USER_ID, proj.id);
  logger.info({ projectId: proj.id, project: proj.path }, "Project set");
  res.json({ project: proj.path, projectId: proj.id });
});

// ── Models ──────────────────────────────────────────────────────────────────
apiRouter.get("/models", (_req, res) => {
  res.json({ models: KNOWN_MODELS });
});

apiRouter.post("/model", (req: Request, res: Response) => {
  const body = validate(setModelSchema, req.body, res);
  if (!body) return;

  sessionStore.setModel(USER_ID, body.name);
  res.json({ model: body.name });
});

// ── Dev server ──────────────────────────────────────────────────────────────
apiRouter.post("/dev/start", async (req: Request, res: Response) => {
  const body = validate(devStartSchema, req.body, res);
  if (!body) return;

  const projectPath = requireProjectPath(res);
  if (!projectPath) return;

  const { port, output } = await startDevServer(projectPath, body.command ?? "npm run dev");
  res.json({ port, output: output.slice(-500) });
});

apiRouter.post("/dev/stop", (_req, res) => {
  const stopped = stopDevServer();
  res.json({ stopped });
});

// ── Tunnel ──────────────────────────────────────────────────────────────────
apiRouter.post("/tunnel/start", async (req: Request, res: Response) => {
  const body = validate(tunnelStartSchema, req.body, res);
  if (!body) return;

  const devServer = getDevServer();

  if (!body.port && (!devServer || !devServer.port)) {
    const hint = devServer
      ? "Dev server is running but its port was not detected. Provide a port number."
      : "No dev server running and no port specified. Start the dev server first or provide a port number.";
    res.status(400).json({ error: hint });
    return;
  }

  const port = body.port ?? devServer!.port!;
  try {
    const url = await startTunnel(port);
    res.json({ url, port });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/tunnel/stop", async (_req, res) => {
  const stopped = await stopTunnel();
  res.json({ stopped });
});

// ── Prompt cancel ───────────────────────────────────────────────────────────
apiRouter.post("/prompt/cancel", (_req, res) => {
  const cancelled = cancelRun(USER_ID);
  res.json({ cancelled });
});

// ── File Browser ────────────────────────────────────────────────────────────
apiRouter.get("/files", (req, res) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;

  const relativePath = (req.query["path"] as string) || "";
  const targetDir = relativePath ? resolve(projectPath, relativePath) : projectPath;

  if (!targetDir.startsWith(projectPath)) {
    res.status(400).json({ error: "Path traversal not allowed" });
    return;
  }

  if (!existsSync(targetDir)) {
    res.status(404).json({ error: "Directory not found" });
    return;
  }

  try {
    const stat = statSync(targetDir);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: "Not a directory" });
      return;
    }

    const IGNORE = new Set([
      "node_modules",
      ".git",
      "dist",
      ".next",
      "__pycache__",
      ".cache",
      "coverage",
      ".DS_Store",
    ]);
    const entries = readdirSync(targetDir, { withFileTypes: true })
      .filter((e) => !IGNORE.has(e.name) && !e.name.startsWith("."))
      .slice(0, 200)
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? ("dir" as const) : ("file" as const),
        path: relativePath ? relativePath + "/" + e.name : e.name,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ path: relativePath, entries });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

// ── Prompt Templates ────────────────────────────────────────────────────────
apiRouter.get("/templates", (_req, res) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;

  const promptsDir = join(projectPath, ".cursor", "prompts");
  const templates: { name: string; content: string }[] = [];

  if (existsSync(promptsDir)) {
    try {
      const files = readdirSync(promptsDir).filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
      for (const file of files.slice(0, 20)) {
        try {
          const content = readFileSync(join(promptsDir, file), "utf-8").trim();
          const name = file.replace(/\.(md|txt)$/, "").replace(/[-_]/g, " ");
          templates.push({ name, content: content.slice(0, 2000) });
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // directory unreadable
    }
  }

  res.json({ templates });
});

// ── Chats ───────────────────────────────────────────────────────────────────
apiRouter.get("/chats", (req, res) => {
  const projectId = req.query["projectId"] as string | undefined;
  const legacyProjectPath = req.query["project"] as string | undefined;
  const resolvedProjectId = projectId
    ? projectId
    : legacyProjectPath
      ? projectStore.getIdByPath(legacyProjectPath)
      : undefined;
  res.json({ chats: chatStore.list(resolvedProjectId) });
});

apiRouter.post("/chats/new", async (_req: Request, res: Response) => {
  const session = sessionStore.get(USER_ID);
  if (!session.projectId) {
    res.status(400).json({ error: "Set a project first" });
    return;
  }
  const project = projectStore.getById(session.projectId);
  if (!project) {
    res.status(400).json({ error: "Selected project not found" });
    return;
  }

  try {
    const chatId = await createChat(project.path);
    const thread = chatStore.create(chatId, project.id, session.model, "");
    sessionStore.setActiveChatId(USER_ID, chatId);
    res.json(thread);
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/chats/:id/title", (req: Request, res: Response) => {
  const params = validate(chatIdParamSchema, req.params, res);
  if (!params) return;
  const body = validate(chatTitleSchema, req.body, res);
  if (!body) return;

  const thread = chatStore.update(params.id, { title: body.title });
  if (!thread) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }
  res.json(thread);
});

apiRouter.delete("/chats/:id", (req: Request, res: Response) => {
  const params = validate(chatIdParamSchema, req.params, res);
  if (!params) return;

  const deleted = chatStore.delete(params.id);
  if (!deleted) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }

  const session = sessionStore.get(USER_ID);
  if (session.activeChatId === params.id) {
    sessionStore.setActiveChatId(USER_ID, null);
  }
  res.json({ deleted: true });
});

apiRouter.post("/chats/:id/select", (req: Request, res: Response) => {
  const params = validate(chatIdParamSchema, req.params, res);
  if (!params) return;

  const thread = chatStore.get(params.id);
  if (!thread) {
    res.status(404).json({ error: "Chat not found" });
    return;
  }

  sessionStore.setActiveChatId(USER_ID, params.id);
  res.json({ chatId: params.id });
});

// ── Git ──────────────────────────────────────────────────────────────────────
apiRouter.get("/git/status", async (_req, res) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  try {
    const status = await gitStatus(projectPath);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.get("/git/diff", async (req, res) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  const file = req.query["file"] as string | undefined;
  const staged = req.query["staged"] === "1";
  const untracked = req.query["untracked"] === "1";
  try {
    let diff: string;
    if (untracked && file) {
      diff = await gitShowNewFile(projectPath, file);
    } else {
      diff = await gitDiff(projectPath, file, staged);
    }
    res.json({ diff });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/stage", async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  const body = validate(gitFilesSchema, req.body, res);
  if (!body) return;
  try {
    await gitStage(projectPath, body.files);
    res.json({ staged: true });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/unstage", async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  const body = validate(gitFilesSchema, req.body, res);
  if (!body) return;
  try {
    await gitUnstage(projectPath, body.files);
    res.json({ unstaged: true });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/commit", async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  const body = validate(gitCommitSchema, req.body, res);
  if (!body) return;
  try {
    const result = await gitCommit(projectPath, body.message.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.get("/git/branches", async (_req, res) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  try {
    const branches = await gitBranches(projectPath);
    res.json({ branches });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/checkout", async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  const body = validate(gitBranchSchema, req.body, res);
  if (!body) return;
  try {
    const output = await gitCheckout(projectPath, body.branch.trim());
    res.json({ branch: body.branch.trim(), output });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/branch/create", async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  const body = validate(gitCreateBranchSchema, req.body, res);
  if (!body) return;
  try {
    const output = await gitCreateBranch(projectPath, body.name.trim(), body.startPoint?.trim());
    res.json({ branch: body.name.trim(), output });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/merge", destructiveLimiter, async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  if (!requireApproval(req, res, "git.merge")) return;
  const body = validate(gitBranchSchema, req.body, res);
  if (!body) return;
  try {
    const result = await gitMerge(projectPath, body.branch.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/merge/abort", async (_req, res) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  try {
    await gitMergeAbort(projectPath);
    res.json({ aborted: true });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/discard", destructiveLimiter, async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  if (!requireApproval(req, res, "git.discard")) return;
  const body = validate(gitFilesSchema, req.body, res);
  if (!body) return;
  try {
    await gitDiscard(projectPath, body.files);
    res.json({ discarded: true });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/discard-all", destructiveLimiter, async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  if (!requireApproval(req, res, "git.discard_all")) return;
  try {
    await gitDiscardAll(projectPath);
    res.json({ discarded: true });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/reset", destructiveLimiter, async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  if (!requireApproval(req, res, "git.reset")) return;
  const body = validate(gitResetSchema, req.body, res);
  if (!body) return;
  try {
    const output = await gitReset(projectPath, body.mode as ResetMode, body.target);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/branch/delete", destructiveLimiter, async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  if (!requireApproval(req, res, "git.branch_delete")) return;
  const body = validate(gitDeleteBranchSchema, req.body, res);
  if (!body) return;
  try {
    const output = await gitDeleteBranch(projectPath, body.name.trim(), body.force === true);
    res.json({ deleted: true, output });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/stash", async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  const body = validate(gitStashSchema, req.body, res);
  if (!body) return;
  try {
    const output = await gitStash(projectPath, body.message);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/stash/pop", async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  const body = validate(gitStashIndexSchema, req.body, res);
  if (!body) return;
  try {
    const output = await gitStashPop(projectPath, body.index ?? 0);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.get("/git/stash/list", async (_req, res) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  try {
    const stashes = await gitStashList(projectPath);
    res.json({ stashes });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/stash/drop", destructiveLimiter, async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  if (!requireApproval(req, res, "git.stash_drop")) return;
  const body = validate(gitStashIndexSchema, req.body, res);
  if (!body) return;
  try {
    await gitStashDrop(projectPath, body.index ?? 0);
    res.json({ dropped: true });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.get("/git/log", async (req, res) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  const count = Math.min(parseInt(req.query["count"] as string, 10) || 20, 100);
  try {
    const commits = await gitLog(projectPath, count);
    res.json({ commits });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/push", destructiveLimiter, async (req: Request, res: Response) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  if (!requireApproval(req, res, "git.push")) return;
  const body = validate(gitPushSchema, req.body, res);
  if (!body) return;
  try {
    const result = await gitPush(projectPath, body.force === true);
    if (result.success) {
      res.json({ pushed: true, output: result.output });
    } else {
      res.status(500).json({ error: result.output });
    }
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

apiRouter.post("/git/fetch", async (_req, res) => {
  const projectPath = requireProjectPath(res);
  if (!projectPath) return;
  try {
    const output = await gitFetch(projectPath);
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: errorMsg(err) });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function listProjects(): string[] {
  if (!config.projectsDir) return [];
  try {
    return readdirSync(config.projectsDir)
      .map((name) => join(config.projectsDir, name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
