/**
 * Bridge — pipe two ACP streams together without terminating the protocol.
 *
 * Composes an accept function (server-side) with a connect function (client-side).
 * Each accepted connection spawns a fresh outbound and pipes bidirectionally.
 *
 * Usage:
 *   bridge(
 *     (h) => acceptWs({ port: 9200 }, h),
 *     () => fromStdio({ cmd: "npx", args: ["claude-acp"] }),
 *   )
 */

import type * as acp from "@agentclientprotocol/sdk";

export function bridge<S>(
  accept: (handler: (stream: acp.Stream) => void) => S,
  connect: () => acp.Stream | Promise<acp.Stream>,
): S {
  return accept(async (inbound) => {
    const outbound = await connect();
    inbound.readable.pipeTo(outbound.writable).catch(() => {});
    outbound.readable.pipeTo(inbound.writable).catch(() => {});
  });
}
