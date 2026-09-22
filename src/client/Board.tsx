import { names, type GameState } from "../core/game.js";
export function Board({
  game,
  flipped,
  selected,
  targets,
  choose,
  enabled,
}: {
  game: GameState;
  flipped: boolean;
  selected: number | null;
  targets: number[];
  choose: (square: number) => void;
  enabled: boolean;
}) {
  const last = game.history.at(-1);
  const coord = (square: number) => {
    const s = flipped ? 89 - square : square;
    return { x: 54 + (s % 9) * 64, y: 54 + Math.floor(s / 9) * 64 };
  };
  return (
    <svg
      className="board"
      data-testid="board"
      data-flipped={flipped}
      viewBox="0 0 620 684"
      aria-label="中国象棋棋盘"
    >
      <defs>
        <linearGradient id="wood" x2="1" y2="1">
          <stop stopColor="#eddaba" />
          <stop offset=".5" stopColor="#f5e8ce" />
          <stop offset="1" stopColor="#ddc29a" />
        </linearGradient>
        <filter id="piece-shadow">
          <feDropShadow
            dx="0"
            dy="3"
            stdDeviation="2"
            floodColor="#493422"
            floodOpacity=".22"
          />
        </filter>
      </defs>
      <rect
        x="9"
        y="9"
        width="602"
        height="666"
        rx="9"
        fill="url(#wood)"
        stroke="#bda47b"
      />
      <rect
        x="23"
        y="23"
        width="574"
        height="638"
        rx="4"
        fill="none"
        stroke="#bba584"
        strokeWidth=".8"
      />
      <g stroke="#735f42" strokeWidth="1.2" fill="none">
        {Array.from({ length: 10 }, (_, y) => (
          <path key={"h" + y} d={`M54 ${54 + y * 64}H566`} />
        ))}
        {Array.from({ length: 9 }, (_, x) => (
          <path
            key={"v" + x}
            d={
              x === 0 || x === 8
                ? `M${54 + x * 64} 54V630`
                : `M${54 + x * 64} 54V310 M${54 + x * 64} 374V630`
            }
          />
        ))}
        <path d="M246 54L374 182M374 54L246 182M246 502L374 630M374 502L246 630" />
        {[19, 25, 27, 29, 31, 33, 35, 54, 56, 58, 60, 62, 64, 70].map((s) => {
          const { x, y } = coord(s);
          return (
            <g key={s}>
              {[-1, 1].flatMap((dx) =>
                [-1, 1].map((dy) =>
                  (s % 9 === 0 && dx === -1) ||
                  (s % 9 === 8 && dx === 1) ? null : (
                    <path
                      key={`${dx}${dy}`}
                      d={`M${x + dx * 7} ${y + dy * 17}V${y + dy * 7}H${x + dx * 17}`}
                    />
                  ),
                ),
              )}
            </g>
          );
        })}
      </g>
      <g className="river" textAnchor="middle" fill="#75603f">
        <text x="182" y="353">
          楚 河
        </text>
        <text x="438" y="353">
          汉 界
        </text>
      </g>
      <g className="board-number" textAnchor="middle" fill="#927952">
        {Array.from({ length: 9 }, (_, x) => (
          <text key={x} x={54 + x * 64} y="653">
            {flipped
              ? x + 1
              : ["九", "八", "七", "六", "五", "四", "三", "二", "一"][x]}
          </text>
        ))}
      </g>
      {game.board.map((piece, square) => {
        const { x, y } = coord(square),
          legal = targets.includes(square),
          chosen = selected === square;
        return (
          <g
            key={square}
            transform={`translate(${x},${y})`}
            role="button"
            tabIndex={enabled && (piece?.side === game.turn || legal) ? 0 : -1}
            aria-label={`${piece ? names[piece.side][piece.kind] : "空位"}，${(square % 9) + 1}路第${Math.floor(square / 9) + 1}行`}
            aria-disabled={!enabled}
            data-testid={`square-${square}`}
            data-legal={legal}
            className={`intersection ${chosen ? "selected" : ""}`}
            onClick={() => choose(square)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                choose(square);
              }
            }}
          >
            <circle r="30" fill="transparent" />
            {(last?.from === square || last?.to === square) && (
              <rect
                x="-29"
                y="-29"
                width="58"
                height="58"
                rx="7"
                fill="#ad493c"
                fillOpacity=".12"
                stroke="#ae6550"
                strokeDasharray="3 4"
              />
            )}
            {piece && (
              <g filter="url(#piece-shadow)">
                <circle
                  r="25"
                  fill="#fbefd3"
                  stroke={piece.side === "red" ? "#a13e32" : "#494841"}
                  strokeWidth="1.5"
                />
                <circle
                  r="21.5"
                  fill="none"
                  stroke={piece.side === "red" ? "#b36853" : "#85816c"}
                  strokeWidth=".6"
                />
                <text
                  className={`piece ${piece.side}`}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {names[piece.side][piece.kind]}
                </text>
              </g>
            )}
            {chosen && (
              <circle r="29" fill="none" stroke="#a33d2d" strokeWidth="2.5" />
            )}
            {legal &&
              (piece ? (
                <circle r="28" fill="none" stroke="#5b785c" strokeWidth="3" />
              ) : (
                <circle r="7" fill="#5b785c" fillOpacity=".75" />
              ))}
          </g>
        );
      })}
    </svg>
  );
}
