export type McpAgent = "codex" | "claude";
export interface AgentConfiguration {
  status: "not_configured" | "configured" | "needs_update" | "conflict";
  paths: string[];
  error?: string;
}
export interface McpConfiguration {
  store: string;
  url: string;
  agents: Record<McpAgent, AgentConfiguration>;
}
export interface ConfigurationFileState {
  path: string;
  state: "unchanged" | "restored" | "changed" | "unknown";
  error?: string;
}
