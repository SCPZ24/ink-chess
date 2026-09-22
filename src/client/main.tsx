import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  initialGame,
  applyMove,
  legalMoves,
  inCheck,
  resign,
  offerDraw,
  respondDraw,
  other,
  names,
  tacticNames,
  outcomeNames,
  type GameState,
  type Side,
  type Tactic,
} from "../core/game.js";
import type { PublicConfig, ClientMessage } from "../core/protocol.js";
import { useLocalBoard } from "./useLocalBoard.js";
import type { LocalAction } from "../core/local-protocol.js";
import { Board } from "./Board.js";
import { useConnection } from "./useConnection.js";
import {
  readPreferences,
  savePreferences,
  unlockAudio,
  playMove,
} from "./preferences.js";
import "./style.css";
const sideName = (side: Side) => (side === "red" ? "红方" : "黑方");
function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null),
    [error, setError] = useState("");
  const [preferences, setPreferences] = useState(readPreferences),
    [name, setName] = useState(preferences.name),
    [draftName, setDraftName] = useState(preferences.name);
  const [local, setLocal] = useState(initialGame),
    [selected, setSelected] = useState<number | null>(null),
    [flip, setFlip] = useState(false),
    [settings, setSettings] = useState(false),
    [confirmation, setConfirmation] = useState(false);
  const connection = useConnection(config, name, setError),
    isLocal = config?.mode === "local";
  const mcpLocal = !!config?.mcp;
  const localBoard = useLocalBoard(mcpLocal, setError);
  const permitted = (type: LocalAction) =>
    !mcpLocal ||
    (localBoard.connected &&
      !localBoard.pending &&
      !!localBoard.view?.allowedActions.includes(type));
  const room = connection.view?.room,
    game =
      localBoard.view?.game ?? room?.game ?? connection.view?.lastGame ?? local,
    ownSide = room?.side ?? game.turn;
  const flipped = isLocal ? flip : (ownSide === "black") !== flip;
  const playable =
    !!config &&
    ((isLocal && (!mcpLocal || (localBoard.connected && !!localBoard.view))) ||
      (!!room &&
        room.members.length === 2 &&
        connection.status === "已连接")) &&
    !game.result &&
    !connection.pending &&
    !localBoard.pending;
  const canMove =
    playable &&
    (isLocal || game.turn === ownSide) &&
    (!mcpLocal || !!localBoard.view?.canMove);
  const targets = useMemo(
    () =>
      selected !== null && canMove
        ? legalMoves(game, selected).map((m) => m.to)
        : [],
    [game, selected, canMove],
  );
  const [effect, setEffect] = useState<{
      tactics: Tactic[];
      mate: boolean;
      id: string;
    } | null>(null),
    seen = useRef(""),
    recordsScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fetch("/api/config")
      .then((r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then(setConfig)
      .catch(() => setError("无法读取运行配置，请重新启动服务。"));
  }, []);
  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);
  useEffect(() => {
    setSelected(null);
    setConfirmation(false);
  }, [game.id, game.version, localBoard.view?.revision]);
  useEffect(() => {
    const rec = game.history.at(-1),
      key = `${game.id}:${game.ply}`;
    if (seen.current === key) return;
    seen.current = key;
    setEffect(null);
    if (!rec) return;
    if (preferences.sound) playMove(!!rec.captured);
    if (
      preferences.effects &&
      (rec.tactics.length || game.result?.reason === "checkmate")
    )
      setEffect({
        tactics: rec.tactics,
        mate: game.result?.reason === "checkmate",
        id: key,
      });
  }, [
    game.id,
    game.ply,
    game.history,
    game.result,
    preferences.effects,
    preferences.sound,
  ]);
  // A resize event also covers rapid rotations whose final list size is unchanged.
  // Scroll the notation viewport only; never move the document or the board.
  useEffect(() => {
    const list = recordsScroll.current;
    if (!list) return;
    const scrollToLatest = () => {
      list.scrollTop = list.scrollHeight;
    };
    scrollToLatest();
    window.addEventListener("resize", scrollToLatest);
    return () => window.removeEventListener("resize", scrollToLatest);
  }, [game.id, game.ply]);
  useEffect(() => {
    if (!effect) return;
    const timer = setTimeout(() => setEffect(null), effect.mate ? 1400 : 900);
    return () => clearTimeout(timer);
  }, [effect]);
  const attempt = (fn: () => void) => {
    setError("");
    try {
      fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    }
  };
  const action = (
    type: "resign" | "offer-draw" | "accept-draw" | "decline-draw" | "rematch",
  ) =>
    attempt(() => {
      if (mcpLocal) {
        localBoard.send(type);
        return;
      }
      if (!isLocal) {
        connection.send({ type, gameId: game.id, version: game.version });
        return;
      }
      if (type === "resign") setLocal(resign(game, game.turn));
      if (type === "offer-draw") setLocal(offerDraw(game, game.turn));
      if (type === "accept-draw" || type === "decline-draw")
        setLocal(
          respondDraw(game, other(game.drawOffer!), type === "accept-draw"),
        );
      if (type === "rematch") setLocal(initialGame());
    });
  function choose(square: number) {
    unlockAudio();
    if (!canMove) return;
    if (selected === square) {
      setSelected(null);
      return;
    }
    if (game.board[square]?.side === game.turn) {
      setSelected(square);
      return;
    }
    if (selected === null) return;
    if (!targets.includes(square)) {
      setError("此处不能落子；请留意蹩马腿、炮架与将帅安全。");
      return;
    }
    attempt(() => {
      const move = { from: selected, to: square };
      if (mcpLocal) localBoard.send("move", move);
      else if (isLocal) setLocal(applyMove(game, move));
      else
        connection.send({
          type: "move",
          gameId: game.id,
          version: game.version,
          move,
        });
      setSelected(null);
    });
  }
  const message = (m: ClientMessage) => attempt(() => connection.send(m));
  const enter = () => {
    if (!draftName.trim() || Array.from(draftName.trim()).length > 16) {
      setError("请输入1至16个字符的昵称");
      return;
    }
    setPreferences({ ...preferences, name: draftName.trim() });
    setName(draftName.trim());
    setError("");
  };
  const resultText = game.result
    ? game.result.winner
      ? `${sideName(game.result.winner)}获胜`
      : game.result.reason === "aborted"
        ? "对局中止"
        : "和棋"
    : "";
  const lobby = config?.mode === "server" && !room;
  const connected = isLocal
    ? !mcpLocal || localBoard.connected
    : connection.status === "已连接";
  const boardDetails = mcpLocal && localBoard.view && (
    <div className="board-details">
      <span className="label">棋盘标识</span>
      <code data-testid="board-id">{localBoard.view.boardId}</code>
      <small>同一棋盘按执色交接，请勿代点 AI 的棋子。</small>
      <small>停止 Agent 后，请在主界面退出 AI 对弈。</small>
    </div>
  );
  return (
    <div
      className={`app ${preferences.reduced ? "reduced-motion" : ""}`}
      onPointerDown={unlockAudio}
    >
      <header className="masthead">
        <div className="brand">
          <span className="seal">棋</span>
          <span>
            <h1>水墨象棋</h1>
            <small>INK CHESS · 一枰山水，落子有声</small>
          </span>
        </div>
        <div className="top-actions">
          <span className="mode-tag">
            {config
              ? { local: "同席对弈", lan: "局域雅集", server: "四海棋会" }[
                  config.mode
                ]
              : "载入中"}
          </span>
          <button
            className="icon-button"
            onClick={() => setSettings(true)}
            aria-label="偏好设置"
          >
            ⚙
          </button>
        </div>
      </header>
      <main className="layout">
        <aside className="info-panel panel">
          <div className="eyebrow">
            THE MATCH <span>对弈</span>
          </div>
          <div className="match-intro">
            <span className="vertical-mark">落子无悔</span>
            <h2>
              {lobby ? "以棋会友" : "方寸之间"}
              <br />
              <em>{lobby ? "静候知音" : "自有乾坤"}</em>
            </h2>
          </div>
          <div className="players">
            {(["black", "red"] as Side[]).map((side) => (
              <div
                key={side}
                className={`player-card ${side} ${game.turn === side && !game.result ? "active" : ""}`}
              >
                <span className="avatar">{side === "red" ? "帅" : "将"}</span>
                <div>
                  <strong>
                    {isLocal
                      ? `${sideName(side)}棋手${localBoard.view?.ai?.side === side ? " · AI" : ""}`
                      : (room?.members.find((m) => m.side === side)?.name ??
                        "静候入席")}
                  </strong>
                  <small>
                    {sideName(side)}
                    {!isLocal && room?.side === side ? " · 你" : ""}
                  </small>
                </div>
                <i className="turn-dot" />
              </div>
            ))}
          </div>
          <div className="match-status" aria-live="polite">
            <span>
              第 <b>{Math.floor(game.ply / 2) + 1}</b> 回合
            </span>
            <span
              className={
                inCheck(game, game.turn) && !game.result ? "check-status" : ""
              }
            >
              {game.result
                ? `${resultText} · ${outcomeNames[game.result.reason]}`
                : room?.members.length === 1
                  ? "等待对手"
                  : inCheck(game, game.turn)
                    ? `${sideName(game.turn)}被将军`
                    : `${sideName(game.turn)}行棋`}
            </span>
          </div>
          <div className="capture-section">
            <span className="label">已离棋枰</span>
            <div>
              {game.history.some((h) => h.captured) ? (
                game.history
                  .filter((h) => h.captured)
                  .map((h, i) => (
                    <span key={i} className={`captured ${h.captured!.side}`}>
                      {names[h.captured!.side][h.captured!.kind]}
                    </span>
                  ))
              ) : (
                <span className="muted">尚无吃子</span>
              )}
            </div>
          </div>
          <div className="match-actions">
            <button
              disabled={!playable || !permitted("resign")}
              onClick={() => setConfirmation(true)}
            >
              认输
            </button>
            <button
              disabled={
                !playable ||
                !permitted("offer-draw") ||
                game.ply < 50 ||
                !!game.drawOffer ||
                (!isLocal && ownSide !== game.turn)
              }
              onClick={() => action("offer-draw")}
              title="前25回合不能提和"
            >
              提和
            </button>
            <button className="wide" onClick={() => setFlip((v) => !v)}>
              ⇄　翻转棋盘
            </button>
          </div>
          {mcpLocal && localBoard.view && (
            <div
              className={`ai-session ${localBoard.view.ai ? "ai-active" : ""}`}
              aria-live="polite"
            >
              <div className="desktop-only">{boardDetails}</div>
              {localBoard.view.ai && (
                <>
                  <strong data-testid="ai-phase">
                    {
                      {
                        ai: "AI 行棋",
                        human: "轮到你了",
                        handoff: "等待 AI 交接",
                        paused: "交接已暂停",
                        finished: "对局结束",
                      }[localBoard.view.ai.phase]
                    }
                  </strong>
                  <button
                    disabled={!localBoard.connected || localBoard.pending}
                    onClick={() => localBoard.send("quit-ai")}
                  >
                    退出 AI 对弈
                  </button>
                </>
              )}
            </div>
          )}
          <div
            className={`connection-note ${connected ? "healthy" : ""}`}
            role="status"
          >
            <span className={`connection-dot ${connected ? "online" : ""}`} />
            {isLocal
              ? mcpLocal
                ? localBoard.connected
                  ? "本地棋盘 · MCP 已启用"
                  : "棋盘连接已断开"
                : "本地棋局 · 双方轮流操作"
              : connection.status}
            {!isLocal && connection.status === "已断开" && (
              <button onClick={connection.retry}>重新进入</button>
            )}
          </div>
          {!isLocal && room && (
            <button
              className="text-button"
              onClick={() => message({ type: "leave" })}
            >
              离开对局
            </button>
          )}
          <p className="quiet-note">
            不限时 · 不悔棋
            <br />
            每一步，都值得从容
          </p>
        </aside>
        <section className="board-column">
          <div className="board-caption">
            <span>楚汉相争</span>
            <span>
              {isLocal
                ? "红先黑后"
                : room
                  ? `执${ownSide === "red" ? "红" : "黑"} · ${connection.view?.role === "host" ? "本机" : connection.view?.role === "guest" ? "来客" : "棋手"}`
                  : "一局一会"}
            </span>
          </div>
          <div className="board-well">
            <div className="board-stage">
              <Board
                game={game}
                flipped={flipped}
                selected={selected}
                targets={targets}
                choose={choose}
                enabled={canMove}
              />
              {effect && preferences.effects && (
                <div
                  key={effect.id}
                  className={`tactic-effect ${effect.tactics[0] ?? "finish"} ${effect.mate ? "mate" : ""}`}
                  data-testid="tactic"
                  aria-live="polite"
                >
                  <div className="ink-ring" />
                  <div className="ink-ring second" />
                  <span className="effect-stamp">
                    {effect.mate ? "绝杀" : "成招"}
                  </span>
                  <strong>
                    {effect.tactics[0]
                      ? tacticNames[effect.tactics[0]]
                      : "一着定乾坤"}
                  </strong>
                  <small>
                    {effect.tactics
                      .slice(1)
                      .map((t) => tacticNames[t])
                      .join(" · ")}
                    {effect.mate ? `　${resultText}` : ""}
                  </small>
                </div>
              )}
              {game.result && (
                <div className="result-card" data-testid="result">
                  <span className="result-seal">终局</span>
                  <h2>{resultText}</h2>
                  <p>{outcomeNames[game.result.reason]}</p>
                  {(isLocal ||
                    (room?.members.length === 2 &&
                      game.result.reason !== "aborted")) && (
                    <button
                      className="primary"
                      disabled={
                        (mcpLocal && !permitted("rematch")) ||
                        (!isLocal &&
                          (connection.pending ||
                            room?.rematchReady ||
                            connection.status !== "已连接"))
                      }
                      onClick={() => action("rematch")}
                    >
                      {room?.rematchReady ? "等待对方同意" : "再来一局"}
                    </button>
                  )}
                  {!isLocal &&
                    connection.view?.role === "host" &&
                    room?.members.length === 1 &&
                    !room.accepting && (
                      <button
                        className="primary"
                        onClick={() => message({ type: "open-lan" })}
                      >
                        接待新对手
                      </button>
                    )}
                </div>
              )}
              {config && !isLocal && !name && (
                <div className="entry-card">
                  <span className="eyebrow">入席留名</span>
                  <h2>棋逢知己</h2>
                  <p>留一个雅号，开始你的棋局。</p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      enter();
                    }}
                  >
                    <input
                      autoFocus
                      aria-label="昵称"
                      placeholder="你的昵称"
                      maxLength={24}
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                    />
                    <button className="primary">入席</button>
                  </form>
                </div>
              )}
              {lobby && name && connection.status === "已连接" && (
                <div className="lobby-card">
                  <span className="eyebrow">四海棋会</span>
                  <h2>寻一位对手</h2>
                  <button
                    className="primary"
                    disabled={connection.pending}
                    onClick={() => message({ type: "create" })}
                  >
                    创建房间
                  </button>
                  <div className="room-list">
                    {connection.view?.rooms.length ? (
                      connection.view.rooms.map((r) => (
                        <div className="room-row" key={r.id}>
                          <span>
                            {r.name}
                            <small>
                              {r.players}/2 ·{" "}
                              {r.status === "waiting"
                                ? "等待来客"
                                : r.status === "playing"
                                  ? "对弈中"
                                  : "已终局"}
                            </small>
                          </span>
                          <button
                            disabled={
                              r.status !== "waiting" || connection.pending
                            }
                            onClick={() =>
                              message({ type: "join", roomId: r.id })
                            }
                          >
                            加入
                          </button>
                        </div>
                      ))
                    ) : (
                      <p>尚无棋局。开一桌，静候来客。</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="board-foot">
            <span>
              {selected === null
                ? "点选棋子，再点落处"
                : "绿色标记为合法落点 · 再点棋子取消"}
            </span>
            <span>水墨 · 象棋</span>
          </div>
          <div className="board-notices" aria-live="polite">
            {game.warning && (
              <p className="notice">
                {game.warning.side ? sideName(game.warning.side) : "双方"}：
                {game.warning.reason}（剩余{" "}
                {game.warning.side === null
                  ? Math.ceil(game.warning.remaining / 2)
                  : game.warning.remaining}{" "}
                回合）
              </p>
            )}
            {game.notice && <p className="notice">{game.notice}</p>}
            {game.drawOffer && (
              <div className="draw-offer">
                {sideName(game.drawOffer)}提出和棋
                {(isLocal || ownSide !== game.drawOffer) && (
                  <>
                    <button
                      disabled={!permitted("accept-draw")}
                      onClick={() => action("accept-draw")}
                    >
                      同意和棋
                    </button>
                    <button
                      disabled={!permitted("decline-draw")}
                      onClick={() => action("decline-draw")}
                    >
                      继续对弈
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </section>
        <aside className="records-panel panel">
          <div className="eyebrow">
            THE MOVES <span>棋谱</span>
          </div>
          <div className="records-title">
            <h2>落子成章</h2>
            <span>{game.ply} 着</span>
          </div>
          <div className="record-head">
            <span>回合</span>
            <span>红方</span>
            <span>黑方</span>
          </div>
          <div className="records-scroll" ref={recordsScroll}>
            {game.history.length ? (
              Array.from(
                { length: Math.ceil(game.history.length / 2) },
                (_, round) => (
                  <div className="record-row" key={round}>
                    <span className="round-number">
                      {String(round + 1).padStart(2, "0")}
                    </span>
                    {[round * 2, round * 2 + 1].map((i) => (
                      <div
                        key={i}
                        className={`move-chunk ${game.history[i]?.side ?? ""} ${i === game.ply - 1 ? "latest" : ""}`}
                        data-testid={`move-${i}`}
                      >
                        {game.history[i]?.notation ?? "—"}
                        {game.history[i]?.check && <sup>将</sup>}
                      </div>
                    ))}
                  </div>
                ),
              )
            ) : (
              <div className="empty-record">
                <span>谱</span>
                <p>棋枰已备，静候首着</p>
                <small>一招一式，皆成文章</small>
              </div>
            )}
          </div>
          <div className="records-footer">
            <span>●</span> 棋谱仅在本次对局保留
          </div>
        </aside>
      </main>
      <footer className="page-footer">
        <span>观棋不语真君子 · 落子无悔大丈夫</span>
        <span>INK CHESS / 水墨象棋</span>
      </footer>
      {error && (
        <div className="toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="关闭提示">
            ×
          </button>
          {!isLocal && connection.status === "已断开" && (
            <button
              onClick={() => {
                setError("");
                connection.retry();
              }}
            >
              重试
            </button>
          )}
        </div>
      )}
      {settings && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="偏好设置"
            className="dialog"
          >
            <span className="eyebrow">随心落子</span>
            <h2>偏好设置</h2>
            {(
              [
                ["effects", "招式动画"],
                ["sound", "行棋音效"],
                ["reduced", "减少动态效果"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="switch-row">
                {label}
                <input
                  type="checkbox"
                  checked={preferences[key]}
                  onChange={(e) =>
                    setPreferences({ ...preferences, [key]: e.target.checked })
                  }
                />
              </label>
            ))}
            <div className="portrait-only">{boardDetails}</div>
            <p className="muted">
              偏好保存在当前浏览器 Cookie 中。音效由首次操作启用。
            </p>
            <button className="primary" onClick={() => setSettings(false)}>
              完成设置
            </button>
          </section>
        </div>
      )}
      {confirmation && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="确认认输"
            className="dialog"
          >
            <h2>此局，就此作罢？</h2>
            <p>{sideName(ownSide)}认输后，本局立即结束。</p>
            <div className="dialog-actions">
              <button onClick={() => setConfirmation(false)}>再想一想</button>
              <button className="primary" onClick={() => action("resign")}>
                确认认输
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
