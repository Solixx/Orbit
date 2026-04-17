import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { validateWsToken } from "../middleware/auth.js";
import type { AcpPermissionDecision } from "../services/acp-runner.js";
import { runCursorAcp } from "../services/acp-runner.js";
import { chatStore } from "../services/chat-store.js";
import { createChat, isRunning, runCursor } from "../services/cursor-runner.js";
import { projectStore } from "../services/project-store.js";
import { sessionStore } from "../services/session-store.js";

const USER_ID = "local";
const HEARTBEAT_INTERVAL = 30_000;

let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

interface PromptMessage {
  type: "prompt";
  message: string;
  mode: "agent" | "ask" | "plan";
  chatId?: string;
}

interface NewChatMessage {
  type: "new-chat";
}

interface PermissionResponseMessage {
  type: "permission-response";
  requestId: string;
  decision: AcpPermissionDecision;
}

interface AskQuestionResponseMessage {
  type: "ask-question-response";
  requestId: string;
  outcome:
    | {
        outcome: "answered";
        answers: Array<{ questionId: string; selectedOptionIds: string[] }>;
      }
    | { outcome: "skipped"; reason?: string }
    | { outcome: "cancelled" };
}

interface PlanResponseMessage {
  type: "plan-response";
  requestId: string;
  outcome:
    | { outcome: "accepted"; planUri?: string }
    | { outcome: "rejected"; reason?: string }
    | { outcome: "cancelled" };
}

// Enriched pending entries that store the original payload for re-send on reconnect.
interface PendingPermissionEntry {
  resolve: (decision: AcpPermissionDecision) => void;
  payload: Record<string, unknown>;
  originWs: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingAskEntry {
  resolve: (outcome: AskQuestionResponseMessage["outcome"]) => void;
  payload: Record<string, unknown>;
  originWs: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingPlanEntry {
  resolve: (outcome: PlanResponseMessage["outcome"]) => void;
  payload: Record<string, unknown>;
  originWs: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

function isPromptMessage(data: unknown): data is PromptMessage {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown> & {
    type?: unknown;
    message?: unknown;
    mode?: unknown;
  };
  return (
    obj.type === "prompt" &&
    typeof obj.message === "string" &&
    (obj.mode === "agent" || obj.mode === "ask" || obj.mode === "plan")
  );
}

function isNewChatMessage(data: unknown): data is NewChatMessage {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown> & { type?: unknown };
  return obj.type === "new-chat";
}

function isPermissionResponseMessage(data: unknown): data is PermissionResponseMessage {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown> & {
    type?: unknown;
    requestId?: unknown;
    decision?: unknown;
  };
  return (
    obj.type === "permission-response" &&
    typeof obj.requestId === "string" &&
    (obj.decision === "allow-once" ||
      obj.decision === "allow-always" ||
      obj.decision === "reject-once")
  );
}

function isAskQuestionResponseMessage(data: unknown): data is AskQuestionResponseMessage {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown> & {
    type?: unknown;
    requestId?: unknown;
    outcome?: unknown;
  };
  return (
    obj.type === "ask-question-response" &&
    typeof obj.requestId === "string" &&
    obj.outcome !== null
  );
}

function isPlanResponseMessage(data: unknown): data is PlanResponseMessage {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown> & {
    type?: unknown;
    requestId?: unknown;
    outcome?: unknown;
  };
  return obj.type === "plan-response" && typeof obj.requestId === "string" && obj.outcome !== null;
}

export function attachWebSocket(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get("token") ?? undefined;

    if (!validateWsToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit("connection", ws, req);
    });
  });

  const pendingPermission = new Map<string, PendingPermissionEntry>();
  const pendingAsk = new Map<string, PendingAskEntry>();
  const pendingPlan = new Map<string, PendingPlanEntry>();

  let disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;

