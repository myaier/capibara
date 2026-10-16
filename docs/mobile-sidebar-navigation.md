# 手机点击观测台无反应

修复版本：`2.19.0-dev.8`。基线：`2.19.0-dev.7`。范围仅限插件。

## 原因

用户反馈为「点了观测台没反应」。线上入口通过 `hostRegistry.openScreen` 调用注册时保存的 `client.openScreen`，这条路径只推入新路由。手机的侧栏是覆盖在页面上的抽屉，跳转后仍停留在前景，因此用户看不到已打开的目标页面。

核对 Paseo `v0.11.2` 的实际调用关系：

- `packages/app/src/components/left-sidebar.tsx` 将 `closeSidebar` 传给 `SidebarNavRows.onBeforeNavigate`。
- `packages/app/src/plugins/sidebar-items/index.tsx` 提供的 `props.openScreen` 会关闭弹层、调用 `onBeforeNavigate`，再跳转，并记住目标主机。
- `packages/app/src/plugins/navigation.ts` 的普通 `openSurface` 只执行路由跳转。

角标弹层的 UI 分片也覆盖了宿主传入的 `openScreen`，存在同样的问题。此问题与插件目录尚未加载时的 `This plugin surface is unavailable.` 不同。

## 修改

- 三个侧栏入口统一保留宿主传入的 `props.openScreen`，只转换目标 screen ID。
- 角标弹层同样使用宿主回调，关闭弹层和侧栏后显示观测台。
- 保留现有主机专属 screen ID 和实体来源，跨主机会话仍从原主机读取。
- 没有修改 Paseo 宿主或添加宿主补丁。

## 验证

`tests/sidebar-navigation.test.ts` 编译并执行真实的插件入口和 UI 分片，模拟宿主 SDK 的导航回调。旧版两个用例均失败，修复后通过；覆盖三个侧栏入口，以及弹层内跨主机会话跳转。它验证回调与路由契约，不代表物理手机触控验收。

发布前通过类型检查、1,096 项单测、395 项界面回归（含 390 与 320 像素触控视口）、6 项发布包测试、Hermes 编译和发布文件哈希检查。物理手机尚未验收；安装结果在发布完成后另行记录。

物理手机复测步骤：更新所连接主机的插件后，重新打开手机上的 Paseo；从侧栏分别进入「Agent 观测台」「已归档会话」「定时运行」，侧栏应自动关闭并显示目标内容；再从需要处理角标进入观测台，确认弹层与侧栏都关闭。
