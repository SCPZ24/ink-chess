import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, writeSettings } from "../src/server/config.js";
const dirs: string[] = [];
const temp = async () => {
  const p = await mkdtemp(join(tmpdir(), "ink-chess-test-"));
  dirs.push(p);
  return p;
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
describe("CLI config and storage", () => {
  it("defaults storage to caller cwd, not package directory", async () => {
    const cwd = await temp(),
      c = await resolveConfig([], cwd);
    expect(c.store).toBe(cwd);
    expect(c.mode).toBe("local");
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(5678);
    expect(await readdir(cwd)).toEqual([]);
  });
  it("resolves relative unicode paths and creates them", async () => {
    const cwd = await temp(),
      c = await resolveConfig(["--mode", "lan", "--store", "棋 局/store"], cwd);
    expect(c.store).toBe(join(cwd, "棋 局/store"));
    expect(c.host).toBe("0.0.0.0");
    expect(await readdir(c.store)).toEqual([]);
  });
  it("CLI overrides file settings without rewriting them", async () => {
    const cwd = await temp();
    await writeSettings(cwd, { schemaVersion: 1, mode: "server", port: 8000 });
    const original = await readFile(
      join(cwd, "ink-chess.settings.json"),
      "utf8",
    );
    const c = await resolveConfig(["--port", "9000"], cwd);
    expect(c.port).toBe(9000);
    expect(c.mode).toBe("server");
    expect(await readFile(join(cwd, "ink-chess.settings.json"), "utf8")).toBe(
      original,
    );
    expect(await readdir(cwd)).toEqual(["ink-chess.settings.json"]);
  });
  it("rejects broken config, a file instead of a directory, and invalid options", async () => {
    const cwd = await temp();
    for (const args of [
      ["--mode", "oops"],
      ["--port", "0"],
      ["--port", "65536"],
      ["--port", "NaN"],
      ["--unknown"],
      ["--mode", "lan", "--host", "192.168.1.10"],
    ])
      await expect(resolveConfig(args, cwd)).rejects.toThrow();
    await writeFile(join(cwd, "bad"), "x");
    await expect(resolveConfig(["--store", "bad"], cwd)).rejects.toThrow();
    await writeFile(join(cwd, "ink-chess.settings.json"), "{broken");
    await expect(resolveConfig([], cwd)).rejects.toThrow(/配置/);
  });
  it("rejects unwritable stores instead of falling back to npm cache", async () => {
    const cwd = await temp(),
      p = join(cwd, "locked");
    await mkdir(p, { mode: 0o555 });
    await expect(resolveConfig(["--store", p], cwd)).rejects.toThrow();
  });
});
