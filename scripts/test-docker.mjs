import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const exec = promisify(execFile),
  root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""),
  prefix = `ink-chess-test-${process.pid}`,
  network = prefix,
  names = [];
const docker = (...args) =>
  exec("docker", args, { maxBuffer: 4 * 1024 * 1024 }).then((r) =>
    r.stdout.trim(),
  );
const pause = () => new Promise((r) => setTimeout(r, 100));
async function control(name, message = { type: "status" }) {
  return JSON.parse(
    await docker(
      "exec",
      name,
      "node",
      "tests/docker/control.mjs",
      JSON.stringify(message),
    ),
  );
}
async function until(name, predicate) {
  let status;
  for (let i = 0; i < 80; i++) {
    try {
      status = await control(name);
    } catch {
      await pause();
      continue;
    }
    if (predicate(status)) return status;
    await pause();
  }
  throw Error(`Timed out: ${name}: ${JSON.stringify(status)}`);
}
async function peer(suffix, role) {
  const name = `${prefix}-${suffix}`;
  names.push(name);
  await docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    network,
    "--mount",
    `type=bind,source=${root},target=/app,readonly`,
    "-w",
    "/app",
    "node:22-alpine",
    "node",
    "tests/docker/peer.mjs",
    role,
  );
  await until(name, () => true);
  return name;
}
try {
  await docker("network", "create", network);
  const host = await peer("host", "host");
  let hostStatus = await until(
    host,
    (s) => s.state?.room?.status === "waiting",
  );
  const [a, b] = await Promise.all([
    peer("guest-a", "guest"),
    peer("guest-b", "guest"),
  ]);
  const direct = `ws://${host}:5678/ws`;
  await Promise.all([
    control(a, { type: "connect", url: direct }),
    control(b, { type: "connect", url: direct }),
  ]);
  const statuses = await Promise.all([
    until(a, (s) => s.messages.length > 0),
    until(b, (s) => s.messages.length > 0),
  ]);
  assert.equal(
    statuses.filter((s) => s.messages.some((m) => m.type === "welcome")).length,
    1,
  );
  assert.equal(
    statuses.filter((s) =>
      s.messages.some((m) => m.type === "error" && m.fatal),
    ).length,
    1,
  );
  const [guest, third] = statuses[0].messages.some((m) => m.type === "welcome")
    ? [a, b]
    : [b, a];
  const oldId = (await until(host, (s) => s.state?.room?.status === "playing"))
    .state.room.game.id;
  await control(host, {
    type: "current",
    message: { type: "move", move: { from: 64, to: 67 } },
  });
  await until(guest, (s) => s.state?.room?.game.ply === 1);
  await control(guest, {
    type: "current",
    message: { type: "move", move: { from: 1, to: 20 } },
  });
  await until(host, (s) => s.state?.room?.game.ply === 2);
  console.log(
    "PASS: two external containers compete atomically; admitted guest and loopback host exchange moves",
  );
  await control(guest, { type: "close" });
  await until(host, (s) => s.state?.room?.game.result?.reason === "aborted");
  await control(third, { type: "connect", url: direct });
  await until(third, (s) =>
    s.messages.some((m) => m.type === "error" && m.message.includes("开放")),
  );
  await control(host, { type: "send", message: { type: "open-lan" } });
  await control(third, { type: "connect", url: direct });
  await until(third, (s) => s.state?.room?.status === "playing");
  await control(host, {
    type: "send",
    message: {
      type: "move",
      gameId: oldId,
      version: 0,
      move: { from: 54, to: 45 },
    },
  });
  await until(host, (s) =>
    s.messages.some((m) => m.type === "error" && m.message.includes("更新")),
  );
  assert.equal((await control(third)).state.room.game.ply, 0);
  await control(host, { type: "close" });
  await until(third, (s) => !s.connected);
  console.log(
    "PASS: disconnect aborts; new visitor cannot take over; old game commands rejected; host loss releases guest",
  );
  await control(host, { type: "host-connect" });
  hostStatus = await until(host, (s) => s.state?.room?.status === "waiting");
  const nginx = `${prefix}-nginx`;
  names.push(nginx);
  await docker(
    "run",
    "-d",
    "--name",
    nginx,
    "--network",
    `container:${host}`,
    "--mount",
    `type=bind,source=${root}/tests/docker/nginx.conf,target=/etc/nginx/nginx.conf,readonly`,
    "nginx:alpine",
  );
  const proxy = `ws://${host}:8080/ws`;
  // Poll nginx readiness through its network namespace, before the assertion.
  await docker("exec", nginx, "nginx", "-t");
  for (let i = 0; i < 80; i++) {
    try {
      await docker(
        "exec",
        host,
        "node",
        "--input-type=module",
        "-e",
        "const r=await fetch('http://127.0.0.1:8080/health');if(!r.ok)process.exit(1)",
      );
      break;
    } catch {
      if (i === 79) throw Error("nginx did not become ready");
      await pause();
    }
  }
  await control(a, { type: "connect", url: proxy, token: hostStatus.token });
  await until(a, (s) =>
    s.messages.some((m) => m.type === "error" && m.message.includes("本机")),
  );
  await control(a, {
    type: "connect",
    url: proxy,
    headers: { "X-Real-IP": "127.0.0.1", "X-Forwarded-For": "127.0.0.1" },
  });
  await until(a, (s) => s.state?.room?.status === "playing");
  await control(a, { type: "current", message: { type: "resign" } });
  await until(host, (s) => s.state?.room?.game.result?.reason === "resign");
  await control(a, { type: "close" });
  assert.equal(
    (await until(host, (s) => s.state?.room?.members.length === 1)).state.room
      .game.result.reason,
    "resign",
  );
  console.log(
    "PASS: nginx shares loopback with application; cannot grant host role; overwrites forged IP; final result survives disconnect",
  );
  console.log("Docker network acceptance passed.");
} finally {
  await Promise.all(
    names.reverse().map((n) => docker("rm", "-f", n).catch(() => {})),
  );
  await docker("network", "rm", network).catch(() => {});
}
