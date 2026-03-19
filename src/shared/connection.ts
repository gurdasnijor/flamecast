import { z } from "zod";

export const agentTypes = ["codex", "example"] as const;

export const AgentTypeSchema = z.enum(agentTypes);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const ConnectionLogSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type ConnectionLog = z.infer<typeof ConnectionLogSchema>;

export const PendingPermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.string(),
});
export type PendingPermissionOption = z.infer<typeof PendingPermissionOptionSchema>;

export const PendingPermissionSchema = z.object({
  requestId: z.string(),
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  options: z.array(PendingPermissionOptionSchema),
});
export type PendingPermission = z.infer<typeof PendingPermissionSchema>;

export const ConnectionInfoSchema = z.object({
  id: z.string(),
  agentType: AgentTypeSchema,
  sessionId: z.string(),
  startedAt: z.string(),
  lastUpdatedAt: z.string(),
  logs: z.array(ConnectionLogSchema),
  pendingPermission: PendingPermissionSchema.nullable(),
});
export type ConnectionInfo = z.infer<typeof ConnectionInfoSchema>;

export const CreateConnectionBodySchema = z.object({
  agent: AgentTypeSchema.optional(),
  cwd: z.string().optional(),
});
export type CreateConnectionBody = z.infer<typeof CreateConnectionBodySchema>;

export const PromptBodySchema = z.object({
  text: z.string(),
});
export type PromptBody = z.infer<typeof PromptBodySchema>;

export const PermissionResponseBodySchema = z.union([
  z.object({ optionId: z.string() }),
  z.object({ outcome: z.literal("cancelled") }),
]);
export type PermissionResponseBody = z.infer<typeof PermissionResponseBodySchema>;
