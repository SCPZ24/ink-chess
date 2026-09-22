import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalAction, LocalView } from "../core/local-protocol.js";
import type { Move } from "../core/types.js";
export function useLocalBoard(
  enabled: boolean,
  notify: (message: string) => void,
) {
  const [view, setView] = useState<LocalView | null>(null);
  const [connected, setConnected] = useState(false),
    [pending, setPending] = useState(false);
  const socket = useRef<WebSocket | null>(null),
    current = useRef(view),
    error = useRef(notify);
  current.current = view;
  error.current = notify;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/local-ws`,
    );
    socket.current = ws;
    ws.onopen = () => {
      if (active) setConnected(true);
    };
    ws.onmessage = (e) => {
      if (!active) return;
      const message = JSON.parse(e.data);
      if (message.type === "local-state") {
        current.current = message;
        setView(message);
      } else if (message.type === "error") error.current(message.message);
      setPending(false);
    };
    ws.onclose = () => {
      if (active) {
        setConnected(false);
        setPending(false);
        error.current("棋盘连接已结束，请刷新页面建立新棋局。");
      }
    };
    ws.onerror = () => {
      if (active) error.current("无法连接本地棋盘服务。");
    };
    return () => {
      active = false;
      ws.close();
    };
  }, [enabled]);
  const send = useCallback((type: LocalAction, move?: Move) => {
    const v = current.current,
      ws = socket.current;
    if (!v || ws?.readyState !== WebSocket.OPEN) {
      error.current("棋盘连接已断开");
      return;
    }
    setPending(true);
    ws.send(
      JSON.stringify({
        type,
        gameId: v.game.id,
        version: v.game.version,
        revision: v.revision,
        ...(move ? { move } : {}),
      }),
    );
  }, []);
  return { view, connected, pending, send };
}
