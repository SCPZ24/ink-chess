import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  chmod,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { parse } from "smol-toml";
import { chromium } from "@playwright/test";
const exec = promisify(execFile),
  root = process.cwd(),
  temp = await mkdtemp(join(tmpdir(), "ink-chess-package-")),
  children = [];
const run = (cmd, args, cwd = root) =>
  exec(cmd, args, {
    cwd,
    maxBuffer: 5_000_000,
    timeout: 90000,
    env: {
      ...process.env,
      npm_config_cache: join(tmpdir(), "ink-chess-npm-cache"),
    },
  });
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function hashTree(path) {
  let contents = "";
  for (const f of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(path, f.name);
    contents +=
      f.name +
      (f.isDirectory()
        ? await hashTree(full)
        : createHash("sha256")
            .update(await readFile(full))
            .digest("hex"));
  }
  return createHash("sha256").update(contents).digest("hex");
}
async function readonly(path, yes) {
  for (const f of await readdir(path, { withFileTypes: true })) {
    const full = join(path, f.name);
    if (f.isDirectory()) await readonly(full, yes);
    else await chmod(full, yes ? 0o444 : 0o644);
  }
  await chmod(path, yes ? 0o555 : 0o755);
}
async function launch(bin, args, cwd) {
  let output = "";
  const proc = spawn(bin, args, { cwd, env: process.env });
  children.push(proc);
  proc.stdout.on("data", (b) => (output += b));
  proc.stderr.on("data", (b) => (output += b));
  return { proc, output: () => output };
}
async function stop(p) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const end = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  const force = setTimeout(() => p.kill("SIGKILL"), 5000);
  await end;
  clearTimeout(force);
}
let packageDir, browser;
try {
  await run("npm", ["run", "build"]);
  const packResult = JSON.parse(
    (await run("npm", ["pack", "--ignore-scripts", "--json"])).stdout,
  );
  const packed = Array.isArray(packResult)
    ? packResult
    : Object.values(packResult);
  const tar = resolve(root, packed[0].filename);
  assert(
    packed[0].files.some(
      (f) => f.path === "bin/ink-chess.mjs" && (f.mode & 0o111) !== 0,
    ),
  );
  assert(
    packed[0].files.some(
      (f) => f.path === "dist/web/fonts/MaShanZheng-Regular.ttf",
    ),
  );
  assert(
    !packed[0].files.some(
      (f) =>
        f.path.startsWith("src/") ||
        f.path.startsWith("tests/") ||
        f.path.includes("settings.json"),
    ),
  );
  console.log("PASS: build and npm package whitelist");
  assert.equal(
    (
      await run(
        "npm",
        ["exec", "--yes", "--package", tar, "--", "ink-chess", "--version"],
        temp,
      )
    ).stdout.trim(),
    "0.1.0",
  );
  console.log("PASS: npm exec / npx command resolution from local tarball");
  const install = join(temp, "clean-install");
  await mkdir(install);
  await writeFile(join(install, "package.json"), '{"private":true}');
  await run("npm", ["install", "--omit=dev", "--ignore-scripts", tar], install);
  packageDir = join(install, "node_modules/@scpz24/ink-chess");
  const before = await hashTree(packageDir);
  await readonly(packageDir, true);
  // Keep bin executable while the rest of the package is read-only.
  await chmod(join(packageDir, "bin/ink-chess.mjs"), 0o555);
  const bin = join(install, "node_modules/.bin/ink-chess");
  assert.equal((await run(bin, ["--version"], temp)).stdout.trim(), "0.1.0");
  assert((await run(bin, ["--help"], temp)).stdout.includes("--trusted-proxy"));
  browser = await chromium.launch({ headless: true });
  for (const [i, mode] of [
    "local",
    "lan",
    "server",
    "local",
    "local",
  ].entries()) {
    const mcp = mode === "local";
    const cwd = join(temp, `工作 目录 ${mode}${mcp ? `-mcp-${i}` : ""}`);
    await mkdir(cwd);
    const port = await freePort();
    const bind = mode === "server" || i === 4 ? "::1" : "127.0.0.1";
    const origin = `http://${bind.includes(":") ? `[${bind}]` : bind}:${port}`;
    const store =
      i === 0
        ? cwd
        : i === 1
          ? join(cwd, "相对 存储")
          : join(temp, `绝对 存储-${i}`);
    const args = [
      "--mode",
      mode,
      "--host",
      bind,
      "--port",
      String(port),
      ...(i === 3 ? ["--mcp"] : []),
      ...(i === 0 ? [] : ["--store", i === 1 ? "相对 存储" : store]),
    ];
    const { proc, output } = await launch(bin, args, cwd);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (proc.exitCode !== null) throw Error(output());
      try {
        ready = (await fetch(`${origin}/health`)).ok;
      } catch {}
      if (ready && output().includes(store)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(ready, output());
    assert(output().includes(store));
    assert.equal(output().includes("#host="), mode === "lan");
    const config = await (await fetch(`${origin}/api/config`)).json();
    assert.equal(config.mode, mode);
    assert.equal(config.mcp, mcp);
    assert.deepEqual(await readdir(store), []);
    if (i === 3) assert(output().includes("--mcp 已弃用"));
    if (mcp) {
      const page = await browser.newPage();
      await page.goto(origin);
      await page.getByRole("button", { name: "偏好设置" }).click();
      await page
        .getByRole("button", { name: "添加 Codex MCP", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Codex 已配置", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "添加 Claude Code MCP", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Claude Code 已配置", exact: true })
        .waitFor();
      await page.close();
      const client = new Client({ name: "package-test", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(origin + "/mcp")),
        );
        assert.deepEqual(
          (await client.listTools()).tools.map((t) => t.name).sort(),
          ["enter_chess", "quit_chess", "wait_for_next_move"],
        );
      } finally {
        await client.close();
      }
      const generated = parse(
        await readFile(join(store, ".codex/config.toml"), "utf8"),
      );
      assert.equal(generated.mcp_servers["ink-chess"].url, origin + "/mcp");
      assert.equal(generated.mcp_servers["ink-chess"].tool_timeout_sec, 1800);
      assert.equal((await fetch(origin + "/.codex/config.toml")).status, 404);
      const claude = JSON.parse(
        await readFile(join(store, ".mcp.json"), "utf8"),
      );
      assert.equal(claude.mcpServers["ink-chess"].timeout, 1800000);
      assert.equal(claude.mcpServers["ink-chess"].url, origin + "/mcp");
      assert.equal((await fetch(origin + "/.mcp.json")).status, 404);
    }
    const html = await (await fetch(`${origin}/`)).text();
    assert(html.includes("水墨象棋"));
    const js = html.match(/src="([^"]+\.js)"/)[1];
    assert.equal((await fetch(`${origin}${js}`)).status, 200);
    assert.equal(
      (await fetch(`${origin}/fonts/MaShanZheng-Regular.ttf`)).status,
      200,
    );
    assert.equal(
      (await fetch(`${origin}/ink-chess.settings.json`)).status,
      404,
    );
    await assert.rejects(run(bin, args, cwd), (e) =>
      e.stderr.includes("端口已被占用"),
    );
    if (mcp) {
      const collisionStore = join(temp, "collision-store");
      await assert.rejects(
        run(
          bin,
          [
            "--mcp",
            "--host",
            bind,
            "--port",
            String(port),
            "--store",
            collisionStore,
          ],
          cwd,
        ),
        (e) => e.stderr.includes("端口已被占用"),
      );
      assert.deepEqual(await readdir(collisionStore), []);
    }
    assert.deepEqual(
      (await readdir(store)).sort(),
      mcp ? [".claude", ".codex", ".mcp.json", "ink-chess.settings.json"] : [],
    );
    if (mcp) {
      const file = join(store, ".codex/config.toml");
      const original = await readFile(file, "utf8");
      await writeFile(file, "[broken");
      const failed = await fetch(origin + "/api/mcp/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "codex" }),
      });
      assert.equal(failed.status, 409);
      assert((await fetch(origin + "/health")).ok);
      assert.equal(await readFile(file, "utf8"), "[broken");
      await stop(proc);
      const restarted = await launch(bin, args, cwd);
      let health = false;
      for (let n = 0; n < 60; n++) {
        if (restarted.proc.exitCode !== null) throw Error(restarted.output());
        try {
          health = (await fetch(origin + "/health")).ok;
        } catch {}
        if (health) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert(health, restarted.output());
      assert.equal(
        (await (await fetch(origin + "/api/mcp/configuration")).json()).agents
          .codex.status,
        "conflict",
      );
      await stop(restarted.proc);
      await writeFile(file, original);
    }
    await stop(proc);
    console.log(
      `PASS: installed ${mode}${mcp ? "+MCP" : ""} CLI, assets, read-only package, port collision, ${i === 0 ? "default" : i === 1 ? "relative" : "absolute"} store`,
    );
  }
  assert.equal(await hashTree(packageDir), before);
  console.log(`Package acceptance passed: ${tar}`);
} finally {
  await browser?.close();
  await Promise.all(children.map(stop));
  if (packageDir) await readonly(packageDir, false).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
