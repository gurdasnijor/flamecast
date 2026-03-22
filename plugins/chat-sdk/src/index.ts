import {
  ChatSdkConnector,
  extractMessageText,
  type ChatSdkClient,
  type ChatSdkConnectorOptions,
  type ChatSdkMessage,
} from "./connector.js";
import {
  InMemoryThreadAgentBindingStore,
  type ChatSdkThread,
  type ThreadAgentBinding,
} from "./bindings.js";
import {
  FlamecastHttpClient,
  createConnectorMcpServer,
  type FlamecastAgent,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
  type FlamecastPromptResult,
  type FlamecastSpawn,
} from "./flamecast-client.js";

// Keep the barrel visible to V8 coverage so package-level coverage reporting stays honest.
const pluginEntrypoint = {
  ChatSdkConnector,
  InMemoryThreadAgentBindingStore,
  FlamecastHttpClient,
  createConnectorMcpServer,
  extractMessageText,
};
void pluginEntrypoint;

export {
  ChatSdkConnector,
  extractMessageText,
  FlamecastHttpClient,
  InMemoryThreadAgentBindingStore,
  createConnectorMcpServer,
  type ChatSdkClient,
  type ChatSdkConnectorOptions,
  type ChatSdkMessage,
  type ChatSdkThread,
  type FlamecastAgent,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
  type FlamecastPromptResult,
  type FlamecastSpawn,
  type ThreadAgentBinding,
};
