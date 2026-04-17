import { describe, expect, it } from "vitest";
import {
  gitBranchSchema,
  gitCommitSchema,
  gitCreateBranchSchema,
  gitFilesSchema,
  gitPushSchema,
  gitResetSchema,
  setModelSchema,
  setProjectSchema,
  tunnelStartSchema,
} from "../lib/validation.js";

describe("validation schemas", () => {
  describe("setProjectSchema", () => {
    it("accepts valid path", () => {
      expect(setProjectSchema.parse({ path: "/Users/test/project" })).toEqual({
        path: "/Users/test/project",
      });
    });

    it("accepts projectId", () => {
      expect(setProjectSchema.parse({ projectId: "p_0123456789abcdef" })).toEqual({
        projectId: "p_0123456789abcdef",
      });
    });

    it("rejects empty path", () => {
      expect(() => setProjectSchema.parse({ path: "" })).toThrow();
    });

    it("rejects null byte in path", () => {
      expect(() => setProjectSchema.parse({ path: "/test\0bad" })).toThrow();
    });

    it("accepts empty body (validated by route)", () => {
      expect(setProjectSchema.parse({})).toEqual({});
    });
  });

  describe("setModelSchema", () => {
    it("accepts valid model name", () => {
      expect(setModelSchema.parse({ name: "opus-4.6" })).toEqual({
        name: "opus-4.6",
      });
    });

    it("rejects empty name", () => {
      expect(() => setModelSchema.parse({ name: "" })).toThrow();
    });
  });

  describe("gitFilesSchema", () => {
    it("accepts array of file paths", () => {
      const result = gitFilesSchema.parse({ files: ["src/index.ts", "README.md"] });
      expect(result.files).toHaveLength(2);
    });

    it("rejects empty array", () => {
      expect(() => gitFilesSchema.parse({ files: [] })).toThrow();
    });

    it("rejects non-array", () => {
      expect(() => gitFilesSchema.parse({ files: "single-file" })).toThrow();
    });
  });

  describe("gitCommitSchema", () => {
    it("accepts valid commit message", () => {
      expect(gitCommitSchema.parse({ message: "fix: something" })).toEqual({
        message: "fix: something",
      });
    });

    it("rejects empty message", () => {
      expect(() => gitCommitSchema.parse({ message: "" })).toThrow();
    });
  });

  describe("gitBranchSchema", () => {
    it("accepts valid branch name", () => {
      expect(gitBranchSchema.parse({ branch: "feature/test" })).toEqual({
        branch: "feature/test",
      });
    });

    it("rejects branch name with spaces", () => {
      expect(() => gitBranchSchema.parse({ branch: "bad branch" })).toThrow();
    });
  });

  describe("gitCreateBranchSchema", () => {
    it("accepts name with optional startPoint", () => {
      expect(gitCreateBranchSchema.parse({ name: "feature/x", startPoint: "main" })).toEqual({
        name: "feature/x",
        startPoint: "main",
      });
    });

    it("accepts name without startPoint", () => {
      expect(gitCreateBranchSchema.parse({ name: "feature/x" })).toEqual({
        name: "feature/x",
      });
    });
  });

  describe("gitResetSchema", () => {
    it("accepts valid reset mode", () => {
      expect(gitResetSchema.parse({ mode: "soft" })).toEqual({ mode: "soft" });
      expect(gitResetSchema.parse({ mode: "mixed" })).toEqual({ mode: "mixed" });
      expect(gitResetSchema.parse({ mode: "hard" })).toEqual({ mode: "hard" });
    });

    it("rejects invalid mode", () => {
      expect(() => gitResetSchema.parse({ mode: "invalid" })).toThrow();
    });
  });

  describe("gitPushSchema", () => {
    it("accepts force flag", () => {
      expect(gitPushSchema.parse({ force: true })).toEqual({ force: true });
    });

    it("accepts empty body", () => {
      expect(gitPushSchema.parse({})).toEqual({});
    });
  });

  describe("tunnelStartSchema", () => {
    it("accepts valid port", () => {
      expect(tunnelStartSchema.parse({ port: 3000 })).toEqual({ port: 3000 });
    });

    it("rejects port out of range", () => {
      expect(() => tunnelStartSchema.parse({ port: 0 })).toThrow();
      expect(() => tunnelStartSchema.parse({ port: 70000 })).toThrow();
    });
  });
});
