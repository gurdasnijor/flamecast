import { z } from "zod";
import type { PendingPermission, PendingPermissionOption } from "./session.js";

export const PendingPermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.string(),
}) satisfies z.ZodType<PendingPermissionOption>;

export const PendingPermissionSchema = z.object({
  requestId: z.string(),
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  options: z.array(PendingPermissionOptionSchema),
}) satisfies z.ZodType<PendingPermission>;
