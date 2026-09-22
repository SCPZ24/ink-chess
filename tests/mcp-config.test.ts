import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
  symlink,
  readdir,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { parse } from "smol-toml";
import { writeMcpConfig } from "../src/server/mcp-config.js";
import { resolveConfig } from "../src/server/config.js";
const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "ink-mcp-config-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
it("enables MCP only explicitly in local loopback mode and resolves store normally", async () => {
  const dir = await temp();
  expect((await resolveConfig(["--mcp", "--store", "棋 局"], dir)).mcp).toBe(
    true,
  );
  expect((await resolveConfig([], dir)).mcp).toBe(false);
  for (const args of [
    ["--mcp", "--mode", "lan"],
    ["--mcp", "--mode", "server"],
    ["--mcp", "--host", "0.0.0.0"],
  ])
    await expect(resolveConfig(args, dir)).rejects.toThrow(/MCP/);
  expect((await resolveConfig(["--mcp", "--host", "::1"], dir)).mcp).toBe(true);
});
it("creates a store-local config, updates its managed block, preserves unrelated text, and avoids rewriting identical files", async () => {
  const dir = await temp();
  const file = await writeMcpConfig(dir, "http://127.0.0.1:5678/mcp");
  expect(file).toBe(join(dir, ".codex/config.toml"));
  const text = await readFile(file, "utf8");
  expect(parse(text)).toMatchObject({
    mcp_servers: {
      "ink-chess": {
        url: "http://127.0.0.1:5678/mcp",
        tool_timeout_sec: 1800,
        enabled_tools: ["enter_chess", "wait_for_next_move", "quit_chess"],
      },
    },
  });
  const before = await stat(file);
  await writeMcpConfig(dir, "http://127.0.0.1:5678/mcp");
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  const prefix = '# user comment\nmodel_reasoning_effort = "high"\n';
  const suffix = '\n[mcp_servers.other]\nurl = "http://localhost:9000/mcp"\n';
  await writeFile(file, prefix + text + suffix);
  await writeMcpConfig(dir, "http://[::1]:5679/mcp");
  const updated = await readFile(file, "utf8");
  expect(updated.startsWith(prefix)).toBe(true);
  expect(updated.endsWith(suffix)).toBe(true);
  expect(parse(updated)).toMatchObject({
    mcp_servers: {
      "ink-chess": { url: "http://[::1]:5679/mcp" },
      other: { url: "http://localhost:9000/mcp" },
    },
  });
  expect(await readdir(join(dir, ".codex"))).toEqual(["config.toml"]);
});
it("refuses unowned same-name entries, malformed TOML and mismatched markers without changing the original", async () => {
  const dir = await temp();
  await mkdir(join(dir, ".codex"));
  const file = join(dir, ".codex/config.toml");
  for (const value of [
    '[mcp_servers.ink-chess]\nurl="user"\n',
    "[broken",
    "# BEGIN ink-chess managed MCP\n",
    "# END ink-chess managed MCP\n",
  ]) {
    await writeFile(file, value);
    await expect(
      writeMcpConfig(dir, "http://127.0.0.1:5678/mcp"),
    ).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(value);
  }
});
it("does not append a root table under an existing TOML table context incorrectly", async () => {
  const dir = await temp();
  await mkdir(join(dir, ".codex"));
  await writeFile(
    join(dir, ".codex/config.toml"),
    '[mcp_servers.other]\nurl="other"',
  );
  await writeMcpConfig(dir, "http://127.0.0.1:5678/mcp");
  expect(
    parse(await readFile(join(dir, ".codex/config.toml"), "utf8")),
  ).toMatchObject({
    mcp_servers: {
      other: { url: "other" },
      "ink-chess": { tool_timeout_sec: 1800 },
    },
  });
});
it("rejects file and directory symlinks instead of writing outside store", async () => {
  const dir = await temp(),
    outside = await temp();
  await mkdir(join(outside, ".codex"));
  await writeFile(join(outside, ".codex/config.toml"), "# untouched\n");
  await symlink(join(outside, ".codex"), join(dir, ".codex"));
  await expect(
    writeMcpConfig(dir, "http://localhost:5678/mcp"),
  ).rejects.toThrow(/链接|全局/);
  expect(await readFile(join(outside, ".codex/config.toml"), "utf8")).toBe(
    "# untouched\n",
  );
  await rm(join(dir, ".codex"));
  await mkdir(join(dir, ".codex"));
  await symlink(
    join(outside, ".codex/config.toml"),
    join(dir, ".codex/config.toml"),
  );
  await expect(
    writeMcpConfig(dir, "http://localhost:5678/mcp"),
  ).rejects.toThrow(/链接|全局/);
  await rm(join(dir, ".codex/config.toml"));
  await writeFile(join(dir, ".codex/config.toml"), "# read only\n");
  await chmod(join(dir, ".codex/config.toml"), 0o444);
  await expect(
    writeMcpConfig(dir, "http://localhost:5678/mcp"),
  ).rejects.toThrow(/不可写/);
  expect(await readFile(join(dir, ".codex/config.toml"), "utf8")).toBe(
    "# read only\n",
  );
});
it("rejects the actual user-level config target before attempting to write", async () => {
  const file = join(homedir(), ".codex/config.toml");
  const original = await readFile(file).catch(() => null);
  await expect(
    writeMcpConfig(homedir(), "http://localhost:5678/mcp"),
  ).rejects.toThrow(/全局/);
  expect(await readFile(file).catch(() => null)).toEqual(original);
});
