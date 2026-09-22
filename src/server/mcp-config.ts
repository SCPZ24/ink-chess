import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  realpath,
  lstat,
} from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
const begin = "# BEGIN ink-chess managed MCP",
  end = "# END ink-chess managed MCP";
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await canonical(parent), basename(path));
  }
}
async function noLink(path: string) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw Error(`配置路径不能是符号链接：${path}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
/** Writes only the explicitly managed project stanza, never user Codex config. */
export async function writeMcpConfig(
  store: string,
  url: string,
): Promise<string> {
  const dir = join(resolve(store), ".codex"),
    file = join(dir, "config.toml");
  const target = await canonical(file);
  const globalFiles = [join(homedir(), ".codex/config.toml")];
  if (process.env.CODEX_HOME)
    globalFiles.push(join(resolve(process.env.CODEX_HOME), "config.toml"));
  for (const global of globalFiles)
    if (target === (await canonical(global)))
      throw Error("拒绝写入全局 Codex 配置，请使用独立下棋目录作为 --store。");
  await noLink(dir);
  await noLink(file);
  await mkdir(dir, { recursive: true });
  let original = "",
    existed = false,
    mode = 0o600;
  try {
    original = await readFile(file, "utf8");
    existed = true;
    mode = (await lstat(file)).mode & 0o777;
    if ((mode & 0o222) === 0) throw Error("Codex项目配置不可写");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  parse(original);
  const starts = [...original.matchAll(/^# BEGIN ink-chess managed MCP\r?$/gm)];
  const ends = [...original.matchAll(/^# END ink-chess managed MCP\r?$/gm)];
  const hasMarker = original.includes(begin) || original.includes(end);
  if (
    hasMarker &&
    (starts.length !== 1 ||
      ends.length !== 1 ||
      starts[0].index! >= ends[0].index!)
  )
    throw Error("Codex配置的ink-chess管理标记异常，保留原文件。");
  const start = starts[0]?.index,
    finish = ends[0] ? ends[0].index! + ends[0][0].length : undefined;
  const outside =
    start === undefined
      ? original
      : original.slice(0, start) + original.slice(finish);
  const user = parse(outside) as { mcp_servers?: Record<string, unknown> };
  if (user.mcp_servers && Object.hasOwn(user.mcp_servers, "ink-chess"))
    throw Error("存在非本程序管理的 ink-chess MCP 配置，保留原文件。");
  const block = `${begin}\n[mcp_servers.ink-chess]\nurl = ${JSON.stringify(url)}\ntool_timeout_sec = 1800\nenabled_tools = ["enter_chess", "wait_for_next_move", "quit_chess"]\n${end}`;
  const next =
    start === undefined
      ? original +
        (original.endsWith("\n") || !original ? "" : "\n") +
        block +
        "\n"
      : original.slice(0, start) + block + original.slice(finish);
  parse(next);
  if (next === original) return file;
  const temp = join(dir, `.ink-chess-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, next, { flag: "wx", mode });
    await noLink(file);
    if (existed) {
      if ((await readFile(file, "utf8")) !== original)
        throw Error("Codex配置在生成过程中被修改，请重试。");
    } else {
      try {
        await lstat(file);
        throw Error("Codex配置在生成过程中被创建，请重试。");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
  return file;
}
