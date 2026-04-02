import app from "./app.js";

export default {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request);
  },
};
