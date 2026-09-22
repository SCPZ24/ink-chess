import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createMcpConfiguration } from "../src/server/mcp-config.js";
const dirs: string[] = [];
async function setup() {
  const dir = await fs.mkdtemp(join(tmpdir(), "ink-install-"));
  dirs.push(dir);
  let url = "http://127.0.0.1:5678/mcp";
  const service = createMcpConfiguration(dir, () => url);
  return {
    dir,
    service,
    port: () => {
      url = "http://[::1]:5679/mcp";
    },
  };
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
it("reads without creating files, installs both agents, preserves other fields and updates only on request", async () => {
  const { dir, service, port } = await setup();
  expect((await service.read()).agents.claude.status).toBe("not_configured");
  expect(await fs.readdir(dir)).toEqual([]);
  await fs.mkdir(join(dir, ".claude"));
  await fs.writeFile(
    join(dir, ".claude/settings.json"),
    JSON.stringify({ model: "user-model", env: { OTHER: "keep" } }),
  );
  await service.install("claude");
  const file = join(dir, ".mcp.json");
  const original = await fs.readFile(file, "utf8");
  expect(JSON.parse(original).mcpServers["ink-chess"]).toEqual({
    type: "http",
    url: "http://127.0.0.1:5678/mcp",
    timeout: 1800000,
  });
  expect(
    JSON.parse(await fs.readFile(join(dir, ".claude/settings.json"), "utf8")),
  ).toEqual({
    model: "user-model",
    env: { OTHER: "keep", CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0" },
  });
  const time = (await fs.stat(file)).mtimeMs;
  await service.install("claude");
  expect((await fs.stat(file)).mtimeMs).toBe(time);
  await service.install("codex");
  expect((await service.read()).agents.codex.status).toBe("configured");
  port();
  expect((await service.read()).agents.claude.status).toBe("needs_update");
  expect(await fs.readFile(file, "utf8")).toBe(original);
  await service.install("claude");
  expect(
    JSON.parse(await fs.readFile(file, "utf8")).mcpServers["ink-chess"].url,
  ).toBe("http://[::1]:5679/mcp");
  expect((await service.read()).agents.codex.status).toBe("needs_update");
});
it("refuses unowned and edited fields while leaving every file unchanged", async () => {
  const { dir, service } = await setup();
  await fs.writeFile(
    join(dir, ".mcp.json"),
    '{"mcpServers":{"ink-chess":{"type":"http","url":"user"}}}',
  );
  await expect(service.install("claude")).rejects.toThrow(/同名|托管/);
  await fs.rm(join(dir, ".mcp.json"));
  await service.install("claude");
  const settings = join(dir, ".claude/settings.json");
  const changed = '{"env":{"CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS":"5"}}';
  await fs.writeFile(settings, changed);
  const before = await fs.readFile(join(dir, ".mcp.json"), "utf8");
  await expect(service.install("claude")).rejects.toThrow(/修改/);
  expect(await fs.readFile(settings, "utf8")).toBe(changed);
  expect(await fs.readFile(join(dir, ".mcp.json"), "utf8")).toBe(before);
  expect((await service.read()).agents.claude.status).toBe("conflict");
});
it("rolls back files and metadata when a later replacement fails", async () => {
  const { dir } = await setup();
  let count = 0;
  const service = createMcpConfiguration(
    dir,
    () => "http://127.0.0.1:5678/mcp",
    async (a, b) => {
      if (++count === 2) throw Error("injected rename failure");
      await fs.rename(a, b);
    },
  );
  await expect(service.install("claude")).rejects.toThrow(/injected/);
  expect(await fs.readdir(dir)).toEqual([]);
});
it("reports a rollback failure with actual per-file states instead of reporting success", async () => {
  const { dir, service } = await setup();
  await service.install("claude");
  let count = 0;
  const broken = createMcpConfiguration(
    dir,
    () => "http://127.0.0.1:9999/mcp",
    async (a, b) => {
      if (++count >= 2) throw Error("injected failure");
      await fs.rename(a, b);
    },
  );
  await expect(broken.install("claude")).rejects.toMatchObject({
    files: expect.arrayContaining([
      expect.objectContaining({ state: "changed" }),
    ]),
  });
  expect((await service.read()).agents.claude.status).toBe("conflict");
});
it("serializes concurrent installs so neither agent metadata is lost", async () => {
  const { dir, service } = await setup();
  await Promise.all([
    service.install("codex"),
    service.install("claude"),
    service.install("claude"),
  ]);
  expect((await service.read()).agents).toMatchObject({
    codex: { status: "configured" },
    claude: { status: "configured" },
  });
  const metadata = JSON.parse(
    await fs.readFile(join(dir, "ink-chess.settings.json"), "utf8"),
  );
  expect(Object.keys(metadata.mcpInstallations).sort()).toEqual([
    "claude",
    "codex",
  ]);
});
it("restores both existing Claude files when the metadata replacement fails", async () => {
  const { dir } = await setup();
  await fs.mkdir(join(dir, ".claude"));
  const mcp =
    '{"mcpServers":{"other":{"type":"http","url":"http://localhost:8000/mcp"}}}\n';
  const settings = '{"model":"keep"}\n';
  await fs.writeFile(join(dir, ".mcp.json"), mcp);
  await fs.writeFile(join(dir, ".claude/settings.json"), settings);
  let count = 0;
  const service = createMcpConfiguration(
    dir,
    () => "http://127.0.0.1:5678/mcp",
    async (a, b) => {
      if (++count === 3) throw Error("metadata replacement failed");
      await fs.rename(a, b);
    },
  );
  await expect(service.install("claude")).rejects.toThrow(/metadata/);
  expect(await fs.readFile(join(dir, ".mcp.json"), "utf8")).toBe(mcp);
  expect(await fs.readFile(join(dir, ".claude/settings.json"), "utf8")).toBe(
    settings,
  );
  expect((await fs.readdir(dir)).sort()).toEqual([".claude", ".mcp.json"]);
  expect(await fs.readdir(join(dir, ".claude"))).toEqual(["settings.json"]);
});
it("rejects Claude directory links, malformed JSON and global targets before writing", async () => {
  const { dir, service } = await setup(),
    outside = await setup();
  await fs.mkdir(join(outside.dir, ".claude"));
  await fs.symlink(join(outside.dir, ".claude"), join(dir, ".claude"));
  await expect(service.install("claude")).rejects.toThrow(/链接/);
  expect(await fs.readdir(outside.dir + "/.claude")).toEqual([]);
  await fs.rm(join(dir, ".claude"));
  await fs.mkdir(join(dir, ".claude"));
  await fs.writeFile(join(dir, ".claude/settings.json"), "[]");
  await expect(service.install("claude")).rejects.toThrow(/对象/);
  expect(await fs.readdir(dir)).toEqual([".claude"]);
  await expect(
    createMcpConfiguration(
      homedir(),
      () => "http://127.0.0.1:5678/mcp",
    ).install("claude"),
  ).rejects.toThrow(/全局/);
});
it("detects edited Codex fields and adopts intact legacy marker blocks", async () => {
  const { dir, service } = await setup();
  await service.install("codex");
  const file = join(dir, ".codex/config.toml");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, original.replace("1800", "900"));
  await expect(service.install("codex")).rejects.toThrow(/修改/);
  await fs.writeFile(file, original);
  await fs.rm(join(dir, "ink-chess.settings.json"));
  expect((await service.read()).agents.codex.status).toBe("configured");
  await fs.writeFile(file, original.replace("1800", "900"));
  await expect(service.install("codex")).rejects.toThrow(/修改/);
  await fs.writeFile(file, original);
  await service.install("codex");
  expect(
    JSON.parse(await fs.readFile(join(dir, "ink-chess.settings.json"), "utf8"))
      .mcpInstallations.codex.server.tool_timeout_sec,
  ).toBe(1800);
});
