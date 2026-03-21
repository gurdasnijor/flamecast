import { Container } from "@cloudflare/containers";

export class AgentContainer extends Container {
  defaultPort = 9100;
  sleepAfter = "5m";

  override get envVars() {
    return {
      ACP_PORT: String(this.defaultPort),
    };
  }
}
