import * as fs from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ConfigurationFileState } from "../core/mcp-configuration.js";
export interface ConfigFile {
  path: string;
  original: string | null;
  next: string;
  mode: number;
}
export type RenameFile = (from: string, to: string) => Promise<void>;
async function canonical(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const parent = dirname(path);
    return parent === path
      ? path
      : join(await canonical(parent), basename(path));
  }
}
async function noLink(path: string) {
  try {
    if ((await fs.lstat(path)).isSymbolicLink())
      throw Error(`配置路径不能是符号链接：${path}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
export async function safeConfigPath(store: string, path: string) {
  const target = await canonical(path);
  const globals = [
    join(homedir(), ".codex/config.toml"),
    join(homedir(), ".claude/settings.json"),
    join(homedir(), ".claude.json"),
    join(homedir(), ".mcp.json"),
  ];
  if (process.env.CODEX_HOME)
    globals.push(join(resolve(process.env.CODEX_HOME), "config.toml"));
  if (process.env.CLAUDE_CONFIG_DIR)
    globals.push(join(resolve(process.env.CLAUDE_CONFIG_DIR), "settings.json"));
  if ((await canonical(store)) === (await canonical(homedir())))
    throw Error(`拒绝写入全局配置目录：${store}`);
  for (const global of globals)
    if (target === (await canonical(global)))
      throw Error(`拒绝写入全局配置：${path}`);
  let current = path;
  while (current !== store) {
    await noLink(current);
    const parent = dirname(current);
    if (parent === current) throw Error(`配置路径不在 store 内：${path}`);
    current = parent;
  }
}
export async function contents(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function readConfigFile(
  store: string,
  path: string,
): Promise<ConfigFile> {
  await safeConfigPath(store, path);
  const original = await contents(path);
  const mode = original === null ? 0o600 : (await fs.stat(path)).mode & 0o777;
  if (!(mode & 0o222)) throw Error(`配置不可写：${path}`);
  return { path, original, next: original ?? "", mode };
}
export class ConfigurationWriteError extends Error {
  constructor(
    message: string,
    readonly files: ConfigurationFileState[],
  ) {
    super(message);
  }
}
/** Stage every file before replacing any; retain user edits made during failure recovery. */
export async function replaceConfigFiles(
  store: string,
  candidates: ConfigFile[],
  rename: RenameFile = fs.rename,
) {
  const files = candidates.filter((f) => f.next !== f.original);
  const staged = new Map<ConfigFile, string>(),
    applied: ConfigFile[] = [],
    directories: string[] = [];
  const verify = async (file: ConfigFile) => {
    await safeConfigPath(store, file.path);
    if ((await contents(file.path)) !== file.original)
      throw Error(`配置在写入过程中被修改：${file.path}`);
  };
  const temporary = (file: ConfigFile) =>
    join(dirname(file.path), `.ink-chess-${randomUUID()}.tmp`);
  try {
    for (const file of files) {
      await verify(file);
      const created = await fs.mkdir(dirname(file.path), {
        recursive: true,
        mode: 0o700,
      });
      if (created) directories.push(created);
      const path = temporary(file);
      staged.set(file, path);
      await fs.writeFile(path, file.next, { flag: "wx", mode: file.mode });
    }
    for (const file of files) {
      await verify(file);
      await rename(staged.get(file)!, file.path);
      applied.push(file);
    }
  } catch (error) {
    const states = new Map<ConfigFile, ConfigurationFileState>(
      files.map((f) => [f, { path: f.path, state: "unchanged" }]),
    );
    for (const file of [...applied].reverse()) {
      try {
        await safeConfigPath(store, file.path);
        if ((await contents(file.path)) !== file.next)
          throw Error("文件再次被修改，未覆盖用户内容");
        if (file.original === null) await fs.unlink(file.path);
        else {
          const rollback = temporary(file);
          try {
            await fs.writeFile(rollback, file.original, {
              flag: "wx",
              mode: file.mode,
            });
            await rename(rollback, file.path);
          } finally {
            await fs.unlink(rollback).catch(() => {});
          }
        }
        states.set(file, { path: file.path, state: "restored" });
      } catch (failure) {
        const current = await contents(file.path).catch(() => undefined);
        states.set(file, {
          path: file.path,
          state: current === file.next ? "changed" : "unknown",
          error: String(failure),
        });
      }
    }
    throw new ConfigurationWriteError(
      `配置写入失败：${String(error)}。请检查逐项文件状态。`,
      [...states.values()],
    );
  } finally {
    await Promise.all(
      [...staged.values()].map((path) => fs.unlink(path).catch(() => {})),
    );
    for (const dir of directories.reverse())
      await fs.rmdir(dir).catch(() => {});
  }
}
