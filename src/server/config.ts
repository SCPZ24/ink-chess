import { parseArgs } from "node:util";
import {
  access,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { isIP } from "node:net";
import type { Mode } from "../core/protocol.js";
import { loopback, normalizeIp } from "./identity.js";
export interface Config {
  mode: Mode;
  host: string;
  port: number;
  store: string;
  trustedProxy: string[];
}
export interface Settings {
  schemaVersion: 1;
  mode?: Mode;
  host?: string;
  port?: number;
  trustedProxy?: string[];
}
export function parseFlags(args: string[]) {
  return parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      mode: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      store: { type: "string" },
      "trusted-proxy": { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  }).values;
}
export async function writeSettings(
  store: string,
  settings: Settings,
): Promise<void> {
  const temp = join(store, `.ink-chess-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(settings, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, join(store, "ink-chess.settings.json"));
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function resolveConfig(
  args: string[],
  cwd = process.cwd(),
): Promise<Config> {
  const flags = parseFlags(args),
    store = resolve(cwd, flags.store ?? ".");
  await mkdir(store, { recursive: true });
  const info = await stat(store);
  if (!info.isDirectory() || (info.mode & 0o222) === 0)
    throw new Error(`存储目录不可写：${store}`);
  await access(store, constants.W_OK);
  let settings: Settings = { schemaVersion: 1 };
  try {
    const data: unknown = JSON.parse(
      await readFile(join(store, "ink-chess.settings.json"), "utf8"),
    );
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      (data as Settings).schemaVersion !== 1
    )
      throw new Error("配置版本应为 schemaVersion: 1");
    settings = data as Settings;
    if (
      Object.keys(settings).some(
        (k) =>
          !["schemaVersion", "mode", "host", "port", "trustedProxy"].includes(
            k,
          ),
      )
    )
      throw new Error("配置包含未知字段");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`配置文件无效：${(error as Error).message}`);
  }
  const mode = flags.mode ?? settings.mode ?? "local";
  const port =
    flags.port !== undefined ? Number(flags.port) : (settings.port ?? 5678);
  const host =
    flags.host ?? settings.host ?? (mode === "local" ? "127.0.0.1" : "0.0.0.0");
  const trustedProxy = flags["trusted-proxy"] ?? settings.trustedProxy ?? [];
  if (!["local", "lan", "server"].includes(mode))
    throw new Error("--mode 只能是 local、lan 或 server");
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (flags.port !== undefined && !/^\d+$/.test(flags.port))
  )
    throw new Error("--port 应为 1 至 65535 的整数");
  if (typeof host !== "string" || !isIP(host))
    throw new Error("--host 应为有效 IPv4 或 IPv6 地址");
  if (
    !Array.isArray(trustedProxy) ||
    trustedProxy.some((ip) => typeof ip !== "string" || !isIP(ip))
  )
    throw new Error("--trusted-proxy 应为有效代理 IP，可重复指定");
  if (mode === "lan" && !["0.0.0.0", "::"].includes(host) && !loopback(host))
    throw new Error(
      "lan 模式须保留 loopback 可达性，请绑定 0.0.0.0、:: 或 loopback 地址",
    );
  return {
    mode: mode as Mode,
    host,
    port,
    store,
    trustedProxy: trustedProxy.map(normalizeIp),
  };
}