  function hasAnyLiveClient(): boolean {
    if (!wss) return false;
    for (const c of wss.clients) {
      if (c.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  function autoRejectAllPending(): void {
    for (const [id, entry] of pendingPermission) {
      logger.warn({ requestId: id }, "Auto-rejecting permission request (no client connected)");
      clearTimeout(entry.timer);
      pendingPermission.delete(id);
      entry.resolve("reject-once");
    }
    for (const [id, entry] of pendingAsk) {
      logger.warn({ requestId: id }, "Auto-cancelling ask-question (no client connected)");
      clearTimeout(entry.timer);
      pendingAsk.delete(id);
      entry.resolve({ outcome: "cancelled" });
    }
    for (const [id, entry] of pendingPlan) {
      logger.warn({ requestId: id }, "Auto-rejecting plan (no client connected)");
      clearTimeout(entry.timer);
      pendingPlan.delete(id);
      entry.resolve({ outcome: "cancelled" });
    }
  }

  function resendPendingRequests(ws: WebSocket): void {
    for (const [id, entry] of pendingPermission) {
      if (entry.originWs.readyState !== WebSocket.OPEN) {
        logger.info(
          { requestId: id },
          "Re-sending pending permission request to reconnected client",
        );
        entry.originWs = ws;
        send(ws, entry.payload);
      }
    }
    for (const [id, entry] of pendingAsk) {
      if (entry.originWs.readyState !== WebSocket.OPEN) {
        logger.info({ requestId: id }, "Re-sending pending ask-question to reconnected client");
        entry.originWs = ws;
        send(ws, entry.payload);
      }
    }
    for (const [id, entry] of pendingPlan) {
      if (entry.originWs.readyState !== WebSocket.OPEN) {
        logger.info({ requestId: id }, "Re-sending pending plan-request to reconnected client");
        entry.originWs = ws;
        send(ws, entry.payload);
      }
    }
  }

  wss.on("connection", (ws) => {
    (ws as WebSocket & { isAlive: boolean }).isAlive = true;
    logger.info({ clients: wss!.clients.size }, "WebSocket client connected");

    // Cancel any disconnect grace timer — a client is back.
    if (disconnectGraceTimer) {
      clearTimeout(disconnectGraceTimer);
      disconnectGraceTimer = null;
    }

    // Re-send any pending interactive requests whose original WS is dead.
    resendPendingRequests(ws);

    ws.on("pong", () => {
      (ws as WebSocket & { isAlive: boolean }).isAlive = true;
    });

    ws.on("close", () => {
      logger.info({ clients: wss!.clients.size - 1 }, "WebSocket client disconnected");

      const hasPending = pendingPermission.size > 0 || pendingAsk.size > 0 || pendingPlan.size > 0;

      if (hasPending && !hasAnyLiveClient()) {
        logger.warn(
          { graceMs: config.disconnectGraceMs },
          "All clients disconnected with pending interactive requests — starting grace timer",
        );
        if (disconnectGraceTimer) clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = setTimeout(() => {
          disconnectGraceTimer = null;
          if (!hasAnyLiveClient()) {
            autoRejectAllPending();
          }
        }, config.disconnectGraceMs);
      }
    });

    ws.on("message", (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        send(ws, { type: "error", message: "Invalid JSON" });
        return;
      }

      if (isPromptMessage(data)) {
        handlePrompt(ws, data, { pendingPermission, pendingAsk, pendingPlan });
      } else if (isNewChatMessage(data)) {
        handleNewChat(ws);
      } else if (isPermissionResponseMessage(data)) {
        const entry = pendingPermission.get(data.requestId);
        if (!entry) {
          send(ws, { type: "error", message: "Unknown or expired permission request." });
          return;
        }
        clearTimeout(entry.timer);
        pendingPermission.delete(data.requestId);
        entry.resolve(data.decision);
      } else if (isAskQuestionResponseMessage(data)) {
        const entry = pendingAsk.get(data.requestId);
        if (!entry) {
          send(ws, { type: "error", message: "Unknown or expired question request." });
          return;
        }
        clearTimeout(entry.timer);
        pendingAsk.delete(data.requestId);
        entry.resolve(data.outcome as AskQuestionResponseMessage["outcome"]);
      } else if (isPlanResponseMessage(data)) {
        const entry = pendingPlan.get(data.requestId);
        if (!entry) {
          send(ws, { type: "error", message: "Unknown or expired plan request." });
          return;
        }
        clearTimeout(entry.timer);
        pendingPlan.delete(data.requestId);
        entry.resolve(data.outcome as PlanResponseMessage["outcome"]);
      } else {
        send(ws, { type: "error", message: "Unknown message type" });
      }
    });
  });

  heartbeatTimer = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      const alive = ws as WebSocket & { isAlive: boolean };
      if (!alive.isAlive) {
        logger.debug("Terminating stale WebSocket connection");
        ws.terminate();
        continue;
      }
      alive.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);
}

export function shutdownWebSocket(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (wss) {
    for (const ws of wss.clients) {
      ws.close(1001, "Server shutting down");
    }
    wss.close();
    wss = null;
  }
}

async function handleNewChat(ws: WebSocket): Promise<void> {
  const session = sessionStore.get(USER_ID);

  if (!session.projectId) {
    send(ws, { type: "error", message: "Set a project first." });
    return;
  }
  const project = projectStore.getById(session.projectId);
  if (!project) {
    send(ws, { type: "error", message: "Selected project not found." });
    return;
  }

  try {
    const chatId = await createChat(project.path);
    sessionStore.setActiveChatId(USER_ID, chatId);
    chatStore.create(chatId, project.id, session.model, "");
    send(ws, { type: "chat-created", chatId });
    logger.info({ chatId }, "New chat created via WebSocket");
  } catch (err) {
    logger.error({ err }, "Failed to create chat");
    send(ws, { type: "error", message: "Failed to create new chat." });
  }
}

async function handlePrompt(
  ws: WebSocket,
  msg: PromptMessage,
  pending: {
    pendingPermission: Map<string, PendingPermissionEntry>;
    pendingAsk: Map<string, PendingAskEntry>;
    pendingPlan: Map<string, PendingPlanEntry>;
  },
): Promise<void> {
  const session = sessionStore.get(USER_ID);

  if (!session.projectId) {
    send(ws, { type: "error", message: "Set a project first." });
    return;
  }
  const project = projectStore.getById(session.projectId);
  if (!project) {
    send(ws, { type: "error", message: "Selected project not found." });
    return;
  }

  if (isRunning(USER_ID)) {
    send(ws, { type: "error", message: "A prompt is already running." });
    return;
  }

  const chatId = msg.chatId ?? session.activeChatId ?? undefined;

  if (!chatId) {
    try {
      const newChatId = await createChat(project.path);
      sessionStore.setActiveChatId(USER_ID, newChatId);
      chatStore.create(newChatId, project.id, session.model, msg.message);
      send(ws, { type: "chat-created", chatId: newChatId });
      await runPrompt(
        ws,
        {
          projectPath: project.path,
          projectId: project.id,
          projectName: project.name,
          model: session.model,
        },
        msg,
        newChatId,
        pending,
      );
    } catch (err) {
      logger.error({ err }, "Failed to create chat for prompt");
      send(ws, { type: "error", message: "Failed to create chat session." });
    }
    return;
  }

  const thread = chatStore.get(chatId);
  if (thread && thread.projectId !== project.id) {
    send(ws, { type: "error", message: "That chat belongs to a different project." });
    return;
  }

  if (chatId !== session.activeChatId) {
    sessionStore.setActiveChatId(USER_ID, chatId);
  }

  await runPrompt(
    ws,
    {
      projectPath: project.path,
      projectId: project.id,
      projectName: project.name,
      model: session.model,
    },
    msg,
    chatId,
    pending,
  );
}

async function runPrompt(
  ws: WebSocket,
  session: { projectPath: string; projectId: string; projectName: string; model: string },
  msg: PromptMessage,
  chatId: string,
  pending: {
    pendingPermission: Map<string, PendingPermissionEntry>;
    pendingAsk: Map<string, PendingAskEntry>;
    pendingPlan: Map<string, PendingPlanEntry>;
  },
): Promise<void> {
  send(ws, {
    type: "start",
    chatId,
    project: session.projectPath, // backward compat field name
    projectId: session.projectId,
    projectName: session.projectName,
    model: session.model,
    mode: msg.mode,
  });

  sessionStore.touchPrompt(USER_ID);
  chatStore.touch(chatId);

  let lastChunkAt = Date.now();
  let stallWarned = false;
  const stallTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Don't fire stall warnings while waiting for user input on interactive requests.
    const hasPendingInteractive =
      pending.pendingPermission.size > 0 ||
      pending.pendingAsk.size > 0 ||
      pending.pendingPlan.size > 0;
    if (hasPendingInteractive) {
      lastChunkAt = Date.now();
      if (stallWarned) {
        stallWarned = false;
        send(ws, { type: "llm-status", status: "waiting-for-input" });
      }
      return;
    }
    const idleMs = Date.now() - lastChunkAt;
    if (idleMs >= config.llmInactivityWarnMs) {
      if (!stallWarned || idleMs >= config.llmInactivityWarnMs + 15_000) {
        stallWarned = true;
        send(ws, {
          type: "llm-status",
          status: "stalled",
          idleMs,
          message:
            "No output received for a while. The LLM/agent may be stuck, rate-limited, or disconnected. You can wait or press Stop to cancel.",
        });
      }
    }
  }, 2_000);

  const useAcp = true;

  let result: { output: string; exitCode: number | null; timedOut: boolean } | undefined;
  if (useAcp) {
    try {
      result = await runCursorAcp(
        {
          prompt: msg.message,
          workspace: session.projectPath,
          model: session.model,
          mode: msg.mode,
          chatId,
        },
        {
          onChunk: (chunk) => {
            lastChunkAt = Date.now();
            if (stallWarned) {
              stallWarned = false;
              send(ws, { type: "llm-status", status: "running" });
            }
            if (ws.readyState === WebSocket.OPEN) {
              send(ws, { type: "chunk", data: chunk });
            }
          },
          onPermissionRequest: ({ requestId, title, detail, raw, options }) => {
            const payload: Record<string, unknown> = {
              type: "permission-request",
              requestId,
              title: title ?? "Permission required",
              detail: detail ?? "Agent requested permission to use a tool.",
              raw,
              options,
            };
            send(ws, payload);
            return new Promise<AcpPermissionDecision>((resolve) => {
              const timer = setTimeout(() => {
                if (pending.pendingPermission.has(requestId)) {
                  logger.warn({ requestId }, "Permission request timed out — auto-rejecting");
                  pending.pendingPermission.delete(requestId);
                  resolve("reject-once");
                }
              }, config.interactiveTimeoutMs);
              pending.pendingPermission.set(requestId, {
                resolve,
                payload,
                originWs: ws,
                timer,
              });
            });
          },
          onAskQuestion: ({ requestId, title, questions }) => {
            const payload: Record<string, unknown> = {
              type: "ask-question",
              requestId,
              title,
              questions,
            };
            send(ws, payload);
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                if (pending.pendingAsk.has(requestId)) {
                  logger.warn({ requestId }, "Ask-question request timed out — auto-cancelling");
                  pending.pendingAsk.delete(requestId);
                  resolve({ outcome: "cancelled" });
                }
              }, config.interactiveTimeoutMs);
              pending.pendingAsk.set(requestId, { resolve, payload, originWs: ws, timer });
            });
          },
          onCreatePlan: ({ requestId, name, overview, plan, todos }) => {
            const payload: Record<string, unknown> = {
              type: "plan-request",
              requestId,
              name,
              overview,
              planMarkdown: plan,
              todos,
            };
            send(ws, payload);
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                if (pending.pendingPlan.has(requestId)) {
                  logger.warn({ requestId }, "Plan request timed out — auto-cancelling");
                  pending.pendingPlan.delete(requestId);
                  resolve({ outcome: "cancelled" });
                }
              }, config.interactiveTimeoutMs);
              pending.pendingPlan.set(requestId, { resolve, payload, originWs: ws, timer });
            });
          },
        },
      );
    } catch (err) {
      logger.warn({ err }, "ACP run failed; falling back to print runner");
      send(ws, {
        type: "chunk",
        data: "\n[Orbit] ACP integration failed; falling back to legacy runner (no interactive questions, approvals, or plans).\n",
      });
    }
  }

  if (!result) {
    result = await runCursor(
      USER_ID,
      {
        prompt: msg.message,
        workspace: session.projectPath,
        model: session.model,
        mode: msg.mode,
        force: msg.mode === "agent",
        chatId,
      },
      (chunk) => {
        lastChunkAt = Date.now();
        if (stallWarned) {
          stallWarned = false;
          send(ws, { type: "llm-status", status: "running" });
        }
        if (ws.readyState === WebSocket.OPEN) {
          send(ws, { type: "chunk", data: chunk });
        }
      },
    );
  }

  clearInterval(stallTimer);

  if (result.output && result.exitCode !== 0) {
    send(ws, { type: "chunk", data: result.output });
  }

  send(ws, {
    type: "done",
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });
}

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}
