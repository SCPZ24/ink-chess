import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import {
  initialGame,
  applyMove,
  legalMoves,
  offerDraw,
  respondDraw,
  type GameState,
} from "../../src/core/game.js";
import type { LocalView } from "../../src/core/local-protocol.js";

// Seed valid, reproducible long games through the same engine used by the app.
function longGame() {
  let game = initialGame(),
    seed = 42;
  while (game.ply < 100 && !game.result) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const moves = legalMoves(game);
    game = applyMove(game, moves[seed % moves.length]);
  }
  return game;
}
async function localSnapshot(page: Page, game: GameState) {
  let socket!: WebSocketRoute;
  const view: LocalView = {
    type: "local-state",
    boardId: "layout-test-board",
    game,
    revision: 0,
    canMove: true,
    allowedActions: [
      "move",
      "resign",
      "offer-draw",
      "accept-draw",
      "decline-draw",
      "quit-ai",
    ],
    ai: null,
  };
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { mode: "local", mcp: true, version: "test" } }),
  );
  await page.routeWebSocket("**/local-ws", (ws) => {
    socket = ws;
    ws.send(JSON.stringify(view));
  });
  await page.goto("/");
  await expect(page.locator(".match-status")).toContainText(`51`);
  return {
    view,
    socket,
    update: () =>
      socket.send(JSON.stringify({ ...view, revision: ++view.revision })),
  };
}

const sizes = [
  [1440, 900],
  [1920, 1080],
  [1280, 720],
  [390, 844],
  [375, 667],
  [320, 568],
  [844, 390],
  [800, 800],
];
for (const [width, height] of sizes) {
  test(`fixed frame and complete board at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.getByTestId("square-64")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    const frame = await page.locator(".app").boundingBox();
    const board = await page.getByTestId("board").boundingBox();
    expect(frame).not.toBeNull();
    expect(board).not.toBeNull();
    expect(frame!.width / frame!.height).toBeCloseTo(
      width >= height ? 16 / 9 : 9 / 16,
      2,
    );
    expect(Math.abs(frame!.x + frame!.width / 2 - width / 2)).toBeLessThan(1);
    expect(Math.abs(frame!.y + frame!.height / 2 - height / 2)).toBeLessThan(1);
    expect(board!.width / board!.height).toBeCloseTo(620 / 684, 2);
    expect(board!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(board!.y).toBeGreaterThanOrEqual(frame!.y);
    expect(board!.x + board!.width).toBeLessThanOrEqual(
      frame!.x + frame!.width + 1,
    );
    expect(board!.y + board!.height).toBeLessThanOrEqual(
      frame!.y + frame!.height + 1,
    );
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    expect(overflow.width).toBeLessThanOrEqual(width);
    expect(overflow.height).toBeLessThanOrEqual(height);
    if (width < height) {
      for (const selector of [
        ".records-panel",
        ".capture-section",
        ".match-intro",
        ".quiet-note",
        ".page-footer",
        ".connection-note",
      ]) {
        await expect(page.locator(selector)).toBeHidden();
      }
      await expect(page.locator(".player-card")).toHaveCount(2);
      await expect(page.locator(".match-status")).toContainText("红方行棋");
    } else {
      await expect(page.locator(".records-panel")).toBeVisible();
    }
    await page.getByTestId("square-64").click();
    await page.getByTestId("square-67").click();
    await expect(page.locator(".match-status")).toContainText("黑方行棋");
    await page.getByRole("button", { name: "偏好设置" }).click();
    await page.getByLabel("招式动画").uncheck();
    await page.getByRole("button", { name: "完成设置" }).click();
  });
}

test("rotation preserves selection, moves and preferences; portrait can finish a game", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("square-64").click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("square-67")).toHaveAttribute(
    "data-legal",
    "true",
  );
  await page.getByTestId("square-67").click();
  await expect(page.locator(".match-status")).toContainText("黑方行棋");
  await page.getByRole("button", { name: "翻转棋盘" }).click();
  await expect(page.getByTestId("board")).toHaveAttribute(
    "data-flipped",
    "true",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("move-0")).toBeVisible();
  await expect(page.getByTestId("move-0")).toContainText("炮八平五");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.getByRole("button", { name: "认输", exact: true }).click();
  await page.getByRole("button", { name: "确认认输" }).click();
  await expect(page.getByTestId("result")).toContainText("红方获胜");
  await page.getByRole("button", { name: "再来一局" }).click();
  await expect(page.getByTestId("result")).toHaveCount(0);
  await expect(page.locator(".match-status")).toContainText("红方行棋");
});

test("long notation scrolls internally and catches up after portrait moves", async ({
  page,
}) => {
  const { view, update } = await localSnapshot(page, longGame());
  const list = page.locator(".records-scroll");
  const remaining = () =>
    list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect.poll(remaining).toBeLessThan(2);
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  );
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list).toBeHidden();
  view.game = applyMove(view.game, legalMoves(view.game)[0]);
  update();
  await expect(page.locator(".match-status")).toContainText("黑方行棋");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("move-100")).toBeInViewport();
  await expect.poll(remaining).toBeLessThan(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(
    900,
  );
  await expect(page.getByTestId("board")).toBeInViewport({ ratio: 1 });
});

test("portrait keeps warnings, draw responses and interrupted AI controls inside the frame", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const { view, socket, update } = await localSnapshot(page, longGame());
  const before = await page.getByTestId("board").boundingBox();
  view.game.warning = {
    side: "red",
    remaining: 3,
    reason: "请变着，避免循环不变作和",
    keys: [],
  };
  view.game.notice = "请留意当前棋局规则提示。";
  update();
  socket.onMessage((raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === "offer-draw")
      view.game = offerDraw(view.game, view.game.turn);
    if (message.type === "decline-draw")
      view.game = respondDraw(view.game, "black", false);
    if (message.type === "accept-draw")
      view.game = respondDraw(view.game, "black", true);
    update();
  });
  await page.getByRole("button", { name: "提和", exact: true }).click();
  await expect(page.getByRole("button", { name: "同意和棋" })).toBeInViewport();
  await expect(page.getByText("请留意当前棋局规则提示。")).toBeVisible();
  const after = await page.getByTestId("board").boundingBox();
  expect(after!.height).toBeLessThan(before!.height);
  expect(after!.width / after!.height).toBeCloseTo(620 / 684, 2);
  await page.screenshot({ path: "test-results/mobile-warnings.png" });
  await page.getByRole("button", { name: "继续对弈" }).click();
  await expect(page.locator(".draw-offer")).toHaveCount(0);
  await page.getByRole("button", { name: "提和", exact: true }).click();
  await page.getByRole("button", { name: "同意和棋" }).click();
  await expect(page.getByTestId("result")).toContainText("和棋");
  view.game = longGame();
  view.ai = { side: "black", phase: "paused" };
  view.canMove = false;
  update();
  await expect(page.getByTestId("ai-phase")).toHaveText("交接已暂停");
  await expect(
    page.getByRole("button", { name: "退出 AI 对弈" }),
  ).toBeInViewport();
  await socket.close();
  await expect(page.locator(".connection-note")).toContainText(
    "棋盘连接已断开",
  );
  await expect(page.locator(".connection-note")).toBeInViewport();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "关闭提示" }).click();
  await expect(page.getByTestId("square-64")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight),
  ).toBeLessThanOrEqual(568);
});
