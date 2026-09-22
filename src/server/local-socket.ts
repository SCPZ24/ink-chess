import { WebSocket } from "ws";
import type { LocalSessions } from "./local-sessions.js";
export function connectLocalSocket(ws: WebSocket, sessions: LocalSessions) {
  const view = sessions.create((state) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2_000_000) ws.close(1008, "slow consumer");
    else ws.send(JSON.stringify(state));
  });
  let lastPong = Date.now(),
    windowStart = Date.now(),
    count = 0;
  const heartbeat = setInterval(() => {
    if (Date.now() - lastPong > 30000) ws.terminate();
    else if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 10000);
  heartbeat.unref();
  ws.on("pong", () => {
    lastPong = Date.now();
  });
  ws.on("message", (data, binary) => {
    try {
      if (Date.now() - windowStart > 10000) {
        count = 0;
        windowStart = Date.now();
      }
      if (++count > 80) {
        ws.close(1008, "rate limit");
        return;
      }
      if (binary) throw Error("仅接受JSON文本消息");
      sessions.command(view.boardId, JSON.parse(data.toString()));
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({ type: "error", message: (error as Error).message }),
        );
    }
  });
  ws.on("close", () => {
    clearInterval(heartbeat);
    sessions.disconnect(view.boardId);
  });
  ws.on("error", () => ws.terminate());
}
