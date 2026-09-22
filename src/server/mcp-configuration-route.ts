import type { IncomingMessage, ServerResponse } from "node:http";
import type { createMcpConfiguration } from "./mcp-config.js";
import { ConfigurationWriteError } from "./config-files.js";
import { localRequest } from "./chess-mcp.js";
export async function configurationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: ReturnType<typeof createMcpConfiguration>,
) {
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  if (
    !localRequest(req) ||
    req.headers["x-real-ip"] ||
    req.headers["x-forwarded-for"] ||
    req.headers.forwarded ||
    req.headers["sec-fetch-site"] === "cross-site"
  ) {
    reply(403, { error: "仅允许本机直接访问设置接口。" });
    return;
  }
  try {
    if (req.method === "GET") {
      reply(200, await service.read());
      return;
    }
    if (req.method !== "POST") {
      reply(405, { error: "仅支持 GET / POST" });
      return;
    }
    if (
      req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    ) {
      reply(415, { error: "请求必须使用 application/json" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024) {
        reply(413, { error: "请求过大" });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      reply(400, { error: "JSON 无效" });
      return;
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !["codex", "claude"].includes(body.agent)
    ) {
      reply(400, { error: "仅接受 agent: codex 或 claude" });
      return;
    }
    reply(200, await service.install(body.agent));
  } catch (error) {
    reply(409, {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof ConfigurationWriteError
        ? { files: error.files }
        : {}),
    });
  }
}
