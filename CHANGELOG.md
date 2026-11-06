# Changelog

## v1.3.0 — 2026-11-06

- 新增强（可选）：**跨 OS 迁移纯 JS 插件代码**。高级设置新增「跨 OS 恢复插件代码」选项（`skip` 默认 / `js` 实验性）；Host 对每个 plugin-code 目录做保守分类（拒绝原生二进制、符号链接、`os/cpu` 不匹配、`gypfile`、未知扩展、超限目录），通过的写回，其余跳过并写 warnings。
- 修复 Windows → Linux 兼容恢复：profile `package.json` 中旧机绝对 `link:/file:` 依赖清理；跨 OS `$WORKSPACE:`/盘符路径 fallback 到 `restore-external`；解包权限兜底（Windows 0666 目录在 POSIX 补 read/exec 位）。
- 测试：81 项本地单测；Linux 真机 + Windows 真机验证跨 OS 恢复与纯 JS 迁移。

## v1.2.0 — 2026-11-06

- 新增 **Windows → Linux 兼容恢复**（`compat-windows-to-linux`），四场景全部可执行；`blocked` 仅保留为未来兜底。

## v1.1.0 — 2026-11-06

- 跨平台快照：manifest 记录 OS，文件名带 `-linux` / `-windows`；Windows 平台适配（路径、命令、ACL、符号链接降级）。
- 新增「引入快照」「每卡片导出」和 Windows 蓝 / Linux 橙 / 旧版灰 OS 徽章。
- 跨 OS 兼容性矩阵（Linux→Windows）；`restore_compare` 返回 `compatibility`，Host 强制执行 restrictions。
- 快照/恢复提示词改为完全泛型，支持跨 OS 恢复文档。

## v1.0.2 — 2026-11-05

- 修复 Esc 关闭设置、UI 下拉在 Android WebView 的交互、若干恢复路径与安全加固。

## v1.0.1 — 2026-11-05

- 首个可用版本：AI 驱动的快照/恢复、tar+Brotli 高压缩、悬浮进度球、记录管理。

## v1.0.0 — 2026-11-05

- 初始版本。
