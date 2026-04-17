import express from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("auth middleware", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("allows requests when AUTH_TOKEN is not set", async () => {
    vi.doMock("../config.js", () => ({
      config: { authToken: "" },
    }));

    const { authMiddleware } = await import("../middleware/auth.js");
    const app = express();
    app.use(authMiddleware);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    const res = await supertest(app).get("/api/test");
    expect(res.status).toBe(200);
  });

  it("blocks /api requests without token when AUTH_TOKEN is set", async () => {
    vi.doMock("../config.js", () => ({
      config: { authToken: "secret123" },
    }));

    const { authMiddleware } = await import("../middleware/auth.js");
    const app = express();
    app.use(authMiddleware);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    const res = await supertest(app).get("/api/test");
    expect(res.status).toBe(401);
  });

  it("allows /api requests with correct Bearer token", async () => {
    vi.doMock("../config.js", () => ({
      config: { authToken: "secret123" },
    }));

    const { authMiddleware } = await import("../middleware/auth.js");
    const app = express();
    app.use(authMiddleware);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    const res = await supertest(app).get("/api/test").set("Authorization", "Bearer secret123");
    expect(res.status).toBe(200);
  });

  it("allows non-API routes without auth", async () => {
    vi.doMock("../config.js", () => ({
      config: { authToken: "secret123" },
    }));

    const { authMiddleware } = await import("../middleware/auth.js");
    const app = express();
    app.use(authMiddleware);
    app.get("/health", (_req, res) => res.json({ ok: true }));

    const res = await supertest(app).get("/health");
    expect(res.status).toBe(200);
  });

  describe("validateWsToken", () => {
    it("returns true when no AUTH_TOKEN is configured", async () => {
      vi.doMock("../config.js", () => ({
        config: { authToken: "" },
      }));

      const { validateWsToken } = await import("../middleware/auth.js");
      expect(validateWsToken(undefined)).toBe(true);
    });

    it("returns true with correct token", async () => {
      vi.doMock("../config.js", () => ({
        config: { authToken: "ws-secret" },
      }));

      const { validateWsToken } = await import("../middleware/auth.js");
      expect(validateWsToken("ws-secret")).toBe(true);
    });

    it("returns false with wrong token", async () => {
      vi.doMock("../config.js", () => ({
        config: { authToken: "ws-secret" },
      }));

      const { validateWsToken } = await import("../middleware/auth.js");
      expect(validateWsToken("wrong")).toBe(false);
    });
  });
});
