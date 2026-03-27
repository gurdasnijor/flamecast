import { Hono } from "hono";
import { createApi, type FlamecastApi } from "./api.js";
import { createVendorAnalysisApi, type VendorAnalysisApi } from "./vendor-analysis/api.js";

export function createServerApp(flamecast: FlamecastApi & VendorAnalysisApi) {
  const app = new Hono();
  app.route("/api", createApi(flamecast));
  app.route("/api/vendor-analysis", createVendorAnalysisApi(flamecast));
  return app;
}
