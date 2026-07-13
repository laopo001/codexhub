import path from "node:path";
import { ConnectionHandler } from "@theia/core/lib/common/messaging";
import { RpcConnectionHandler } from "@theia/core/lib/common/messaging/proxy-factory";
import { ContainerModule } from "@theia/core/shared/inversify";
import { codexHubBackendServicePath } from "../common/codexhub-protocol.js";
import { CodexHubTheiaBackendService } from "./codexhub-backend-service.js";

export default new ContainerModule((bind) => {
  bind(ConnectionHandler).toDynamicValue(() => new RpcConnectionHandler<Record<string, never>>(
    codexHubBackendServicePath,
    (client) => new CodexHubTheiaBackendService(
      client,
      path.resolve(__dirname, "../../dist"),
      path.resolve(__dirname, "../../dist-node/ssh/remote-client.cjs"),
    ),
  )).inSingletonScope();
});
