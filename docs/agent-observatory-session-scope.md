# Agent Observatory 会话范围排查（2.16.0 历史记录）

后续更新：Capibara 2.17.0 已实现跨主机会话与归档列表。实现和验证口径见 [跨主机视图](multi-host-observatory.md)。下文保留首次排查时的事实，不代表当前版本仍只有单主机列表。

排查日期：2026-10-15。审查源码：上游 `22941e0`，Agent Observatory `2.16.0`。

## 结论

当前看到的主要问题是**单主机数据范围没有在界面中说明，且没有跨主机汇总功能**。没有复现“同一主机只读第一页”的问题。

观测台读取当前插件所属 Paseo 主机的会话。桌面左侧同时展示其他主机的工作区，容易让人把观测台也理解成全局列表。把时间范围改成“全部”不能让其他主机的会话出现。

## 现场证据

- Paseo 桌面当前观测台路由属于远端主机，顶部显示 2 个会话；打开的会话使用 Windows 路径。
- Mac 本地 daemon 是 Paseo `0.11.2`，主机 ID 与上述观测台路由不同。
- `paseo plugin ls --json` 在 Mac 本地返回空列表；不能据此判断远端插件的安装状态。
- `paseo ls -g --json` 在 Mac 本地列出 9 个未归档会话。
- 用本仓库 `createAgentDirectory` 原样连接 Mac 的真实 daemon，再执行 `withinRange(agent, "7d")`，结果为：

  ```json
  {"agents":9,"recent7Days":9,"error":null,"truncated":false,"providers":["codex","claude"]}
  ```

上述调用只读会话目录，没有发送消息、导入会话或重启 daemon。会话数量是排查时的快照。未读取远端安装文件，因此没有确认远端安装版本与本次审查提交完全一致；现场现象与该版本的单主机设计一致。

## 代码路径

| 环节 | 源码 | 行为 |
| --- | --- | --- |
| 会话数据源 | [`client/use-observatory.ts`](../paseo/plugins/dashbord/client/use-observatory.ts) | `usePaseo()` 获取当前连接，`paseo.agents.list()` 只读取该连接；目录按连接对象隔离。 |
| 分页与订阅 | [`shared/directory-store.ts`](../paseo/plugins/dashbord/shared/directory-store.ts) | 每页最多 200 条，沿 `nextCursor` 翻页；总量上限 2,000 条，并报告截断。订阅初始快照的 `limit: 1` 不等于完整目录只取一条。 |
| 页面范围 | [`client/dashboard.tsx`](../paseo/plugins/dashbord/client/dashboard.tsx) | 缓存、统计、详情和工作区筛选都绑定 `host.id`；当前主机名称没有作为列表范围显示。 |
| 默认筛选 | [`shared/preferences.ts`](../paseo/plugins/dashbord/shared/preferences.ts)、[`shared/time-range.ts`](../paseo/plugins/dashbord/shared/time-range.ts) | 默认最近 7 天；运行中、未读及部分待处理会话不受时间范围隐藏。 |
| 归档 | [`client/dashboard.tsx`](../paseo/plugins/dashbord/client/dashboard.tsx) | 普通页面排除已归档会话；独立归档页面显示它们。 |
| 产品声明 | [`OVERVIEW.md`](../paseo/plugins/dashbord/OVERVIEW.md) | 明确写的是一个 host 上的 Paseo agents。 |

会话列表列举的是 Paseo 管理的会话。Token 日志扫描是另一条数据链路，扫描到了其他工具的日志不代表它们自动成为 Paseo 会话。

## 开发方向

1. 在列表中明确显示主机与有效筛选范围，并提供主机选择。
2. 添加“所有在线主机”视图。当前依赖的 `@getpaseo/plugin@0.11.1` 类型声明已经提供 `useHosts()` 和 `getPaseoClient(serverId)`；上线前仍需在真实桌面运行时验证这两个接口。
3. 聚合记录必须保留 `serverId`，用 `(serverId, agentId)` 作为身份与缓存键。离线和读取失败的主机要单独提示，不能当作零会话。
4. 打开会话要传递正确的 `serverId`。读回执、审批、回复、归档、心跳和详情 RPC 都需要按来源主机路由，不能把其他机器的会话直接混入当前主机的可操作列表。
5. 用两台机器的真实目录对照验收：同名项目、同 ID、断线重连、归档和分页都要覆盖。单元测试或预览数据不代表跨主机现场验收完成。

## 开发构建注意事项

该版本的界面通过已提交的 `server/generated/ui-chunk.txt` 和 `shared/generated/ui-chunk-manifest.ts` 懒加载。直接修改 `client/*.tsx` 后重载插件，不足以证明运行中的界面已更新。

生成文件注明使用 `scripts/build-client-chunks.mjs`，但本次导入的上游仓库没有这个脚本，也没有 README 提到的根目录 `npm run build` / `npm run check`。后续修改界面前，需要补齐可重复的分片构建与校验流程。现有 `preview:build` 仅构建使用虚构数据的开发预览，不会重建生产分片。

## 验证记录

- `npm ci --ignore-scripts --no-audit --no-fund`：依赖安装完成。
- TypeScript `tsc --noEmit`：通过。
- 真实 Mac 目录读取：无错误、无截断；最近 7 天过滤结果一致。
- 全量单元测试首次运行（本机 Node `23.4.0`）：1,158 项，1,155 通过，3 失败。其中两项为该 Node 内置 SQLite 缺少 FTS5；一项为语言服务测试清理临时目录时的 `ENOTEMPTY`。
- 使用 Node `22.23.3` 复核：**1,158 / 1,158 通过，无跳过**。仓库 `.nvmrc` 已固定到此版本；没有改变机器默认 Node。语言目录清理失败本次未复现，不能据此声称其竞态已修复。

本次导入与排查没有替换已安装插件，跨主机汇总尚未实现或部署。
