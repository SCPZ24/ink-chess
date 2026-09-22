import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGameServer } from "../src/server/app.js";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function start(
  mode: "local" | "lan" | "server" = "local",
  host = "127.0.0.1",
) {
  const store = await mkdtemp(join(tmpdir(), "ink-api-"));
  cleanup.push(() => rm(store, { recursive: true, force: true }));
  const app = createGameServer({
    mode,
    host,
    port: 0,
    store,
    trustedProxy: [],
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  cleanup.push(() => app.close());
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const install = (
    body: unknown,
    headers = { "Content-Type": "application/json" },
  ) =>
    fetch(url + "/api/mcp/configuration", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return { url, store, install };
}
it("ordinary local startup exposes readiness but creates files only after the settings action", async () => {
  const { url, store, install } = await start();
  expect((await (await fetch(url + "/api/config")).json()).mcp).toBe(true);
  const status = await (await fetch(url + "/api/mcp/configuration")).json();
  expect(status.url).toBe(url + "/mcp");
  expect(status.store).toBe(store);
  expect(await readdir(store)).toEqual([]);
  expect((await install({ agent: "claude" })).status).toBe(200);
  expect((await install({ agent: "codex" })).status).toBe(200);
  expect(
    (await (await fetch(url + "/api/mcp/configuration")).json()).agents.codex
      .status,
  ).toBe("configured");
});
it("rejects cross-site, forwarded, non-JSON and arbitrary-path writes", async () => {
  const { url, store, install } = await start();
  expect(
    (await install({ agent: "claude" }, { "Content-Type": "text/plain" }))
      .status,
  ).toBe(415);
  expect((await install({ agent: "claude", store: "/tmp/other" })).status).toBe(
    400,
  );
  expect((await install({ agent: "anything" })).status).toBe(400);
  for (const headers of [
    { Origin: "http://evil.invalid" },
    { "X-Real-IP": "127.0.0.1" },
    { "X-Forwarded-For": "127.0.0.1" },
  ] as Record<string, string>[]) {
    expect(
      (await fetch(url + "/api/mcp/configuration", { headers })).status,
    ).toBe(403);
    expect(
      (
        await install(
          { agent: "codex" },
          { "Content-Type": "application/json", ...headers },
        )
      ).status,
    ).toBe(403);
  }
  expect(await readdir(store)).toEqual([]);
});
it("keeps serving the game when configuration conflicts and disables setup outside loopback local mode", async () => {
  const { url, store, install } = await start();
  await mkdir(join(store, ".claude"));
  await writeFile(join(store, ".claude/settings.json"), "[broken");
  expect((await install({ agent: "claude" })).status).toBe(409);
  expect((await fetch(url + "/health")).status).toBe(200);
  for (const [mode, host] of [
    ["local", "0.0.0.0"],
    ["lan", "127.0.0.1"],
    ["server", "127.0.0.1"],
  ] as const) {
    const other = await start(mode, host);
    expect((await fetch(other.url + "/api/mcp/configuration")).status).toBe(
      404,
    );
    expect((await other.install({ agent: "codex" })).status).toBe(404);
    expect(await readdir(other.store)).toEqual([]);
  }
});
