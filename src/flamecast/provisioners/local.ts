import { getAgentTransport, startAgentProcess } from "../transport.js";
import type { SandboxProvisioner } from "../sandbox.js";

export const localProvisioner: SandboxProvisioner = {
  async start(opts) {
    const agentProcess = startAgentProcess(opts.spawn);
    const { input, output } = getAgentTransport(agentProcess);

    return {
      streams: { input, output },
      dispose: () => {
        agentProcess.kill();
      },
    };
  },
};
