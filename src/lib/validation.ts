import { z } from "zod";

const safePath = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !p.includes("\0"), "Path must not contain null bytes");

export const setProjectSchema = z.object({
  projectId: z.string().min(1).max(100).optional(),
  // Backward compat (older clients)
  path: safePath.optional(),
});

export const setModelSchema = z.object({
  name: z.string().min(1).max(100),
});

export const devStartSchema = z.object({
  command: z.string().min(1).max(500).optional(),
});

export const tunnelStartSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
});

export const gitFilesSchema = z.object({
  files: z.array(safePath).min(1).max(500),
});

export const gitCommitSchema = z.object({
  message: z.string().min(1, "Commit message is required").max(5000),
});

export const gitBranchSchema = z.object({
  branch: z
    .string()
    .min(1)
    .max(250)
    .regex(/^[^\0 ~^:?*[\\]+$/, "Invalid branch name"),
});

export const gitCreateBranchSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(250)
    .regex(/^[^\0 ~^:?*[\\]+$/, "Invalid branch name"),
  startPoint: z.string().max(250).optional(),
});

export const gitDeleteBranchSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(250)
    .regex(/^[^\0 ~^:?*[\\]+$/, "Invalid branch name"),
  force: z.boolean().optional(),
});

export const gitResetSchema = z.object({
  mode: z.enum(["soft", "mixed", "hard"]),
  target: z.string().max(250).optional(),
});

export const gitStashSchema = z.object({
  message: z.string().max(500).optional(),
});

export const gitStashIndexSchema = z.object({
  index: z.number().int().min(0).max(999).optional(),
});

export const gitPushSchema = z.object({
  force: z.boolean().optional(),
});

export const approvalsRequestSchema = z.object({
  action: z.string().min(1).max(80),
  summary: z.string().min(1).max(400),
});

export const approvalsResolveSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
});

export const chatTitleSchema = z.object({
  title: z.string().min(1).max(200),
});

export const chatIdParamSchema = z.object({
  id: z.string().uuid(),
});
