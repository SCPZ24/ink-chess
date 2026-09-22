// Real installed Codex acceptance. No global config writes; ephemeral test threads.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, rm, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createGameServer } from "../dist/server/app.js";
import { writeMcpConfig } from "../dist/server/mcp-config.js";

// Keep fixtures inside the already trusted repository; CLI trust overrides are
// intentionally insufficient to authorize previously untrusted project files.
await mkdir(join(process.cwd(), ".store"), { recursive: true });
const temp = await realpath(
  await mkdtemp(join(process.cwd(), ".store/ink-codex-acceptance-")),
);
const chess = join(temp, "chess"),
  other = join(temp, "other");
await Promise.all([mkdir(chess), mkdir(other)]);
const globalPath = join(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  "config.toml",
);
const globalBefore = await readFile(globalPath).catch(() => null);
const app = createGameServer({
  mode: "local",
  mcp: true,
  host: "127.0.0.1",
  port: 0,
  store: chess,
  trustedProxy: [],
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const cancelOnly = process.argv.includes("--cancel-only");
const wire = [];
app.server.on("request", (req, res) => {
  if (req.url !== "/mcp") return;
  let data = "";
  req.on("data", (b) => (data += b));
  req.on("end", () => {
    try {
      const m = JSON.parse(data);
      wire.push({ method: m.method, id: m.id, tool: m.params?.name });
    } catch {}
  });
  res.on("close", () =>
    wire.push({ closed: req.method, finished: res.writableFinished }),
  );
});
await writeMcpConfig(chess, origin + "/mcp");
const codex = spawn("codex", ["app-server", "--stdio"], {
  cwd: temp,
  stdio: ["pipe", "pipe", "pipe"],
});
let nextId = 0,
  page;
codex.stderr.resume();
const pending = new Map(),
  notices = [];
createInterface({ input: codex.stdout }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === "item/tool/call") {
    void (async () => {
      try {
        assert.equal(m.params.tool, "browser_use");
        const { action, selector } = m.params.arguments;
        if (action === "click")
          await page.locator(selector).click({ timeout: 5000 });
        const text = await page.locator("body").innerText();
        const squares = await page
          .locator('[data-testid^="square-"]')
          .evaluateAll((nodes) =>
            nodes.map((n) => ({
              selector: `[data-testid="${n.getAttribute("data-testid")}"]`,
              label: n.getAttribute("aria-label"),
              disabled: n.getAttribute("aria-disabled"),
            })),
          );
        codex.stdin.write(
          JSON.stringify({
            id: m.id,
            result: {
              success: true,
              contentItems: [
                { type: "inputText", text: JSON.stringify({ text, squares }) },
              ],
            },
          }) + "\n",
        );
      } catch (error) {
        codex.stdin.write(
          JSON.stringify({
            id: m.id,
            result: {
              success: false,
              contentItems: [{ type: "inputText", text: error.message }],
            },
          }) + "\n",
        );
      }
    })();
  } else if ("id" in m && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    clearTimeout(p.timer);
    m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method) notices.push(m);
});
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`Codex ${method} timeout`));
    }, 150000);
    pending.set(id, { resolve, reject, timer });
    codex.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
