/**
 * FlamecastClient — creates durable ACP connections backed by Restate.
 *
 * Usage:
 *   const fc = new FlamecastClient({ ingressUrl });
 *   const { connectionId, connection } = await fc.connect(
 *     "claude-acp",
 *     { cwd: ".", mcpServers: [] },
 *     (agent) => myClient,
 *   );
 *   await connection.initialize({...});
 *   const { sessionId } = await connection.newSession({...});
 *   await connection.prompt({ sessionId, prompt: [...] });
 *
 * The returned ClientSideConnection is standard ACP SDK — same interface
 * as connecting via stdio, WebSocket, or HTTP+SSE. The only difference
 * is the underlying stream is durable.
 */

import * as acp from "@agentclientprotocol/sdk";
import * as restateClients from "@restatedev/restate-sdk-clients";
import { createDurableStream } from "../durable-stream.js";
import type { AcpConnection as AcpConnectionDef, CreateInput } from "../connection.js";

const AcpConnection: typeof AcpConnectionDef = { name: "AcpConnection" } as never;

export interface FlamecastClientOptions {
  ingressUrl: string;
  headers?: Record<string, string>;
}

export class FlamecastClient {
  private readonly ingressUrl: string;
  private readonly headers?: Record<string, string>;
  private readonly ingress: restateClients.Ingress;

  constructor(opts: FlamecastClientOptions) {
    this.ingressUrl = opts.ingressUrl;
    this.headers = opts.headers;
    this.ingress = restateClients.connect({ url: opts.ingressUrl, headers: opts.headers });
  }

  /**
   * Create a new durable ACP connection.
   *
   * This spawns a downstream agent process and starts a bridge. It does
   * NOT send ACP initialize or session/new — the caller drives those
   * through the returned ClientSideConnection, same as any ACP transport.
   *
   * Returns { connectionId, connection } where connection is a standard
   * acp.ClientSideConnection ready for initialize/newSession/prompt.
   */
  async connect(
    agentName: string,
    opts: {
      cwd: string;
      mcpServers: acp.NewSessionRequest["mcpServers"];
      spawnConfig?: CreateInput["spawnConfig"];
      clientCapabilities?: acp.ClientCapabilities;
    },
    toClient: (agent: acp.Agent) => acp.Client,
  ): Promise<{ connectionId: string; connection: acp.ClientSideConnection }> {
    const connectionId = crypto.randomUUID();

    const vo = this.ingress.objectClient(AcpConnection, connectionId);
    await vo.create({
      agentName,
      spawnConfig: opts.spawnConfig ?? null,
      cwd: opts.cwd,
      mcpServers: opts.mcpServers,
      clientCapabilities: opts.clientCapabilities,
    } satisfies CreateInput as never);

    const stream = createDurableStream({
      connectionId,
      ingressUrl: this.ingressUrl,
      headers: this.headers,
    });

    return {
      connectionId,
      connection: new acp.ClientSideConnection(toClient, stream),
    };
  }

  /**
   * Attach to an existing durable connection by ID.
   *
   * Returns a new ClientSideConnection that receives live outbound messages
   * from this point forward. Does NOT replay historical messages — for that,
   * use getMessagesAfter on the VO directly.
   *
   * The caller must drive ACP lifecycle (initialize, newSession) again
   * if the downstream agent was re-spawned since the connection was created.
   */
  attach(
    connectionId: string,
    toClient: (agent: acp.Agent) => acp.Client,
  ): acp.ClientSideConnection {
    const stream = createDurableStream({
      connectionId,
      ingressUrl: this.ingressUrl,
      headers: this.headers,
    });

    return new acp.ClientSideConnection(toClient, stream);
  }
}
