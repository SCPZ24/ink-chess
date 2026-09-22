import { useEffect, useState } from "react";
import type {
  McpAgent,
  McpConfiguration,
  ConfigurationFileState,
} from "../core/mcp-configuration.js";
const labels = { codex: "Codex", claude: "Claude Code" };
const statuses = {
  not_configured: "尚未添加",
  configured: "已配置",
  needs_update: "需要更新",
  conflict: "配置冲突",
};
const fileStates = {
  unchanged: "未替换",
  restored: "已恢复",
  changed: "仍有本次修改",
  unknown: "需手动检查",
};
export function McpSettings({ enabled }: { enabled: boolean }) {
  const [configuration, setConfiguration] = useState<McpConfiguration | null>(
    null,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState<McpAgent | null>(null);
  const [files, setFiles] = useState<ConfigurationFileState[]>([]);
  async function refresh() {
    const response = await fetch("/api/mcp/configuration");
    const result = await response.json();
    if (!response.ok) throw Error(result.error ?? "无法读取接入设置");
    setConfiguration(result);
  }
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    fetch("/api/mcp/configuration", { signal: abort.signal })
      .then(async (r) => {
        const result = await r.json();
        if (!r.ok) throw Error(result.error ?? "无法读取接入设置");
        if (!abort.signal.aborted) setConfiguration(result);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => abort.abort();
  }, [enabled]);
  async function install(agent: McpAgent) {
    setBusy(true);
    setError("");
    setFiles([]);
    setSuccess(null);
    try {
      const response = await fetch("/api/mcp/configuration", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent }),
      });
      const result = await response.json();
      if (!response.ok) {
        setFiles(result.files ?? []);
        throw Error(result.error ?? "配置写入失败");
      }
      setConfiguration(result);
      setSuccess(agent);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mcp-settings">
      <div className="mcp-heading">
        <h3>AI 对弈接入</h3>
        {enabled && (
          <button
            disabled={busy}
            onClick={() => {
              setError("");
              setSuccess(null);
              void refresh().catch((e) => setError(String(e)));
            }}
          >
            刷新接入状态
          </button>
        )}
      </div>
      {!enabled ? (
        <p>
          AI 接入需要本地模式使用 loopback 地址监听。请使用默认地址 127.0.0.1 或
          ::1 重新启动。
        </p>
      ) : (
        <>
          {configuration ? (
            <>
              <p className="muted">
                配置写入下棋目录。请在对应 Agent 中打开并信任此目录。
              </p>
              <code className="mcp-path" data-testid="mcp-store">
                {configuration.store}
              </code>
              <p className="mcp-address">
                MCP：<code>{configuration.url}</code>
              </p>
              {(["codex", "claude"] as const).map((agent) => {
                const item = configuration.agents[agent],
                  label = labels[agent];
                return (
                  <div
                    className="mcp-agent"
                    key={agent}
                    data-testid={`mcp-${agent}`}
                  >
                    <div className="mcp-heading">
                      <strong>{label}</strong>
                      <span className={`mcp-status ${item.status}`}>
                        {statuses[item.status]}
                      </span>
                    </div>
                    {item.paths.map((path) => (
                      <code className="mcp-path" key={path}>
                        {path}
                      </code>
                    ))}
                    {item.error && <p className="mcp-error">{item.error}</p>}
                    <button
                      disabled={busy || item.status === "configured"}
                      onClick={() => void install(agent)}
                    >
                      {item.status === "configured"
                        ? `${label} 已配置`
                        : item.status === "needs_update"
                          ? `更新 ${label} MCP`
                          : `添加 ${label} MCP`}
                    </button>
                  </div>
                );
              })}
            </>
          ) : (
            <p>正在读取接入设置…</p>
          )}
          {success && (
            <div className="mcp-success" role="status">
              <strong>配置已写入，尚未确认 Agent 连接。</strong>
              <p>
                请在 {labels[success]} 中打开上方下棋目录，信任项目并加载
                MCP。已有任务请重新加载配置或新建任务。
              </p>
              {success === "claude" && (
                <p>
                  已为此项目关闭 MCP 自动后台化。使用浏览器行棋还需登录 Claude
                  Code，并准备 Chrome 扩展或其他 browser use 工具。
                </p>
              )}
            </div>
          )}
          <p className="muted">
            添加 Claude Code 时，也会关闭此下棋项目内 MCP
            调用的自动后台化，便于静默等待落子。浏览器工具和 Agent
            登录需自行准备。
          </p>
          {error && (
            <div className="mcp-error" role="alert">
              <p>{error}</p>
              {files.map((f) => (
                <p key={f.path}>
                  <code>{f.path}</code>：{fileStates[f.state]}
                  {f.error && `（${f.error}）`}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
