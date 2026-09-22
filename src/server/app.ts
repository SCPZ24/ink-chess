import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Lobby } from "./lobby.js";
import { resolveIdentity } from "./identity.js";
import { parseMessage, type ServerMessage } from "../core/protocol.js";
import type { Config } from "./config.js";
import { LocalSessions } from "./local-sessions.js";
import { createChessMcp, localRequest } from "./chess-mcp.js";
import { connectLocalSocket } from "./local-socket.js";
import { loopback } from "./identity.js";
export const VERSION = "0.1.0";
export function createGameServer(
  config: Config,
  webRoot = fileURLToPath(new URL("../web/", import.meta.url)),
) {
  if (config.mcp && (config.mode !== "local" || !loopback(config.host)))
    throw Error("MCP仅支持local模式和loopback监听地址");
  const localSessions = config.mcp ? new LocalSessions() : null;
  const mcp = localSessions ? createChessMcp(localSessions) : null;
  const hostToken = randomBytes(32).toString("base64url");
  const lobby = new Lobby(config.mode, hostToken);
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (mcp && req.url?.split("?")[0] === "/mcp") {
      try {
        await mcp.handle(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      }
      return;
    }
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (!["GET", "HEAD"].includes(req.method ?? "")) {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(
        new URL(req.url ?? "/", "http://ink.local").pathname,
      );
      if (pathname === "/api/config" || pathname === "/health") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(
          req.method === "HEAD"
            ? undefined
            : JSON.stringify(
                pathname === "/health"
                  ? { ok: true }
                  : { mode: config.mode, version: VERSION, mcp: !!config.mcp },
              ),
        );
        return;
      }
      const relative = pathname === "/" ? "/index.html" : pathname;
      if (
        !["/index.html", "/favicon.svg"].includes(relative) &&
        !relative.startsWith("/assets/") &&
        !relative.startsWith("/fonts/")
      ) {
        res.writeHead(404).end();
        return;
      }
      const file = resolve(webRoot, "." + relative);
      if (!file.startsWith(resolve(webRoot) + sep)) {
        res.writeHead(404).end();
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        res.writeHead(404).end();
        return;
      }
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".ttf": "font/ttf",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control":
          relative === "/index.html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
      });
      if (req.method === "HEAD") res.end();
      else
        createReadStream(file)
          .on("error", () => res.destroy())
          .pipe(res);
    } catch (error) {
      res
        .writeHead(
          (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400,
        )
        .end();
    }
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    if (localSessions && req.url === "/local-ws") {
      if (!localRequest(req)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        connectLocalSocket(ws, localSessions),
      );
      return;
    }
    if (config.mode === "local" || req.url !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host)
          throw new Error();
      } catch {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
    }
    let identity;
    try {
      identity = resolveIdentity(
        req.socket.remoteAddress ?? "",
        req.headers,
        config.trustedProxy,
      );
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let clientId: string | null = null,
        lastPong = Date.now(),
        windowStart = Date.now(),
        count = 0;
      const send = (m: ServerMessage) => {
        if (ws.readyState === WebSocket.OPEN) {
          if (ws.bufferedAmount > 2_000_000) ws.close(1008, "slow consumer");
          else ws.send(JSON.stringify(m));
        }
      };
      const timer = setTimeout(() => {
        if (!clientId) {
          send({ type: "error", message: "连接验证超时", fatal: true });
          ws.close(1008);
        }
      }, 5000);
      const heartbeat = setInterval(() => {
        if (Date.now() - lastPong > 30000) ws.terminate();
        else if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 10000);
      heartbeat.unref();
      timer.unref();
      ws.on("pong", () => {
        lastPong = Date.now();
      });
      ws.on("message", (data, isBinary) => {
        try {
          if (isBinary) throw new Error("仅接受 JSON 文本消息");
          if (Date.now() - windowStart > 10000) {
            count = 0;
            windowStart = Date.now();
          }
          if (++count > 80) {
            send({ type: "error", message: "操作过于频繁", fatal: true });
            ws.close(1008);
            return;
          }
          const message = parseMessage(JSON.parse(data.toString()));
          if (!clientId) {
            if (message.type !== "hello")
              throw new Error("请先设置昵称并验证连接");
            clientId = lobby.connect(
              identity,
              message.name,
              message.hostToken,
              send,
              () => ws.close(1000),
            );
            clearTimeout(timer);
          } else {
            if (message.type === "hello")
              throw new Error("此连接已经完成身份验证");
            lobby.command(clientId, message);
          }
        } catch (error) {
          send({
            type: "error",
            message: (error as Error).message,
            fatal: !clientId,
          });
          if (!clientId) ws.close(1008);
        }
      });
      ws.on("close", () => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        if (clientId) lobby.disconnect(clientId);
      });
      ws.on("error", () => ws.terminate());
    });
  });
  async function close() {
    localSessions?.shutdown();
    await mcp?.close();
    lobby.shutdown();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
    if (server.listening)
      await new Promise<void>((r, j) => {
        server.close((e) => (e ? j(e) : r()));
        server.closeAllConnections();
      });
  }
  return { server, lobby, hostToken, close };
}
