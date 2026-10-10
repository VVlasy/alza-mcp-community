#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./infra/logger.js";
import { buildServer, type BuildResult } from "./server.js";
import { toolsetPolicyFromEnv } from "./tools/toolsets.js";

const buildOpts = () => ({
  baseUrl: process.env.ALZA_BASE_URL,
  cdpUrl: process.env.ALZA_CDP_URL,
  toolsets: toolsetPolicyFromEnv(),
});

async function runStdio(): Promise<void> {
  const { server, close } = buildServer(buildOpts());
  const shutdown = async (signal: string) => {
    log.info(`alza-mcp shutting down on ${signal}`);
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  await server.connect(new StdioServerTransport());
  log.info("alza-mcp ready (stdio)", { baseUrl: process.env.ALZA_BASE_URL ?? "https://www.alza.cz" });
}

interface Session {
  transport: StreamableHTTPServerTransport;
  built: BuildResult;
  lastSeen: number;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function runHttp(): Promise<void> {
  const [host, portStr] = (process.env.MCP_HTTP_ADDR ?? "127.0.0.1:8000").split(":");
  const path = process.env.MCP_HTTP_PATH ?? "/mcp";
  const idleMs = Number(process.env.MCP_SESSION_IDLE_MS ?? 30 * 60_000);
  const sessions = new Map<string, Session>();

  const closeSession = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.built.close().catch(() => undefined);
  };

  // Clients often never send DELETE; reap idle sessions so each one's browser is released.
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > idleMs) void s.transport.close();
  }, 60_000);
  reaper.unref();

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      if (url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }
      const sid = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      const body = req.method === "POST" ? await readJson(req) : undefined;

      if (sessionId) {
        const s = sessions.get(sessionId);
        if (!s) return jsonError(res, 404, "Unknown or expired session");
        s.lastSeen = Date.now();
        await s.transport.handleRequest(req, res, body);
        return;
      }
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        return jsonError(res, 400, "Missing mcp-session-id (only initialize may omit it)");
      }

      const built = buildServer(buildOpts());
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, built, lastSeen: Date.now() });
          log.info("session opened", { id, active: sessions.size });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) void closeSession(transport.sessionId);
      };
      await built.server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error("http request failed", { error: (err as Error).message });
      if (!res.headersSent) jsonError(res, 500, "Internal error");
    }
  });

  const shutdown = async (signal: string) => {
    log.info(`alza-mcp shutting down on ${signal}`);
    http.close();
    await Promise.allSettled([...sessions.keys()].map(closeSession));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  http.listen(Number(portStr), host, () => log.info("alza-mcp ready (http)", { host, port: portStr, path }));
}

const transport = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
(transport === "http" ? runHttp() : runStdio()).catch((err) => {
  log.error("fatal", { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
