import type { GameState, Outcome, Side } from "./types.js";
export type LocalAction =
  | "move"
  | "resign"
  | "offer-draw"
  | "accept-draw"
  | "decline-draw"
  | "rematch"
  | "quit-ai";
export interface LocalView {
  type: "local-state";
  boardId: string;
  game: GameState;
  revision: number;
  canMove: boolean;
  allowedActions: LocalAction[];
  ai: {
    side: Side;
    phase: "ai" | "human" | "handoff" | "paused" | "finished";
  } | null;
}
export interface ChessEvent {
  status:
    | "entered"
    | "opponent_moved"
    | "action_required"
    | "game_over"
    | "paused"
    | "session_ended";
  session_id: string;
  event_seq: number;
  message: string;
  notation?: string;
  outcome?: Outcome;
  ai_side?: Side;
}
