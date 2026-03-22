export type ChatSdkThread = {
  id: string;
  post(message: string): Promise<unknown>;
  startTyping?(): Promise<unknown>;
  subscribe?(): Promise<unknown>;
  unsubscribe?(): Promise<unknown>;
};

export type ThreadAgentBinding = {
  threadId: string;
  agentId: string;
  authToken: string;
  thread: ChatSdkThread;
};

export class InMemoryThreadAgentBindingStore {
  private readonly byThreadId = new Map<string, ThreadAgentBinding>();
  private readonly threadIdByAgentId = new Map<string, string>();
  private readonly threadIdByAuthToken = new Map<string, string>();

  getByThreadId(threadId: string): ThreadAgentBinding | null {
    return this.byThreadId.get(threadId) ?? null;
  }

  getByAgentId(agentId: string): ThreadAgentBinding | null {
    const threadId = this.threadIdByAgentId.get(agentId);
    return threadId ? (this.byThreadId.get(threadId) ?? null) : null;
  }

  getByAuthToken(authToken: string): ThreadAgentBinding | null {
    const threadId = this.threadIdByAuthToken.get(authToken);
    return threadId ? (this.byThreadId.get(threadId) ?? null) : null;
  }

  set(binding: ThreadAgentBinding): void {
    const existing = this.byThreadId.get(binding.threadId);
    if (existing) {
      this.threadIdByAgentId.delete(existing.agentId);
      this.threadIdByAuthToken.delete(existing.authToken);
    }

    this.byThreadId.set(binding.threadId, binding);
    this.threadIdByAgentId.set(binding.agentId, binding.threadId);
    this.threadIdByAuthToken.set(binding.authToken, binding.threadId);
  }

  deleteByThreadId(threadId: string): ThreadAgentBinding | null {
    const binding = this.byThreadId.get(threadId) ?? null;
    if (!binding) {
      return null;
    }

    this.byThreadId.delete(threadId);
    this.threadIdByAgentId.delete(binding.agentId);
    this.threadIdByAuthToken.delete(binding.authToken);
    return binding;
  }

  list(): ThreadAgentBinding[] {
    return [...this.byThreadId.values()];
  }

  clear(): void {
    this.byThreadId.clear();
    this.threadIdByAgentId.clear();
    this.threadIdByAuthToken.clear();
  }
}
