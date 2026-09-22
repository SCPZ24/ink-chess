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
let packageDir;
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
  for (const [i, mode] of ["local", "lan", "server"].entries()) {
    const cwd = join(temp, `工作 目录 ${mode}`);
    await mkdir(cwd);
    const port = await freePort();
    const bind = mode === "server" ? "::1" : "127.0.0.1";
    const origin = `http://${bind.includes(":") ? `[${bind}]` : bind}:${port}`;
    const store =
      i === 0
        ? cwd
        : i === 1
          ? join(cwd, "相对 存储")
          : join(temp, "绝对 存储");
    const args = [
      "--mode",
      mode,
      "--host",
      bind,
      "--port",
      String(port),
      ...(i === 0 ? [] : ["--store", i === 1 ? "相对 存储" : store]),
    ];
    const { proc, output } = await launch(bin, args, cwd);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (proc.exitCode !== null) throw Error(output());
      try {
        ready = (await fetch(`${origin}/health`)).ok;
      } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(ready, output());
    assert(output().includes(store));
    assert.equal(output().includes("#host="), mode === "lan");
    const config = await (await fetch(`${origin}/api/config`)).json();
    assert.equal(config.mode, mode);
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
    await stop(proc);
    assert.deepEqual(await readdir(store), []);
    console.log(
      `PASS: installed ${mode} CLI, assets, read-only package, port collision, ${i === 0 ? "default" : i === 1 ? "relative" : "absolute"} store`,
    );
  }
  assert.equal(await hashTree(packageDir), before);
  console.log(`Package acceptance passed: ${tar}`);
} finally {
  await Promise.all(children.map(stop));
  if (packageDir) await readonly(packageDir, false).catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
