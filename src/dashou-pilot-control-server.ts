import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import express, { type Express } from "express";
import { DashouPilotControlStore, registerPilotControlRoutes } from "./dashou-pilot-control.js";
import { dashouVersion } from "./dashou-capabilities.js";

export interface DashouPilotControlServerConfig {
  host: string;
  port: number;
  stateDir: string;
  adminToken: string;
  leasePrivateKeyPem: string;
  leaseTtlSeconds?: number;
}

export interface RunningDashouPilotControlServer {
  app: Express;
  config: DashouPilotControlServerConfig;
  listen(): Promise<HttpServer>;
  close(): Promise<void>;
}

export function createDashouPilotControlServer(
  config: DashouPilotControlServerConfig,
): RunningDashouPilotControlServer {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  const store = new DashouPilotControlStore(config.stateDir);

  app.get("/healthz", (_request, response) => {
    response.json({ ok: true, name: "dashou-pilot-control", version: dashouVersion() });
  });
  registerPilotControlRoutes(app, {
    store,
    adminToken: config.adminToken,
    leasePrivateKeyPem: config.leasePrivateKeyPem,
    leaseTtlSeconds: config.leaseTtlSeconds,
  });

  let httpServer: HttpServer | undefined;
  let closePromise: Promise<void> | undefined;
  return {
    app,
    config,
    listen: async () => {
      if (httpServer) return httpServer;
      httpServer = app.listen(config.port, config.host);
      await new Promise<void>((resolve, reject) => {
        httpServer?.once("listening", resolve);
        httpServer?.once("error", reject);
      });
      return httpServer;
    },
    close: async () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        if (!httpServer) {
          resolve();
          return;
        }
        httpServer.close((error) => error ? reject(error) : resolve());
      });
      await closePromise;
    },
  };
}

export async function listenDashouPilotControlServer(
  running: RunningDashouPilotControlServer,
): Promise<HttpServer> {
  return running.listen();
}
