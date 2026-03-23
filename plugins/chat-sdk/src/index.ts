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
  createFlamecastAgentClient,
  createConnectorMcpServer,
  type FlamecastAgent,
  type FlamecastAgentClient,
  type FlamecastCreateAgentBody,
  type FlamecastPromptResult,
  type FlamecastSpawn,
} from "./flamecast.js";

// Keep the barrel visible to V8 coverage so package-level coverage reporting stays honest.
const pluginEntrypoint = {
  ChatSdkConnector,
  InMemoryThreadAgentBindingStore,
  createFlamecastAgentClient,
  createConnectorMcpServer,
  extractMessageText,
};
void pluginEntrypoint;

export {
  ChatSdkConnector,
  extractMessageText,
  createFlamecastAgentClient,
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
