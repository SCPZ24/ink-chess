import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createGameServer } from "../../src/server/app.js";
import type { ChessEvent } from "../../src/core/local-protocol.js";
let app: ReturnType<typeof createGameServer>, client: Client, url: string;
test.beforeEach(async () => {
  app = createGameServer(
    {
      mode: "local",
      mcp: true,
      port: 0,
      host: "127.0.0.1",
      store: "/private/tmp",
      trustedProxy: [],
    },
    fileURLToPath(new URL("../../dist/web/", import.meta.url)),
  );
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  client = new Client({ name: "browser-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url + "/mcp")),
  );
});
test.afterEach(async () => {
  await client?.close();
  await app?.close();
});
test("human and AI alternate through actual board clicks, wait locks one move, and exit keeps position", async ({
  page,
}) => {
  await page.goto(url);
  const id = page.getByTestId("board-id");
  await expect(id).toBeVisible();
  const boardId = await id.textContent();
  const s = (
    await client.callTool({
      name: "enter_chess",
      arguments: { board_id: boardId, ai_side: "red" },
    })
  ).structuredContent as ChessEvent;
  await expect(page.getByTestId("ai-phase")).toHaveText("AI 行棋");
  await page.getByTestId("square-64").click();
  await page.getByTestId("square-67").click();
  await expect(page.getByTestId("move-0")).toContainText("炮八平五");
  await expect(page.getByTestId("ai-phase")).toHaveText("等待 AI 交接");
  await expect(page.getByTestId("square-1")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.getByTestId("square-1").click({ force: true });
  await page.getByTestId("square-20").click({ force: true });
  await expect(page.getByTestId("move-1")).toHaveText("—");
  const waiting = client.callTool({
    name: "wait_for_next_move",
    arguments: { session_id: s.session_id, after_event_seq: 0 },
  });
  await expect(page.getByTestId("ai-phase")).toHaveText("轮到你了");
  await page.screenshot({
    path: "test-results/mcp-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole("button", { name: "退出 AI 对弈" }),
  ).toBeVisible();
  await expect(page.getByTestId("ai-phase")).toHaveText("轮到你了");
  await expect(page.locator(".records-panel")).toBeHidden();
  await expect(page.getByTestId("board-id")).toBeHidden();
  await page.getByRole("button", { name: "偏好设置" }).click();
  await expect(page.getByRole("dialog").getByTestId("board-id")).toBeVisible();
  await expect(page.getByRole("dialog").getByTestId("board-id")).toHaveText(
    boardId!,
  );
  await page.getByRole("button", { name: "完成设置" }).click();
  await page.screenshot({
    path: "test-results/mcp-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("square-1").click();
  await page.getByTestId("square-20").click();
  expect((await waiting).structuredContent).toMatchObject({
    notation: "马2进3",
  });
  await expect(page.getByTestId("ai-phase")).toHaveText("AI 行棋");
  await page.getByRole("button", { name: "退出 AI 对弈" }).click();
  await expect(page.getByTestId("ai-phase")).toHaveCount(0);
  await expect(page.getByTestId("move-1")).toContainText("马2进3");
  await page.getByTestId("square-54").click();
  await page.getByTestId("square-45").click();
  await expect(page.getByTestId("move-2")).toContainText("兵九进一");
});
test("black AI waits first, cancellation locks the page and refresh invalidates the session", async ({
  page,
}) => {
  await page.goto(url);
  const id = page.getByTestId("board-id");
  await expect(id).toBeVisible();
  const boardId = await id.textContent();
  const s = (
    await client.callTool({
      name: "enter_chess",
      arguments: { board_id: boardId },
    })
  ).structuredContent as ChessEvent;
  await expect(page.getByTestId("ai-phase")).toHaveText("等待 AI 交接");
  const abort = new AbortController();
  const waiting = client
    .callTool(
      {
        name: "wait_for_next_move",
        arguments: { session_id: s.session_id, after_event_seq: 0 },
      },
      { signal: abort.signal },
    )
    .catch((e) => e);
  await expect(page.getByTestId("ai-phase")).toHaveText("轮到你了");
  abort.abort();
  await waiting;
  await expect(page.getByTestId("ai-phase")).toHaveText("交接已暂停");
  await page.reload();
  await expect(id).toBeVisible();
  expect(await id.textContent()).not.toBe(boardId);
  const ended = await client.callTool({
    name: "wait_for_next_move",
    arguments: { session_id: s.session_id, after_event_seq: 0 },
  });
  expect(ended.structuredContent).toMatchObject({ status: "session_ended" });
  await expect(page.getByTestId("ai-phase")).toHaveCount(0);
});
