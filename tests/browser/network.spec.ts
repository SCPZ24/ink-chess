import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { createGameServer } from "../../src/server/app.js";
import type { Mode } from "../../src/core/protocol.js";
let app: ReturnType<typeof createGameServer>, url: string;
async function start(mode: Mode) {
  app = createGameServer(
    {
      mode,
      port: 0,
      host: "127.0.0.1",
      store: "/private/tmp",
      trustedProxy: ["127.0.0.1"],
    },
    fileURLToPath(new URL("../../dist/web/", import.meta.url)),
  );
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw Error("address");
  url = `http://127.0.0.1:${addr.port}`;
}
test.afterEach(async () => {
  await app?.close();
});
test("LAN host and guest synchronize, refuse a third player, and abort on guest loss", async ({
  browser,
}) => {
  await start("lan");
  const hostContext = await browser.newContext(),
    guestContext = await browser.newContext({
      extraHTTPHeaders: { "X-Real-IP": "192.0.2.21" },
    }),
    thirdContext = await browser.newContext({
      extraHTTPHeaders: { "X-Real-IP": "192.0.2.22" },
    });
  try {
    const host = await hostContext.newPage(),
      guest = await guestContext.newPage(),
      third = await thirdContext.newPage();
    for (const [page, path, name] of [
      [host, `${url}/#host=${app.hostToken}`, "主人"],
      [guest, url, "来客"],
      [third, url, "旁观者"],
    ] as const) {
      await page.goto(path);
      await page.getByLabel("昵称").fill(name);
      await page.getByRole("button", { name: "入席", exact: true }).click();
      if (page === host)
        await expect(page.getByText("等待对手", { exact: true })).toBeVisible();
    }
    await expect(third.getByRole("alert")).toContainText("对局已满");
    await host.getByTestId("square-64").click();
    await host.getByTestId("square-67").click();
    await expect(guest.getByTestId("move-0")).toContainText("炮八平五");
    await guest.getByTestId("square-1").click();
    await guest.getByTestId("square-20").click();
    await expect(host.getByTestId("move-1")).toContainText("马2进3");
    await guest.close();
    await expect(host.getByTestId("result")).toContainText("对局中止");
    await host.getByRole("button", { name: "接待新对手" }).click();
    await expect(host.getByText("等待对手", { exact: true })).toBeVisible();
  } finally {
    await Promise.all([
      hostContext.close(),
      guestContext.close(),
      thirdContext.close(),
    ]);
  }
});
test("server lobby creates and joins rooms, swaps sides on mutual rematch", async ({
  browser,
}) => {
  await start("server");
  const ac = await browser.newContext({
      extraHTTPHeaders: { "X-Real-IP": "192.0.2.31" },
      viewport: { width: 390, height: 844 },
    }),
    bc = await browser.newContext({
      extraHTTPHeaders: { "X-Real-IP": "192.0.2.32" },
    });
  try {
    const a = await ac.newPage(),
      b = await bc.newPage();
    for (const [page, name] of [
      [a, "甲方棋手这是一个十六字符长昵称"],
      [b, "乙"],
    ] as const) {
      await page.goto(url);
      await page.getByLabel("昵称").fill(name);
      await page.getByRole("button", { name: "入席", exact: true }).click();
    }
    await a.getByRole("button", { name: "创建房间" }).click();
    await b.getByRole("button", { name: "加入", exact: true }).click();
    await expect(
      a.locator(".player-card strong").filter({ hasText: "甲方棋手" }),
    ).toBeVisible();
    expect(
      await a.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await expect(a.locator(".records-panel")).toBeHidden();
    await a.getByTestId("square-64").click();
    await a.getByTestId("square-67").click();
    await expect(b.getByTestId("move-0")).toContainText("炮八平五");
    await b.getByRole("button", { name: "认输", exact: true }).click();
    await b.getByRole("button", { name: "确认认输" }).click();
    await expect(a.getByTestId("result")).toContainText("红方获胜");
    await a.getByRole("button", { name: "再来一局" }).click();
    await b.getByRole("button", { name: "再来一局" }).click();
    await expect(a.getByTestId("board")).toHaveAttribute(
      "data-flipped",
      "true",
    );
    await expect(b.getByTestId("board")).toHaveAttribute(
      "data-flipped",
      "false",
    );
    await expect(a.getByTestId("result")).toHaveCount(0);
  } finally {
    await Promise.all([ac.close(), bc.close()]);
  }
});
