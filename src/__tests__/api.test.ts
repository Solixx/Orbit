import { createServer, type Server } from "node:http";
import express from "express";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../services/cursor-runner.js", () => ({
  isRunning: () => false,
  cancelRun: () => false,
  cancelAllRuns: () => {},
}));

vi.mock("../services/tunnel-manager.js", () => ({
  getTunnel: () => null,
  startTunnel: vi.fn().mockResolvedValue("https://test.ngrok.io"),
  stopTunnel: vi.fn().mockResolvedValue(true),
}));

vi.mock("../services/dev-server.js", () => ({
  getDevServer: () => null,
  startDevServer: vi.fn().mockResolvedValue({ port: 3000, output: "started" }),
  stopDevServer: () => true,
}));

vi.mock("../services/session-store.js", () => {
  const session: {
    projectId: string | null;
    model: string;
    lastPromptAt: number | null;
    activeChatId: string | null;
  } = {
    projectId: null,
    model: "opus-4.6",
    lastPromptAt: null,
    activeChatId: null,
  };
  return {
    sessionStore: {
      get: () => session,
      setProjectId: (_id: string, projectId: string) => {
        session.projectId = projectId;
      },
      setModel: (_id: string, model: string) => {
        session.model = model;
      },
      touchPrompt: () => {
        session.lastPromptAt = Date.now();
      },
      setActiveChatId: (_id: string, chatId: string | null) => {
        session.activeChatId = chatId;
      },
    },
  };
});

vi.mock("../services/project-store.js", () => ({
  projectStore: {
    list: () => [],
    touch: () => {},
    registerPath: (p: string) => ({
      id: "p_test",
      path: p,
      name: "test",
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
    getById: (_id: string) => null,
    getIdByPath: (_p: string) => "p_test",
  },
}));

vi.mock("../config.js", () => ({
  config: {
    port: 4000,
    host: "0.0.0.0",
    authToken: "",
    ngrok: { authtoken: "" },
    cursor: { apiKey: "" },
    projectsDir: "",
    promptTimeoutMs: 300000,
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  },
}));

let app: express.Express;
let server: Server;

beforeAll(async () => {
  const { apiRouter } = await import("../routes/api.js");
  app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", apiRouter);
  server = createServer(app);
});

afterAll(() => {
  server?.close();
});

describe("API Routes", () => {
  describe("GET /api/health", () => {
    it("returns health status", async () => {
      const res = await supertest(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body).toHaveProperty("uptime");
      expect(res.body).toHaveProperty("memory");
      expect(res.body).toHaveProperty("promptRunning");
    });
  });

  describe("GET /api/status", () => {
    it("returns current status", async () => {
      const res = await supertest(app).get("/api/status");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("project");
      expect(res.body).toHaveProperty("model");
      expect(res.body).toHaveProperty("promptRunning");
    });
  });

  describe("GET /api/models", () => {
    it("returns model list", async () => {
      const res = await supertest(app).get("/api/models");
      expect(res.status).toBe(200);
      expect(res.body.models).toBeInstanceOf(Array);
      expect(res.body.models.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/projects", () => {
    it("returns project list (empty when no PROJECTS_DIR)", async () => {
      const res = await supertest(app).get("/api/projects");
      expect(res.status).toBe(200);
      expect(res.body.projects).toBeInstanceOf(Array);
    });
  });

  describe("POST /api/model", () => {
    it("sets the model", async () => {
      const res = await supertest(app).post("/api/model").send({ name: "sonnet-4.6" });
      expect(res.status).toBe(200);
      expect(res.body.model).toBe("sonnet-4.6");
    });

    it("rejects empty name", async () => {
      const res = await supertest(app).post("/api/model").send({ name: "" });
      expect(res.status).toBe(400);
    });

    it("rejects missing name", async () => {
      const res = await supertest(app).post("/api/model").send({});
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/dev/stop", () => {
    it("stops the dev server", async () => {
      const res = await supertest(app).post("/api/dev/stop");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("stopped");
    });
  });

  describe("POST /api/tunnel/stop", () => {
    it("stops the tunnel", async () => {
      const res = await supertest(app).post("/api/tunnel/stop");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("stopped");
    });
  });

  describe("POST /api/prompt/cancel", () => {
    it("returns cancel status", async () => {
      const res = await supertest(app).post("/api/prompt/cancel");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("cancelled");
    });
  });

  describe("Validation on git endpoints", () => {
    it("POST /api/git/commit rejects empty message", async () => {
      const res = await supertest(app).post("/api/git/commit").send({ message: "" });
      expect(res.status).toBe(400);
    });

    it("POST /api/git/stage rejects missing files", async () => {
      const res = await supertest(app).post("/api/git/stage").send({});
      expect(res.status).toBe(400);
    });

    it("POST /api/git/reset rejects invalid mode", async () => {
      const res = await supertest(app).post("/api/git/reset").send({ mode: "invalid" });
      expect(res.status).toBe(400);
    });

    it("POST /api/git/branch/create rejects invalid branch name", async () => {
      const res = await supertest(app)
        .post("/api/git/branch/create")
        .send({ name: "bad branch name" });
      expect(res.status).toBe(400);
    });
  });
});
