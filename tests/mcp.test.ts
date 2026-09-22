import { afterEach, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { WebSocket } from "ws";
import { createGameServer } from "../src/server/app.js";
import type { LocalView } from "../src/core/local-protocol.js";
import type { ChessEvent } from "../src/core/local-protocol.js";
import { request } from "node:http";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function start(mcp = true) {
  const app = createGameServer({
    mode: "local",
    host: mcp ? "127.0.0.1" : "0.0.0.0",
    port: 0,
    store: "/private/tmp",
    trustedProxy: [],
    mcp,
  });
  cleanup.push(() => app.close());
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { app, url };
}
async function connect(url: string) {
  const client = new Client({ name: "ink-chess-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + "/mcp")),
  );
  cleanup.push(() => client.close());
  return client;
}
async function board(url: string) {
  const ws = new WebSocket(url.replace("http", "ws") + "/local-ws");
  let view: LocalView;
  const states: LocalView[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === "local-state") {
      view = m;
      states.push(m);
    }
  });
  await new Promise<void>((r, j) => {
    ws.once("message", () => r());
    ws.once("error", j);
  });
  cleanup.push(async () => {
    ws.close();
  });
  return {
    ws,
    states,
    get view() {
      return view;
    },
    move(from: number, to: number) {
      ws.send(
        JSON.stringify({
          type: "move",
          gameId: view.game.id,
          version: view.game.version,
          revision: view.revision,
          move: { from, to },
        }),
      );
    },
  };
}
it("discovers only three non-read-only tools and hands a real browser move back without board data", async () => {
  const { url } = await start();
  const b = await board(url),
    client = await connect(url);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "enter_chess",
    "quit_chess",
    "wait_for_next_move",
  ]);
  expect(tools.every((t) => t.annotations?.readOnlyHint === false)).toBe(true);
  const entered = await client.callTool({
    name: "enter_chess",
    arguments: { board_id: b.view.boardId },
  });
  const s = entered.structuredContent as ChessEvent;
  await expect.poll(() => b.view.canMove).toBe(false);
  const waiting = client.callTool({
    name: "wait_for_next_move",
    arguments: { session_id: s.session_id, after_event_seq: 0 },
  });
  await expect.poll(() => b.view.ai?.phase).toBe("human");
  b.move(54, 45);
  const result = await waiting;
  expect(result.structuredContent).toMatchObject({
    status: "opponent_moved",
    notation: "兵九进一",
  });
  expect(JSON.stringify(result)).not.toMatch(/"(board|fen|from|to)"/);
  const replay = await client.callTool({
    name: "wait_for_next_move",
    arguments: { session_id: s.session_id, after_event_seq: 0 },
  });
  expect(replay.structuredContent).toEqual(result.structuredContent);
});
it("pauses browser permissions when a real HTTP tool request is cancelled", async () => {
  const { url } = await start();
  const b = await board(url),
    client = await connect(url);
  const s = (
    await client.callTool({
      name: "enter_chess",
      arguments: { board_id: b.view.boardId },
    })
  ).structuredContent as ChessEvent;
  const abort = new AbortController();
  const waiting = client
    .callTool(
      {
        name: "wait_for_next_move",
        arguments: { session_id: s.session_id, after_event_seq: 0 },
      },
      { signal: abort.signal },
    )
    .catch((e) => e);
  await expect.poll(() => b.view.ai?.phase).toBe("human");
  abort.abort();
  await waiting;
  await expect.poll(() => b.view.ai?.phase).toBe("paused");
  expect(b.view.canMove).toBe(false);
});
it("does not expose MCP for non-loopback listeners and rejects foreign origins and hosts", async () => {
  const disabled = await start(false);
  expect((await fetch(disabled.url + "/mcp")).status).toBe(404);
  const { url } = await start();
  for (const headers of [
    { Origin: "https://evil.invalid" },
    { Host: "evil.invalid" },
  ]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      request(url + "/mcp", { headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
        .on("error", reject)
        .end();
    });
    expect(status).toBe(403);
  }
});
it("pauses an outstanding wait when its HTTP client connection closes", async () => {
  const { url } = await start();
  const b = await board(url),
    client = await connect(url);
  const s = (
    await client.callTool({
      name: "enter_chess",
      arguments: { board_id: b.view.boardId },
    })
  ).structuredContent as ChessEvent;
  const waiting = client
    .callTool({
      name: "wait_for_next_move",
      arguments: { session_id: s.session_id, after_event_seq: 0 },
    })
    .catch((e) => e);
  await expect.poll(() => b.view.ai?.phase).toBe("human");
  await client.close();
  await waiting;
  await expect.poll(() => b.view.ai?.phase).toBe("paused");
  const second = await connect(url);
  const replay = await second.callTool({
    name: "wait_for_next_move",
    arguments: { session_id: s.session_id, after_event_seq: 0 },
  });
  expect(replay.structuredContent).toMatchObject({
    status: "paused",
    event_seq: 1,
  });
});