const poll = async (fn, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("acceptance condition timed out");
};
let browser;
try {
  await call("initialize", {
    clientInfo: { name: "ink_chess_acceptance", version: "1.0" },
    capabilities: { experimentalApi: true },
  });
  codex.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  const t = await call("thread/start", {
    cwd: chess,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions:
      "You are running a bounded Ink Chess MCP integration test. Follow the user test instructions precisely. Do not write files, run shell commands, or delegate tasks.",
    dynamicTools: [
      {
        type: "function",
        name: "browser_use",
        description:
          "Observe the shared real browser DOM or click a CSS selector on the page. This acceptance fixture uses Playwright mouse clicks, never a move API.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["snapshot", "click"] },
            selector: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
    ],
  });
  const u = await call("thread/start", {
    cwd: other,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const config = await call("config/read", { cwd: chess, includeLayers: true });
  console.log(
    "Project MCP configured:",
    !!config.config?.mcp_servers?.["ink-chess"],
  );
  console.log(
    "Project config layers:",
    JSON.stringify(
      config.layers
        ?.filter((l) => JSON.stringify(l.name).includes(temp))
        .map((l) => ({ name: l.name, disabledReason: l.disabledReason })),
    ),
  );
  const ink = await poll(
    async () =>
      (await call("mcpServerStatus/list", { threadId: t.thread.id })).data.find(
        (s) => s.name === "ink-chess",
      ),
    15000,
  );
  assert(ink, "project-local ink-chess server missing");
  assert.equal(Object.keys(ink.tools).length, 3);
  const outside = await call("mcpServerStatus/list", { threadId: u.thread.id });
  assert(
    !outside.data.some((s) => s.name === "ink-chess"),
    "MCP leaked to unrelated project",
  );
  console.log(
    "PASS: real Codex project-local discovery and unrelated-project isolation",
  );

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(origin);
  const id = page.getByTestId("board-id");
  await id.waitFor();
  if (!cancelOnly) {
    const boardId = await id.textContent();
    const s = await call("mcpServer/tool/call", {
      threadId: t.thread.id,
      server: "ink-chess",
      tool: "enter_chess",
      arguments: { board_id: boardId },
    });
    assert.equal(s.structuredContent.status, "entered");
    const start = Date.now();
    const waiting = call("mcpServer/tool/call", {
      threadId: t.thread.id,
      server: "ink-chess",
      tool: "wait_for_next_move",
      arguments: {
        session_id: s.structuredContent.session_id,
        after_event_seq: 0,
      },
    });
    await poll(
      async () =>
        (await page.getByTestId("ai-phase").textContent()) === "轮到你了",
    );
    console.log(
      "Waiting 65 seconds through real Codex before the human browser move…",
    );
    await new Promise((r) => setTimeout(r, 65000));
    await page.getByTestId("square-64").click();
    await page.getByTestId("square-67").click();
    const result = await waiting;
    assert(Date.now() - start >= 65000);
    assert.equal(result.structuredContent.notation, "炮八平五");
    assert.match(result.structuredContent.message, /你可以继续观察棋盘行棋/);
    await call("mcpServer/tool/call", {
      threadId: t.thread.id,
      server: "ink-chess",
      tool: "quit_chess",
      arguments: { session_id: s.structuredContent.session_id },
    });
    console.log(
      "PASS: real Codex tool wait exceeded 60 seconds and returned the browser move",
    );

    // A real model turn proves the tool result reaches the next model invocation.
    await page.reload();
    await id.waitFor();
    const nextBoard = await id.textContent();
    const playingTurn = await call("turn/start", {
      threadId: t.thread.id,
      input: [
        {
          type: "text",
          text: `执行这个有界MCP验收：调用 ink-chess 的 enter_chess，board_id=${nextBoard}，ai_side=black。然后用返回的会话和游标调用 wait_for_next_move，静默等待测试程序操作人类棋盘。收到第一着后，通过 browser_use 的 snapshot 观察真实棋盘，再用 browser_use 依次点击 [data-testid="square-27"] 和 [data-testid="square-36"]，实际走黑卒1进1。再用最新游标调用 wait_for_next_move 等待第二着。收到后观察页面，再点击 square-29 和 square-38，走黑卒3进1。最后调用 quit_chess。最终只报告收到的两条中文棋谱和提示句。必须通过浏览器点击，不要运行命令。`,
          text_elements: [],
        },
      ],
    });
    await poll(
      async () =>
        (await page.getByTestId("ai-phase").count()) &&
        (await page.getByTestId("ai-phase").textContent()) === "轮到你了",
      120000,
    );
    await page.getByTestId("square-54").click();
    await page.getByTestId("square-45").click();
    await poll(
      async () =>
        (await page.getByTestId("ai-phase").textContent()) === "轮到你了" &&
        (await page.getByTestId("move-1").textContent()).includes("卒1进1"),
      120000,
    );
    await page.getByTestId("square-56").click();
    await page.getByTestId("square-47").click();
    await poll(
      () =>
        notices.find(
          (n) =>
            n.method === "turn/completed" &&
            n.params.turn.id === playingTurn.turn.id,
        ),
      120000,
    );
    const messages = notices
      .filter(
        (n) =>
          n.method === "item/completed" &&
          n.params.item?.type === "agentMessage",
      )
      .map((n) => n.params.item.text)
      .join("\n");
    assert.match(messages, /兵九进一/);
    assert.match(messages, /兵七进一/);
    const observations = notices
      .filter(
        (n) =>
          n.method === "item/completed" &&
          n.params.item?.type === "mcpToolCall" &&
          n.params.item.tool === "wait_for_next_move",
      )
      .map((n) => n.params.item.result);
    assert.equal(observations.length, 2);
    for (const observation of observations)
      assert.match(JSON.stringify(observation), /你可以继续观察棋盘行棋/);
    assert.match(await page.getByTestId("move-3").textContent(), /卒3进1/);
    console.log(
      "PASS: real Codex model received two human moves and played two replies through browser clicks",
    );
  }
  await page.reload();
  await id.waitFor();
  const cancelBoard = await id.textContent();
  const interruptedTurn = await call("turn/start", {
    threadId: t.thread.id,
    input: [
      {
        type: "text",
        text: `继续取消验收：调用 enter_chess 加入棋盘 ${cancelBoard}，执黑；然后调用 wait_for_next_move 静默等待。测试程序会取消本轮，请勿执行其他动作。`,
        text_elements: [],
      },
    ],
  });
  await poll(
    async () =>
      (await page.getByTestId("ai-phase").count()) &&
      (await page.getByTestId("ai-phase").textContent()) === "轮到你了",
    120000,
  );
  const beforeCancel = wire.length;
  await call("turn/interrupt", {
    threadId: t.thread.id,
    turnId: interruptedTurn.turn.id,
  });
  let cancellationFailure;
  try {
    await poll(
      async () =>
        (await page.getByTestId("ai-phase").textContent()) === "交接已暂停",
      15000,
    );
    assert.equal(
      await page.getByTestId("square-54").getAttribute("aria-disabled"),
      "true",
    );
    console.log(
      "PASS: interrupting a real Codex turn cancels the wait and locks the human board",
    );
  } catch {
    cancellationFailure = Error(
      "Codex turn/interrupt did not cancel the MCP wait. This harness acceptance remains FAILED; use the page exit control to recover.",
    );
    console.error(
      "MCP activity after interrupt:",
      JSON.stringify(wire.slice(beforeCancel)),
    );
  }
  await page.getByRole("button", { name: "退出 AI 对弈" }).click();
  await poll(async () => (await page.getByTestId("ai-phase").count()) === 0);
  console.log("PASS: page exit recovers the board after a stopped agent");
  assert.deepEqual(await readFile(globalPath).catch(() => null), globalBefore);
  console.log("PASS: user-level Codex configuration was unchanged");
  if (cancellationFailure) throw cancellationFailure;
} catch (e) {
  console.error("Codex acceptance failed:", e.message);
  // Avoid dumping unrelated configuration or credentials from diagnostic logs.
  console.error(
    "Recent notification methods:",
    notices
      .slice(-10)
      .map((n) => n.method)
      .join(", "),
  );
  throw e;
} finally {
  await browser?.close();
  await app.close();
  for (const p of pending.values()) clearTimeout(p.timer);
  codex.kill("SIGTERM");
  await rm(temp, { recursive: true, force: true });
}
