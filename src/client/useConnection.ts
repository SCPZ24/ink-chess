import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  PublicConfig,
  ServerMessage,
  View,
} from "../core/protocol.js";
export function useConnection(
  config: PublicConfig | null,
  name: string,
  notify: (s: string) => void,
) {
  const [view, setView] = useState<View | null>(null),
    [status, setStatus] = useState("未连接"),
    [attempt, setAttempt] = useState(0),
    [pending, setPending] = useState(false);
  const socket = useRef<WebSocket | null>(null),
    notification = useRef(notify);
  notification.current = notify;
  useEffect(() => {
    if (!config || config.mode === "local" || !name) return;
    let active = true;
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    );
    socket.current = ws;
    setStatus("连接中");
    setView(null);
    setPending(false);
    ws.onopen = () => {
      if (active)
        ws.send(
          JSON.stringify({
            type: "hello",
            name,
            hostToken:
              new URLSearchParams(location.hash.slice(1)).get("host") ??
              undefined,
          }),
        );
    };
    ws.onmessage = (e) => {
      if (!active) return;
      const m: ServerMessage = JSON.parse(e.data);
      if (m.type === "welcome") setStatus("已连接");
      if (m.type === "state") {
        setView(m);
        setPending(false);
      }
      if (m.type === "error") {
        notification.current(m.message);
        setPending(false);
        if (m.fatal) setStatus("连接已结束");
      }
    };
    ws.onclose = () => {
      if (active) {
        setStatus("已断开");
        setPending(false);
      }
    };
    ws.onerror = () => {
      if (active) notification.current("无法连接，请确认服务正在运行。");
    };
    return () => {
      active = false;
      ws.close();
      if (socket.current === ws) socket.current = null;
    };
  }, [config, name, attempt]);
  const send = useCallback((message: ClientMessage) => {
    if (socket.current?.readyState !== WebSocket.OPEN) {
      notification.current("连接已断开，请重新进入。");
      return;
    }
    setPending(true);
    socket.current.send(JSON.stringify(message));
  }, []);
  return { view, status, pending, send, retry: () => setAttempt((a) => a + 1) };
}
