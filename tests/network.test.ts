import { describe, it, expect } from "vitest";
import { Lobby } from "../src/server/lobby.js";
import { resolveIdentity } from "../src/server/identity.js";
import type { ServerMessage } from "../src/core/protocol.js";
const local = resolveIdentity("::ffff:127.0.0.1", {}, [], ["192.168.1.10"]);
const guest = (n = 2) =>
  resolveIdentity(`192.168.1.${n}`, {}, [], ["192.168.1.10"]);
function client(l: Lobby, identity = guest(), token?: string) {
  const messages: ServerMessage[] = [];
  const id = l.connect(
    identity,
    "棋友",
    token,
    (m) => messages.push(m),
    () => {},
  );
  return { id, messages };
}
describe("network identity", () => {
  it("normalizes mapped IPv4 and recognizes loopback and host interfaces", () => {
    expect(local.directLoopback).toBe(true);
    expect(local.ip).toBe("127.0.0.1");
    expect(resolveIdentity("::1", {}, [], []).directLoopback).toBe(true);
    expect(
      resolveIdentity("192.168.1.10", {}, [], ["192.168.1.10"]).local,
    ).toBe(true);
  });
  it("never lets proxy headers grant the host role", () => {
    const proxied = resolveIdentity(
      "127.0.0.1",
      { "x-real-ip": "192.168.1.2" },
      ["127.0.0.1"],
      [],
    );
    expect(proxied.ip).toBe("192.168.1.2");
    expect(proxied.directLoopback).toBe(false);
    expect(
      resolveIdentity("192.168.1.2", { "x-real-ip": "127.0.0.1" }, [], []).ip,
    ).toBe("192.168.1.2");
    expect(() =>
      resolveIdentity(
        "127.0.0.1",
        { "x-forwarded-for": "192.168.1.2" },
        ["127.0.0.1"],
        [],
      ),
    ).toThrow();
  });
});
describe("LAN seat lifecycle", () => {
  it("requires a host first, a valid token, and one seat per role", () => {
    const l = new Lobby("lan", "secret");
    expect(() => client(l)).toThrow(/本机/);
    expect(() => client(l, local, "wrong")).toThrow();
    const host = client(l, local, "secret");
    expect(() => client(l, local, "secret")).toThrow();
    const external = client(l);
    expect(() => client(l, guest(3))).toThrow(/满|占/);
    expect(l.view(host.id).room?.game.id).toBe(
      l.view(external.id).room?.game.id,
    );
  });
  it("rejects host proof through a proxy and local-interface guests", () => {
    const l = new Lobby("lan", "secret");
    const proxy = resolveIdentity(
      "127.0.0.1",
      { "x-real-ip": "192.168.1.2" },
      ["127.0.0.1"],
      [],
    );
    expect(() => client(l, proxy, "secret")).toThrow();
    client(l, local, "secret");
    expect(() =>
      client(l, resolveIdentity("192.168.1.10", {}, [], ["192.168.1.10"])),
    ).toThrow();
  });
  it("checks seat, turn, game id and revision on every move", () => {
    const l = new Lobby("lan", "secret"),
      h = client(l, local, "secret"),
      g = client(l);
    const s = l.view(h.id).room!.game;
    const command = {
      type: "move" as const,
      gameId: s.id,
      version: s.version,
      move: { from: 54, to: 45 },
    };
    expect(() => l.command(g.id, command)).toThrow();
    l.command(h.id, command);
    expect(() => l.command(h.id, command)).toThrow();
    expect(l.view(g.id).room!.game.history).toHaveLength(1);
  });
  it("aborts on guest loss and never hands the old game to a new guest", () => {
    const l = new Lobby("lan", "secret"),
      h = client(l, local, "secret"),
      g = client(l);
    const old = l.view(h.id).room!.game;
    l.disconnect(g.id);
    expect(l.view(h.id).room?.game.result?.reason).toBe("aborted");
    expect(() => client(l, guest(3))).toThrow();
    l.command(h.id, { type: "open-lan" });
    const next = client(l, guest(3));
    expect(l.view(next.id).room!.game.id).not.toBe(old.id);
    l.disconnect(g.id);
    expect(l.view(next.id).room!.status).toBe("playing");
    expect(() =>
      l.command(h.id, {
        type: "move",
        gameId: old.id,
        version: old.version,
        move: { from: 54, to: 45 },
      }),
    ).toThrow();
  });
  it("host disconnect releases the guest and re-entry creates a fresh session", () => {
    const l = new Lobby("lan", "secret"),
      h = client(l, local, "secret"),
      g = client(l);
    l.disconnect(h.id);
    expect(() => l.view(g.id)).toThrow();
    const again = client(l, local, "secret");
    expect(l.view(again.id).room?.status).toBe("waiting");
  });
  it("rematch swaps color without swapping host identity", () => {
    const l = new Lobby("lan", "secret"),
      h = client(l, local, "secret"),
      g = client(l);
    let s = l.view(h.id).room!.game;
    l.command(g.id, { type: "resign", gameId: s.id, version: s.version });
    s = l.view(h.id).room!.game;
    l.command(h.id, { type: "rematch", gameId: s.id, version: s.version });
    l.command(g.id, { type: "rematch", gameId: s.id, version: s.version });
    expect(l.view(h.id).room?.side).toBe("black");
    expect(l.view(h.id).role).toBe("host");
  });
});
describe("server rooms", () => {
  it("isolates 10 rooms and rejects cross-room moves and duplicate IPs", () => {
    const l = new Lobby("server", "");
    const pairs = Array.from({ length: 10 }, (_, i) => [
      client(l, guest(i * 2 + 20)),
      client(l, guest(i * 2 + 21)),
    ]);
    for (const [a, b] of pairs) {
      l.command(a.id, { type: "create" });
      l.command(b.id, { type: "join", roomId: l.view(a.id).room!.id });
    }
    const room = l.view(pairs[0][0].id).room!;
    l.command(pairs[0][0].id, {
      type: "move",
      gameId: room.game.id,
      version: 0,
      move: { from: 54, to: 45 },
    });
    expect(l.view(pairs[0][1].id).room!.game.history).toHaveLength(1);
    expect(l.view(pairs[1][0].id).room!.game.history).toHaveLength(0);
    expect(() =>
      l.command(pairs[1][0].id, {
        type: "move",
        gameId: room.game.id,
        version: 0,
        move: { from: 54, to: 45 },
      }),
    ).toThrow();
    expect(() => client(l, guest(20))).toThrow();
  });
  it("deletes abandoned rooms and does not replace a final result on disconnect", () => {
    const l = new Lobby("server", ""),
      a = client(l),
      b = client(l, guest(3));
    l.command(a.id, { type: "create" });
    const room = l.view(a.id).room!;
    l.command(b.id, { type: "join", roomId: room.id });
    l.command(a.id, {
      type: "resign",
      gameId: l.view(a.id).room!.game.id,
      version: 0,
    });
    l.disconnect(a.id);
    expect(l.view(b.id).rooms).toHaveLength(0);
    expect(l.view(b.id).lastGame?.result?.reason).toBe("resign");
  });
});
it("rejects queued moves after a final result and preserves it when a guest disconnects", () => {
  const l = new Lobby("lan", "secret"),
    h = client(l, local, "secret"),
    g = client(l);
  let state = l.view(h.id).room!.game;
  l.command(g.id, { type: "resign", gameId: state.id, version: state.version });
  state = l.view(h.id).room!.game;
  expect(() =>
    l.command(h.id, {
      type: "move",
      gameId: state.id,
      version: state.version,
      move: { from: 54, to: 45 },
    }),
  ).toThrow(/结束/);
  l.disconnect(g.id);
  expect(l.view(h.id).room!.game.result).toEqual({
    winner: "red",
    reason: "resign",
  });
});
it("a stale connection close cannot evict a new occupant at the same IP", () => {
  const l = new Lobby("server", ""),
    first = client(l);
  l.disconnect(first.id);
  const second = client(l);
  l.disconnect(first.id);
  expect(l.view(second.id).rooms).toEqual([]);
  expect(() => l.command(first.id, { type: "create" })).toThrow(/失效/);
});
