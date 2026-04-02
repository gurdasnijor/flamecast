/**
 * Flamecast — agent orchestration SDK.
 *
 * Mounts ACP routes that delegate to Restate AcpRun VOs + ACP Gateway.
 */

import { Hono } from "hono";
import { serve as honoServe } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { createAcpRoutes } from "./acp/routes.js";

export type FlamecastOptions = {
  /** Restate ingress URL (default: http://localhost:18080). */
  restateUrl?: string;
};

export class Flamecast {
  readonly restateUrl: string;
  readonly app: Hono;

  constructor(opts: FlamecastOptions = {}) {
    this.restateUrl = opts.restateUrl ?? "http://localhost:18080";
    this.app = new Hono();
    this.app.route(
      "/acp",
      createAcpRoutes({ restateUrl: this.restateUrl }),
    );
  }

  listen(
    port: number,
    callback?: (info: AddressInfo) => void,
  ): { close(): Promise<void> } {
    const server = honoServe({ fetch: this.app.fetch, port }, callback);
    return {
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }
}
