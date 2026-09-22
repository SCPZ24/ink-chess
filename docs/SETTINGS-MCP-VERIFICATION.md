# 设置页 MCP 接入验收记录

日期：2026-09-23。工作区：`/Users/zytwd/Code/GoodLooks/ChineseChess`。
Node 22.23.2、Codex CLI / app-server 0.153.4、Claude Code 2.1.220、Chromium。
在当前工作区独立实施，未分配子 Agent，未发布 npm，未修改用户级 Agent 配置。

## 自动化与安装包

| 检查 | 结果与范围 |
| --- | --- |
| `npm test` | 10 个文件、87 项通过；保留规则、网络、交接与 HTTP MCP 检查 |
| `npm run build` | TypeScript、Vite 与服务端构建通过 |
| `npm run test:e2e` | 9 项通过；设置页安装前后棋盘标识、已有棋谱和后续行棋不变 |
| `npm run test:package` | tarball 安装后真实浏览器点击两个添加按钮；local、LAN、server、旧参数兼容、IPv6 通过 |
| 配置事务 | 同时添加两种 Agent、重复请求、显式地址更新、保留其他字段、不重复写入；后续替换失败回滚，回滚失败报告逐项状态 |
| 配置保护 | 非托管同名、用户修改托管字段（含无元数据的旧 Codex 区块）、损坏 JSON/TOML、符号链接、只读与全局目标拒绝 |
| API 边界 | 只接受固定 agent；跨站、代理头、非 JSON、额外路径字段拒绝；非 loopback local、LAN、server 不开放配置接口 |
| 数据边界 | 普通启动不写配置；配置错误不影响游戏且不阻止再次启动；包目录只读且哈希不变，配置只在 store，HTTP 不暴露配置 |

Playwright 浏览器路径：`PLAYWRIGHT_BROWSERS_PATH=/private/tmp/ink-chess-browsers`。
默认、相对、中文空格路径和 IPv4/IPv6 由原有配置与安装包测试覆盖。
设置页桌面和 390px 窄屏截图在 `test-results/settings-mcp-desktop.png` 与
`test-results/settings-mcp-mobile.png`，已人工查看。

## 真实 Codex

运行更新后的 `scripts/test-codex-mcp.mjs`，通过配置接口生成项目配置。
实际 app-server 完成以下检查：

- 下棋项目发现三个工具；独立兄弟项目没有 ink-chess 工具。
- 工具挂起 65 秒后，人类通过浏览器落子，返回中文棋谱。
- 真实模型通过测试 browser use 工具读取页面并点击，连续完成两个回合。
- 页面“退出 AI 对弈”结束等待并恢复操作；用户级配置前后字节一致。

**已知失败仍保留：** `turn/interrupt` 结束模型回合，但没有 MCP 取消通知或等待 HTTP 关闭。
日志中的 `MCP activity after interrupt: []` 说明服务未收到取消信号；脚本因此退出 1，
没有将其他通过项包装为整个 harness 验收通过。停止 Agent 后应使用页面退出入口恢复。
详细机制与复现方法参见 [MCP 文档](MCP.md) 和 [原阶段记录](MCP-VERIFICATION.md)。

## 真实 Claude Code 与待验收项

`claude auth status --json` 返回 `loggedIn: false`、`authMethod: none`。
使用真实 Claude CLI，在临时下棋目录通过接口生成配置，再分别执行 `claude mcp list`：

```text
下棋目录：ink-chess: http://127.0.0.1:<实际端口>/mcp (HTTP) - Pending approval
独立目录：No MCP servers configured.
```

检查使用临时 `CLAUDE_CONFIG_DIR`，避免写入实际用户级配置；结束后删除临时目录。
这证明项目配置被 CLI 正确发现且不会出现在独立目录，**不证明用户已批准、模型已连接或长等待已通过**。
未自动登录、未添加权限白名单、未安装浏览器扩展。

具备已登录的交互式 Claude Code 和可用 browser use 后，仍须完成：

1. 在 store 打开并信任项目，批准 ink-chess；确认三个工具可用，另一个项目不可见。
2. 通过同一页面连续交接，工具中文结果触发后续模型调用。
3. 一次真实交互等待超过 **310 秒**，越过两分钟后台化和五分钟空闲阈值后再由人类落子。
4. 分别验证取消、客户端退出和页面退出；确认权限收回、结果重放与普通对弈恢复。

不能用 SDK 模拟或 `claude -p` 代替上述交互验收。

**当前状态：设置页功能、自动化和安装包已完成；全部真实客户端完成标准尚未满足。**
剩余项是已知 Codex 取消传播问题，以及 Claude 登录和浏览器工具就绪后的交互验收。
