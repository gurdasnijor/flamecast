import { createFlamecastClient } from "@flamecast/sdk/client";

const DEFAULT_HOSTED_API_URL = "http://localhost:3001/api";

export function resolveApiBaseUrl(env: { VITE_API_URL?: string; DEV?: boolean }): string {
  if (env.VITE_API_URL) return env.VITE_API_URL;
  return env.DEV ? "" : DEFAULT_HOSTED_API_URL.replace(/\/api$/, "");
}

const client = createFlamecastClient({
  baseUrl: resolveApiBaseUrl(import.meta.env),
});

export const {
  createSession,
  fetchAgentTemplates,
  fetchSession,
  fetchSessions,
  registerAgentTemplate,
  updateAgentTemplate,
} = client;
