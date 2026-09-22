import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import {
  readConfigFile,
  replaceConfigFiles,
  type ConfigFile,
  type RenameFile,
} from "./config-files.js";
import type {
  McpAgent,
  McpConfiguration,
  AgentConfiguration,
} from "../core/mcp-configuration.js";
const begin = "# BEGIN ink-chess managed MCP",
  end = "# END ink-chess managed MCP";
const autoBackground = "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS";
type ObjectValue = Record<string, any>;
function object(value: unknown, path: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`配置必须为对象：${path}`);
  return value as ObjectValue;
}
function json(file: ConfigFile): ObjectValue {
  try {
    return object(JSON.parse(file.original ?? "{}"), file.path);
  } catch (error) {
    throw Error(`JSON 配置无效：${file.path}：${String(error)}`);
  }
}
function table(root: ObjectValue, key: string, path: string) {
  if (!Object.hasOwn(root, key)) root[key] = {};
  return object(root[key], path);
}
function edited(actual: unknown, previous: unknown, path: string) {
  if (!isDeepStrictEqual(actual, previous))
    throw Error(`托管字段已被用户修改，保留原文件：${path}`);
}
function serialize(file: ConfigFile, value: ObjectValue) {
  if (file.original !== null && isDeepStrictEqual(json(file), value)) return;
  file.next = JSON.stringify(value, null, 2) + "\n";
}
function codexBlock(file: ConfigFile, url: string, prior?: ObjectValue) {
  const text = file.original ?? "";
  let parsed: ObjectValue;
  try {
    parsed = object(parse(text), file.path);
  } catch (e) {
    throw Error(`TOML 配置无效：${file.path}：${String(e)}`);
  }
  const starts = [...text.matchAll(/^# BEGIN ink-chess managed MCP\r?$/gm)];
  const ends = [...text.matchAll(/^# END ink-chess managed MCP\r?$/gm)];
  if (
    (text.includes(begin) || text.includes(end)) &&
    (starts.length !== 1 ||
      ends.length !== 1 ||
      starts[0].index! >= ends[0].index!)
  )
    throw Error(`管理标记异常：${file.path}`);
  const start = starts[0]?.index,
    finish = ends[0] ? ends[0].index! + ends[0][0].length : undefined;
  const outside =
    start === undefined ? text : text.slice(0, start) + text.slice(finish);
  const user = object(parse(outside), file.path);
  if (
    user.mcp_servers &&
    Object.hasOwn(object(user.mcp_servers, file.path), "ink-chess")
  )
    throw Error(`存在非托管同名 ink-chess 配置：${file.path}`);
  const actual = parsed.mcp_servers?.["ink-chess"];
  if (prior) edited(actual, prior.server, file.path);
  if (start !== undefined) {
    const managed = parse(text.slice(start, finish));
    if (
      !actual ||
      !isDeepStrictEqual(managed, { mcp_servers: { "ink-chess": actual } })
    )
      throw Error(`管理区块含有异常内容：${file.path}`);
  }
  const server = {
    url,
    tool_timeout_sec: 1800,
    enabled_tools: ["enter_chess", "wait_for_next_move", "quit_chess"],
  };
  if (!prior && start !== undefined)
    edited(actual, { ...server, url: actual.url }, file.path);
  const block = `${begin}\n[mcp_servers.ink-chess]\nurl = ${JSON.stringify(url)}\ntool_timeout_sec = 1800\nenabled_tools = ["enter_chess", "wait_for_next_move", "quit_chess"]\n${end}`;
  if (!isDeepStrictEqual(actual, server))
    file.next =
      start === undefined
        ? text + (text && !text.endsWith("\n") ? "\n" : "") + block + "\n"
        : text.slice(0, start) + block + text.slice(finish);
  parse(file.next);
  return { installed: start !== undefined, fields: { server } };
}
export function createMcpConfiguration(
  directory: string,
  getUrl: () => string,
  rename?: RenameFile,
) {
  const store = resolve(directory);
  const paths = (agent: McpAgent) =>
    agent === "codex"
      ? [join(store, ".codex/config.toml")]
      : [join(store, ".mcp.json"), join(store, ".claude/settings.json")];
  async function prepare(agent: McpAgent, url: string) {
    const metadata = await readConfigFile(
      store,
      join(store, "ink-chess.settings.json"),
    );
    const settings = json(metadata);
    if (metadata.original !== null && settings.schemaVersion !== 1)
      throw Error(`配置版本无效：${metadata.path}`);
    const installations = table(settings, "mcpInstallations", metadata.path);
    const prior = Object.hasOwn(installations, agent)
      ? object(installations[agent], metadata.path)
      : undefined;
    const files = await Promise.all(
      paths(agent).map((path) => readConfigFile(store, path)),
    );
    let installed: boolean, fields: ObjectValue;
    if (agent === "codex")
      ({ installed, fields } = codexBlock(files[0], url, prior));
    else {
      const config = json(files[0]),
        servers = table(config, "mcpServers", files[0].path);
      const prefs = json(files[1]),
        env = table(prefs, "env", files[1].path);
      const actual = servers["ink-chess"];
      if (prior) {
        edited(actual, prior.server, files[0].path);
        edited(env[autoBackground], prior.autoBackground, files[1].path);
      } else {
        if (Object.hasOwn(servers, "ink-chess"))
          throw Error(`存在非托管同名 ink-chess 配置：${files[0].path}`);
        if (Object.hasOwn(env, autoBackground) && env[autoBackground] !== "0")
          throw Error(`已有不同的等待设置，保留原文件：${files[1].path}`);
      }
      installed = !!prior;
      const server = { type: "http", url, timeout: 1800000 };
      servers["ink-chess"] = server;
      env[autoBackground] = "0";
      serialize(files[0], config);
      serialize(files[1], prefs);
      fields = { server, autoBackground: "0" };
    }
    const status: AgentConfiguration["status"] = !installed
      ? "not_configured"
      : files.some((f) => f.next !== f.original)
        ? "needs_update"
        : "configured";
    settings.schemaVersion = 1;
    installations[agent] = fields;
    serialize(metadata, settings);
    return { files: [...files, metadata], status };
  }
  async function inspect(): Promise<McpConfiguration> {
    const url = getUrl();
    const agents = {} as McpConfiguration["agents"];
    for (const agent of ["codex", "claude"] as const) {
      try {
        agents[agent] = {
          status: (await prepare(agent, url)).status,
          paths: paths(agent),
        };
      } catch (error) {
        agents[agent] = {
          status: "conflict",
          paths: paths(agent),
          error: String(error),
        };
      }
    }
    return { store, url, agents };
  }
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  }
  return {
    read: () => serial(inspect),
    install: (agent: McpAgent) =>
      serial(async () => {
        const prepared = await prepare(agent, getUrl());
        await replaceConfigFiles(store, prepared.files, rename);
        return inspect();
      }),
  };
}
/** Compatibility entrypoint for existing harness tests. */
export async function writeMcpConfig(
  store: string,
  url: string,
): Promise<string> {
  await createMcpConfiguration(store, () => url).install("codex");
  return join(resolve(store), ".codex/config.toml");
}
