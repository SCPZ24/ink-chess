import { test, expect } from "@playwright/test";
test("plays a local game, records notation, shows tactics and finishes on resignation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "水墨象棋" })).toBeVisible();
  await page.getByTestId("square-64").click();
  await expect(page.getByTestId("square-67")).toHaveAttribute(
    "data-legal",
    "true",
  );
  await page.getByTestId("square-67").click();
  await expect(page.getByTestId("move-0")).toContainText("炮八平五");
  await expect(page.getByTestId("tactic")).toContainText("当头炮");
  await page.getByTestId("square-1").click();
  await page.getByTestId("square-20").click();
  await expect(page.getByTestId("move-1")).toContainText("马2进3");
  await page.getByRole("button", { name: "认输", exact: true }).click();
  await page.getByRole("button", { name: "确认认输" }).click();
  await expect(page.getByTestId("result")).toContainText("黑方获胜");
  await page.getByRole("button", { name: "再来一局" }).click();
  await expect(page.getByTestId("move-0")).toHaveCount(0);
});
test("centers the board, flips correctly and fits small viewports", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("board").waitFor();
  const b = await page.getByTestId("board").boundingBox();
  expect(Math.abs(b!.x + b!.width / 2 - 720)).toBeLessThan(3);
  await page.getByRole("button", { name: "翻转棋盘" }).click();
  await expect(page.getByTestId("board")).toHaveAttribute(
    "data-flipped",
    "true",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
test("persists preferences in cookies and can disable effects", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "偏好设置" }).click();
  await page.getByLabel("招式动画").uncheck();
  await page.getByLabel("行棋音效").uncheck();
  await page.getByRole("button", { name: "完成设置" }).click();
  expect(
    (await context.cookies()).some((c) => c.name === "ink_chess_preferences"),
  ).toBe(true);
  await page.reload();
  await page.getByTestId("square-64").click();
  await page.getByTestId("square-67").click();
  await expect(page.getByTestId("move-0")).toContainText("炮八平五");
  await expect(page.getByTestId("tactic")).toHaveCount(0);
});
test("renders bundled calligraphy with no page errors and preserves desktop/mobile previews", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByTestId("board").waitFor();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check("20px MaShan"))).toBe(
    true,
  );
  await page.screenshot({
    path: "docs/screenshots/desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/screenshots/mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
