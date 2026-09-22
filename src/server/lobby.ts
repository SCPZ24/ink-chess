import { timingSafeEqual } from "node:crypto";
import {
  initialGame,
  applyMove,
  resign,
  offerDraw,
  respondDraw,
  abort,
  type GameState,
  type Side,
  other,
} from "../core/game.js";
import type {
  Mode,
  View,
  RoomView,
  ClientMessage,
  ServerMessage,
} from "../core/protocol.js";
import type { Identity } from "./identity.js";
interface Client {
  id: string;
  ip: string;
  name: string;
  role: "host" | "guest" | "player";
  roomId: string | null;
  lastGame: GameState | null;
  send: (m: ServerMessage) => void;
  close: () => void;
}
interface Room {
  id: string;
  name: string;
  members: Map<string, Side>;
  game: GameState;
  accepting: boolean;
  ready: Set<string>;
}
export class Lobby {
  private clients = new Map<string, Client>();
  private rooms = new Map<string, Room>();
  private hostId: string | null = null;
  constructor(
    readonly mode: Mode,
    private hostToken: string,
  ) {}
  connect(
    identity: Identity,
    name: string,
    token: string | undefined,
    send: Client["send"],
    close: Client["close"],
  ): string {
    name = name.trim();
    if (
      !name ||
      Array.from(name).length > 16 ||
      /[\u0000-\u001f\u007f]/.test(name)
    )
      throw new Error("昵称须为1至16个可见字符");
    if (this.mode === "local") throw new Error("本地模式不接收联机");
    let role: Client["role"] = "player";
    let lanRoom: Room | undefined;
    if (this.mode === "lan") {
      if (token !== undefined) {
        const provided = Buffer.from(token),
          expected = Buffer.from(this.hostToken);
        if (
          !identity.directLoopback ||
          provided.length !== expected.length ||
          !timingSafeEqual(provided, expected)
        )
          throw new Error("请使用终端提供的本机玩家专用入口");
        if (this.hostId) throw new Error("本机席位已被占用，请关闭重复标签页");
        role = "host";
      } else {
        if (identity.local)
          throw new Error(
            "本机访问请使用终端提供的专用入口；代理访问请配置真实 IP",
          );
        const host = this.hostId ? this.clients.get(this.hostId) : undefined;
        lanRoom = host?.roomId ? this.rooms.get(host.roomId) : undefined;
        if (!lanRoom) throw new Error("本机玩家尚未就绪，请稍后重试");
        if (lanRoom.members.size >= 2)
          throw new Error("对局已满，来客席位已被占用");
        if (!lanRoom.accepting) throw new Error("本机尚未开放接待新对手");
        role = "guest";
      }
    }
    if ([...this.clients.values()].some((c) => c.ip === identity.ip))
      throw new Error("此 IP 已有在线玩家");
    const id = crypto.randomUUID();
    const client: Client = {
      id,
      ip: identity.ip,
      name,
      role,
      roomId: null,
      lastGame: null,
      send,
      close,
    };
    this.clients.set(id, client);
    if (role === "host") {
      this.hostId = id;
      this.create(client);
    }
    if (role === "guest" && lanRoom) {
      lanRoom.members.set(id, "black");
      client.roomId = lanRoom.id;
      lanRoom.game = initialGame();
      lanRoom.accepting = false;
    }
    send({ type: "welcome", clientId: id });
    this.broadcast();
    return id;
  }
  private client(id: string): Client {
    const c = this.clients.get(id);
    if (!c) throw new Error("连接已失效");
    return c;
  }
  private create(c: Client): Room {
    if (c.roomId) throw new Error("请先离开当前房间");
    const id = crypto.randomUUID();
    const room: Room = {
      id,
      name: `${c.name}的棋局`,
      members: new Map([[c.id, "red"]]),
      game: initialGame(),
      accepting: true,
      ready: new Set(),
    };
    this.rooms.set(id, room);
    c.roomId = id;
    c.lastGame = null;
    return room;
  }
  private summary(r: Room) {
    return {
      id: r.id,
      name: r.name,
      players: r.members.size,
      status: r.game.result
        ? ("finished" as const)
        : r.members.size === 2
          ? ("playing" as const)
          : ("waiting" as const),
    };
  }
  view(id: string): View {
    const c = this.client(id),
      room = c.roomId ? this.rooms.get(c.roomId) : undefined;
    const own: RoomView | null = room
      ? {
          ...this.summary(room),
          game: room.game,
          side: room.members.get(id)!,
          members: [...room.members].map(([member, side]) => ({
            name: this.client(member).name,
            role: this.client(member).role,
            side,
          })),
          accepting: room.accepting,
          rematchReady: room.ready.has(id),
        }
      : null;
    return {
      room: own,
      rooms:
        this.mode === "server"
          ? [...this.rooms.values()].map((r) => this.summary(r))
          : [],
      role: c.role,
      lastGame: c.lastGame,
    };
  }
  private broadcast() {
    for (const c of this.clients.values())
      c.send({ type: "state", ...this.view(c.id) });
  }
  command(id: string, m: Exclude<ClientMessage, { type: "hello" }>): void {
    const c = this.client(id);
    if (m.type === "create") {
      if (this.mode !== "server") throw new Error("当前模式没有房间大厅");
      this.create(c);
      this.broadcast();
      return;
    }
    if (m.type === "join") {
      if (this.mode !== "server" || c.roomId)
        throw new Error("当前不能加入房间");
      const r = this.rooms.get(m.roomId);
      if (!r || r.members.size !== 1 || r.game.result)
        throw new Error("房间不存在或已满");
      r.members.set(id, "black");
      r.game = initialGame();
      r.accepting = false;
      c.roomId = r.id;
      c.lastGame = null;
      this.broadcast();
      return;
    }
    if (m.type === "leave") {
      if (this.mode === "lan") this.disconnect(id);
      else {
        this.leaveRoom(c);
        this.broadcast();
      }
      return;
    }
    const r = c.roomId ? this.rooms.get(c.roomId) : undefined;
    if (!r) throw new Error("当前没有对局");
    if (m.type === "open-lan") {
      if (this.mode !== "lan" || c.role !== "host" || r.members.size !== 1)
        throw new Error("只有空闲的本机席位可以接待新对手");
      r.game = initialGame();
      r.members.set(id, "red");
      r.accepting = true;
      r.ready.clear();
      this.broadcast();
      return;
    }
    if (m.gameId !== r.game.id || m.version !== r.game.version)
      throw new Error("棋局已更新，请按当前局面操作");
    if (r.members.size !== 2) throw new Error("请等待对手加入");
    const side = r.members.get(id)!;
    switch (m.type) {
      case "move":
        if (side !== r.game.turn) throw new Error("还未轮到你行棋");
        r.game = applyMove(r.game, m.move);
        break;
      case "resign":
        r.game = resign(r.game, side);
        break;
      case "offer-draw":
        r.game = offerDraw(r.game, side);
        break;
      case "accept-draw":
      case "decline-draw":
        r.game = respondDraw(r.game, side, m.type === "accept-draw");
        break;
      case "rematch":
        if (!r.game.result || r.game.result.reason === "aborted")
          throw new Error("当前不能再局");
        r.ready.add(id);
        if (r.ready.size === 2) {
          for (const [member, color] of r.members)
            r.members.set(member, other(color));
          r.game = initialGame();
          r.ready.clear();
        }
        break;
    }
    this.broadcast();
  }
  private leaveRoom(c: Client) {
    const r = c.roomId ? this.rooms.get(c.roomId) : undefined;
    if (!r) return;
    r.game = abort(r.game);
    for (const member of r.members.keys()) {
      const peer = this.clients.get(member);
      if (peer) {
        peer.lastGame = r.game;
        peer.roomId = null;
      }
    }
    this.rooms.delete(r.id);
  }
  disconnect(id: string): void {
    const c = this.clients.get(id);
    if (!c) return;
    if (this.mode === "lan") {
      const r = c.roomId ? this.rooms.get(c.roomId) : undefined;
      if (r) {
        r.game = abort(r.game);
        r.accepting = false;
        r.ready.clear();
        for (const member of r.members.keys())
          this.clients
            .get(member)
            ?.send({ type: "state", ...this.view(member) });
        if (c.role === "host") {
          this.hostId = null;
          for (const member of r.members.keys())
            if (member !== id) {
              const g = this.clients.get(member);
              this.clients.delete(member);
              g?.send({
                type: "error",
                message: "本机玩家已离线，本局结束。请重新进入新的对局。",
                fatal: true,
              });
              g?.close();
            }
          this.rooms.delete(r.id);
        } else r.members.delete(id);
      }
    } else this.leaveRoom(c);
    this.clients.delete(id);
    c.close();
    this.broadcast();
  }
  shutdown() {
    for (const id of [...this.clients.keys()]) this.disconnect(id);
  }
}
