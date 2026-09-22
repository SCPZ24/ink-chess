// Test-only control endpoint, mounted read-only into disposable containers.
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { createGameServer } from "../../dist/server/app.js";
const isHost = process.argv[2] === "host";
const app = isHost
  ? createGameServer({
      mode: "lan",
      port: 5678,
      host: "0.0.0.0",
      store: "/tmp",
      trustedProxy: ["127.0.0.1"],
    })
  : null;
if (app) await new Promise((r) => app.server.listen(5678, "0.0.0.0", r));
let socket,
  messages = [];
function connect(url, hostToken, headers) {
  messages = [];
  socket = new WebSocket(url, { headers });
  socket.on("open", () =>
    socket.send(
      JSON.stringify({
        type: "hello",
        name: isHost ? "本机" : "来客",
        hostToken,
      }),
    ),
  );
  socket.on("message", (d) => messages.push(JSON.parse(d.toString())));
  socket.on("error", (e) =>
    messages.push({ type: "transport-error", message: e.message }),
  );
}
if (isHost) connect("ws://127.0.0.1:5678/ws", app.hostToken);
createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const command = body ? JSON.parse(body) : { type: "status" };
  if (command.type === "connect")
    connect(command.url, command.token, command.headers);
  if (command.type === "host-connect")
    connect("ws://127.0.0.1:5678/ws", app.hostToken);
  if (command.type === "close") socket?.close();
  if (command.type === "send") socket.send(JSON.stringify(command.message));
  if (command.type === "current") {
    const state = messages.findLast((m) => m.type === "state");
    socket.send(
      JSON.stringify({
        ...command.message,
        gameId: state.room.game.id,
        version: state.room.game.version,
      }),
    );
  }
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      messages,
      state: messages.findLast((m) => m.type === "state"),
      connected: socket?.readyState === 1,
      token: isHost ? app.hostToken : undefined,
    }),
  );
}).listen(6001, "127.0.0.1");
