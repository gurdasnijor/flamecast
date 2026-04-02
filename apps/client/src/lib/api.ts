import { createFlamecastClient } from "@flamecast/sdk/client";

export function resolveApiBaseUrl(env: { VITE_API_URL?: string; DEV?: boolean }): string {
  if (env.VITE_API_URL) return env.VITE_API_URL;
  return env.DEV ? "" : "http://localhost:3001";
}

const client = createFlamecastClient({
  baseUrl: resolveApiBaseUrl(import.meta.env),
});

export const {
  fetchAgents,
  createSession,
  sendPrompt,
  fetchSession,
  cancelSession,
  resumeSession,
  fetchAgentTemplates,
  fetchSessions,
} = client;
