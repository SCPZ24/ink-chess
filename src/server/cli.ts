import { parseFlags, resolveConfig } from "./config.js";
import { createGameServer, VERSION } from "./app.js";
import { localAddresses, loopback } from "./identity.js";
import { writeMcpConfig } from "./mcp-config.js";
export async function main(argv = process.argv.slice(2)) {
  let app: ReturnType<typeof createGameServer> | undefined;
  try {
    const flags = parseFlags(argv);
    if (flags.version) {
      console.log(VERSION);
      return;
    }
    if (flags.help) {
      console.log(
        `Ink Chess · 水墨象棋 v${VERSION}\n\n用法：ink-chess [--mode local|lan|server] [--store 路径]\n\n  --mode            默认 local\n  --mcp             启用本机 HTTP MCP，并生成 store 内的项目级 Codex 配置\n  --host            local: 127.0.0.1，其余: 0.0.0.0\n  --port            默认 5678\n  --store           默认当前工作目录，保存轻量配置，不保存棋谱\n  --trusted-proxy   可信代理 IP，可重复指定；代理须覆盖 X-Real-IP\n  --help, -h        帮助\n  --version, -v     版本\n\n昵称与偏好由浏览器 Cookie 保存。联机断线会中止棋局。`,
      );
      return;
    }
    const config = await resolveConfig(argv);
    app = createGameServer(config);
    await new Promise<void>((r, j) => {
      app!.server.once("error", j);
      app!.server.listen(config.port, config.host, r);
    });
    const entry =
      config.host === "0.0.0.0"
        ? "127.0.0.1"
        : config.host === "::"
          ? "::1"
          : config.host;
    const host = entry.includes(":") ? `[${entry}]` : entry;
    if (config.mcp) {
      const url = `http://${host}:${config.port}/mcp`;
      const file = await writeMcpConfig(config.store, url);
      console.log(
        `  MCP：${url}\n  项目配置：${file}\n  请在 Codex 中打开并信任此下棋项目目录：${config.store}\n  已有任务请重新加载 MCP 或新建任务。`,
      );
    }
    console.log(
      `\n  墨 · 棋  INK CHESS  v${VERSION}\n  模式：${config.mode}  存储：${config.store}`,
    );
    console.log(
      `  本机入口：http://${host}:${config.port}/${config.mode === "lan" ? "#host=" + app.hostToken : ""}`,
    );
    const addresses = ["0.0.0.0", "::"].includes(config.host)
      ? localAddresses().filter(
          (a) =>
            !loopback(a) &&
            !a.startsWith("fe80:") &&
            (config.host === "::" || !a.includes(":")),
        )
      : loopback(config.host)
        ? []
        : [config.host];
    if (config.mode !== "local")
      for (const addr of addresses)
        console.log(
          `  来客入口：http://${addr.includes(":") ? "[" + addr + "]" : addr}:${config.port}/`,
        );
    console.log("  按 Ctrl+C 停止。\n");
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      app!.close().catch((e) => {
        console.error(e);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    await app?.close().catch(() => {});
    const e = error as NodeJS.ErrnoException;
    console.error(
      `Ink Chess：${e.code === "EADDRINUSE" ? "端口已被占用，请使用 --port 指定其他端口" : e.message}`,
    );
    process.exitCode = 1;
  }
}
