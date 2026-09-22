import { it, expect, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { createGameServer } from "../src/server/app.js";
import type { ServerMessage } from "../src/core/protocol.js";
const apps: ReturnType<typeof createGameServer>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function app() {
  const a = createGameServer({
    mode: "lan",
    host: "127.0.0.1",
    port: 0,
    store: "/private/tmp",
    trustedProxy: ["127.0.0.1"],
  });
  apps.push(a);
  await new Promise<void>((r) => a.server.listen(0, "127.0.0.1", r));
  const addr = a.server.address();
  if (!addr || typeof addr === "string") throw new Error("address");
  return { a, url: `http://127.0.0.1:${addr.port}` };
}
function connect(
  url: string,
  hello: unknown,
  headers: Record<string, string> = {},
) {
  const ws = new WebSocket(url.replace("http", "ws") + "/ws", { headers });
  const messages: ServerMessage[] = [];
  const first = new Promise<ServerMessage>((resolve, reject) => {
    ws.once("error", reject);
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      messages.push(m);
      resolve(m);
    });
    ws.on("open", () => ws.send(JSON.stringify(hello)));
  });
  return { ws, messages, first };
}
it("serves public config without leaking host credentials or store and blocks non-GET", async () => {
  const { a, url } = await app();
  const conf = await (await fetch(url + "/api/config")).text();
  expect(JSON.parse(conf)).toMatchObject({ mode: "lan", version: "0.1.0" });
  expect(conf).not.toContain(a.hostToken);
  expect(conf).not.toContain("/private/tmp");
  expect((await fetch(url + "/api/config", { method: "POST" })).status).toBe(
    405,
  );
  expect((await fetch(url + "/ink-chess.settings.json")).status).toBe(404);
});
it("admits a real host and trusted-proxy guest, rejects a third socket and malformed moves", async () => {
  const { a, url } = await app();
  const h = connect(url, {
    type: "hello",
    name: "主人",
    hostToken: a.hostToken,
  });
  expect((await h.first).type).toBe("welcome");
  const g = connect(
    url,
    { type: "hello", name: "来客" },
    { "x-real-ip": "192.0.2.2" },
  );
  expect((await g.first).type).toBe("welcome");
  const third = connect(
    url,
    { type: "hello", name: "第三人" },
    { "x-real-ip": "192.0.2.3" },
  );
  expect(await third.first).toMatchObject({ type: "error", fatal: true });
  const error = new Promise<ServerMessage>((r) =>
    h.ws.once("message", (d) => r(JSON.parse(d.toString()))),
  );
  h.ws.send("{broken");
  expect(await error).toMatchObject({ type: "error" });
});
it("rejects a cross-origin websocket handshake", async () => {
  const { url } = await app();
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(url.replace("http", "ws") + "/ws", {
      origin: "https://evil.invalid",
    });
    ws.on("unexpected-response", (_r, res) => {
      res.resume();
      ws.terminate();
      resolve(res.statusCode!);
    });
    ws.on("error", () => {});
  });
  expect(status).toBe(403);
});

it("isolates 20 real WebSocket players across 10 server rooms", async () => {
  const a = createGameServer({
    mode: "server",
    host: "127.0.0.1",
    port: 0,
    store: "/private/tmp",
    trustedProxy: ["127.0.0.1"],
  });
  apps.push(a);
  await new Promise<void>((r) => a.server.listen(0, "127.0.0.1", r));
  const addr = a.server.address();
  if (!addr || typeof addr === "string") throw Error("address");
  const peers = Array.from({ length: 20 }, (_, i) =>
    connect(
      `http://127.0.0.1:${addr.port}`,
      { type: "hello", name: `玩家${i}` },
      { "x-real-ip": `192.0.2.${i + 1}` },
    ),
  );
  const waitState = async (i: number, predicate: (s: any) => boolean) => {
    for (let n = 0; n < 100; n++) {
      const state = peers[i].messages.findLast((m) => m.type === "state");
      if (state && predicate(state)) return state;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw Error("state timeout");
  };
  await Promise.all(peers.map((p) => p.first));
  for (let i = 0; i < 20; i += 2) {
    peers[i].ws.send(JSON.stringify({ type: "create" }));
    const state = await waitState(i, (s) => !!s.room);
    if (state.type !== "state") throw Error("state");
    peers[i + 1].ws.send(
      JSON.stringify({ type: "join", roomId: state.room!.id }),
    );
    await waitState(i, (s) => s.room?.members.length === 2);
  }
  const room = await waitState(0, (s) => s.room?.members.length === 2);
  if (room.type !== "state") throw Error("state");
  peers[0].ws.send(
    JSON.stringify({
      type: "move",
      gameId: room.room!.game.id,
      version: 0,
      move: { from: 54, to: 45 },
    }),
  );
  await waitState(1, (s) => s.room?.game.ply === 1);
  for (let i = 2; i < 20; i++)
    await waitState(i, (s) => s.room?.game.ply === 0);
  peers[2].ws.send(
    JSON.stringify({
      type: "move",
      gameId: room.room!.game.id,
      version: 0,
      move: { from: 54, to: 45 },
    }),
  );
  const response = await new Promise<ServerMessage>((r) =>
    peers[2].ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "error") r(m);
    }),
  );
  expect(response).toMatchObject({ type: "error", fatal: false });
  expect(peers[2].messages.findLast((m) => m.type === "state")).toMatchObject({
    room: { game: { ply: 0 } },
  });
});
it("stops even when a browser leaves a large font response unread", async () => {
  const { fileURLToPath } = await import("node:url");
  const a = createGameServer(
    {
      mode: "local",
      host: "127.0.0.1",
      port: 0,
      store: "/private/tmp",
      trustedProxy: [],
    },
    fileURLToPath(new URL("../dist/web/", import.meta.url)),
  );
  apps.push(a);
  await new Promise<void>((r) => a.server.listen(0, "127.0.0.1", r));
  const addr = a.server.address();
  if (!addr || typeof addr === "string") throw Error("address");
  const response = await fetch(
    `http://127.0.0.1:${addr.port}/fonts/MaShanZheng-Regular.ttf`,
  );
  const closing = a.close();
  const completed = await Promise.race([
    closing.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 300)),
  ]);
  await response.body?.cancel();
  await closing;
  expect(completed).toBe(true);
});
it("aborts a half-open guest after heartbeat expiry without dropping the responsive host", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  try {
    const { a, url } = await app();
    const h = connect(url, {
      type: "hello",
      name: "主人",
      hostToken: a.hostToken,
    });
    await h.first;
    const guest = new WebSocket(url.replace("http", "ws") + "/ws", {
      headers: { "x-real-ip": "192.0.2.88" },
      autoPong: false,
    });
    const admitted = new Promise<void>((resolve, reject) => {
      guest.once("error", reject);
      guest.on("message", (d) => {
        if (JSON.parse(d.toString()).type === "welcome") resolve();
      });
      guest.on("open", () =>
        guest.send(JSON.stringify({ type: "hello", name: "失联来客" })),
      );
    });
    await admitted;
    const closed = new Promise<void>((r) => guest.on("close", () => r()));
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(10000);
      await new Promise((r) => setTimeout(r, 10));
    }
    await closed;
    expect(h.messages.findLast((m) => m.type === "state")).toMatchObject({
      room: {
        game: { result: { reason: "aborted" } },
        members: [{ role: "host" }],
      },
    });
    expect(h.ws.readyState).toBe(WebSocket.OPEN);
    await a.close();
  } finally {
    vi.useRealTimers();
  }
});
