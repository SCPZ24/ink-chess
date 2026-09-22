import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChessEvent } from "../core/local-protocol.js";
import type { LocalSessions } from "./local-sessions.js";
import { loopback } from "./identity.js";

export function localRequest(req: IncomingMessage): boolean {
  try {
    if (!loopback(req.socket.remoteAddress ?? "")) return false;
    const host = new URL(`http://${req.headers.host}`).hostname.replace(
      /^\[|\]$/g,
      "",
    );
    if (host !== "localhost" && !loopback(host)) return false;
    if (
      req.headers.origin &&
      new URL(req.headers.origin).host !== req.headers.host
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
export function createChessMcp(sessions: LocalSessions) {
  const requests = new AsyncLocalStorage<AbortSignal>();
  const connections = new Map<
    string,
    {
      transport: NodeStreamableHTTPServerTransport;
      server: McpServer;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const makeServer = () => {
    const server = new McpServer(
      { name: "ink-chess", version: "0.1.0" },
      {
        instructions:
          "在指定本地棋盘与人类对弈。通过 computer use/browser use 读取棋盘标识，调用 enter_chess；所有落子与提和回应必须通过棋盘界面。完成行动后调用 wait_for_next_move，使用返回的 event_seq 作为下一次 after_event_seq。等待会放行人类一着并静默挂起，正常结果含中文棋谱。paused 时可用新游标重试；game_over 后停止落子；退出调用 quit_chess。不要将等待和界面点击并发执行。",
      },
    );
    const annotations = {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    };
    const result = async (
      fn: () => ChessEvent | Promise<ChessEvent>,
    ): Promise<CallToolResult> => {
      try {
        const event = await fn();
        return {
          content: [{ type: "text", text: JSON.stringify(event) }],
          structuredContent: { ...event },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "操作失败",
            },
          ],
        };
      }
    };
    server.registerTool(
      "enter_chess",
      {
        description:
          "绑定界面显示的 board_id，进入AI对弈并锁定人类行棋。默认AI执黑。读取返回的session_id和event_seq。",
        inputSchema: z.object({
          board_id: z.string().uuid(),
          ai_side: z.enum(["red", "black"]).default("black"),
        }),
        annotations,
      },
      (args) => result(() => sessions.enter(args.board_id, args.ai_side)),
    );
    server.registerTool(
      "wait_for_next_move",
      {
        description:
          "完成自己的界面行动后调用。先注册等待，再开放人类行动；人类合法落子后返回中文棋谱。会改变行棋权限。最长等待1740秒；取消或超时暂停人类权限。",
        inputSchema: z.object({
          session_id: z.string().uuid(),
          after_event_seq: z.number().int().nonnegative(),
        }),
        annotations,
      },
      (args, ctx) =>
        result(() =>
          sessions.wait(
            args.session_id,
            args.after_event_seq,
            requests.getStore()
              ? AbortSignal.any([ctx.mcpReq.signal, requests.getStore()!])
              : ctx.mcpReq.signal,
          ),
        ),
    );
    server.registerTool(
      "quit_chess",
      {
        description: "退出AI对弈并取消等待，保留局面，恢复本地操作。",
        inputSchema: z.object({ session_id: z.string().uuid() }),
        annotations: { ...annotations, idempotentHint: true },
      },
      (args) => result(() => sessions.quit(args.session_id)),
    );
    return server;
  };
  return {
    async handle(req: IncomingMessage, res: ServerResponse) {
      if (!localRequest(req)) {
        res.writeHead(403).end();
        return;
      }
      let body: unknown;
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16384) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400).end();
          return;
        }
      }
      const id = req.headers["mcp-session-id"];
      let connection = typeof id === "string" ? connections.get(id) : undefined;
      if (!connection) {
        if (id) {
          res.writeHead(404).end();
          return;
        }
        if (
          req.method !== "POST" ||
          (body as { method?: string })?.method !== "initialize"
        ) {
          res.writeHead(400).end();
          return;
        }
        if (connections.size >= 100) {
          res.writeHead(503).end();
          return;
        }
        const server = makeServer();
        const connectionId = randomUUID();
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => connectionId,
        });
        await server.connect(transport);
        const timer = setTimeout(() => {
          void server.close();
        }, 1800_000);
        timer.unref();
        connection = { server, transport, timer };
        connections.set(connectionId, connection);
        const previousClose = transport.onclose;
        transport.onclose = () => {
          previousClose?.();
          clearTimeout(timer);
          connections.delete(connectionId);
        };
      }
      connection.timer.refresh();
      const abort = new AbortController();
      const disconnected = () => {
        if (!res.writableFinished) abort.abort();
      };
      res.once("close", disconnected);
      await requests.run(abort.signal, () =>
        connection!.transport.handleRequest(req, res, body),
      );
    },
    async close() {
      await Promise.all(
        [...connections.values()].map((c) => {
          clearTimeout(c.timer);
          return c.server.close();
        }),
      );
      connections.clear();
    },
  };
}
