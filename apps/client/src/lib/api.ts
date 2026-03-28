import { createFlamecastClient } from "@flamecast/sdk/client";

const client = createFlamecastClient({
  baseUrl: import.meta.env.VITE_API_URL || "https://flamecast-backend.smithery.workers.dev/api",
});

export const {
  createSession,
  fetchAgentTemplates,
  fetchRuntimeFilePreview,
  fetchRuntimeFileSystem,
  fetchRuntimes,
  fetchSessionFilePreview,
  fetchSessionFileSystem,
  fetchSession,
  fetchSessions,
  pauseRuntime,
  registerAgentTemplate,
  updateAgentTemplate,
  startRuntime,
  stopRuntime,
  terminateSession,
} = client;
