# 排错指南

## 页面打不开

如果只是检查 UI mock，先确认本地预览是否启动：

```powershell
npm run preview:start
```

如果端口被占用，脚本会尝试 `5173`、`5174`、`5175`、`5180`、`3000`、`3001`。

如果要检查真实本地 Web 后端，先构建并启动后端：

```powershell
npm run build
npm run backend:build
npm run backend:dev -- --port 47832
```

然后打开：

```text
http://127.0.0.1:47832/
```

## 构建失败

重新安装依赖并构建：

```powershell
npm ci
npm run build
```

## Tauri/Rust 检查失败

确认 Rust 工具链可用：

```powershell
cargo --version
cargo check --manifest-path src-tauri/Cargo.toml
```

## provider 切换失败

不要直接手工覆盖 `config.toml` 或 `auth.json`。先确认是否已有备份和恢复路径。涉及真实 Codex provider 切换时，应使用新会话或另一个 agent 执行最终 cutover。

## 不要提交的信息

不要把真实 API key、`auth.json`、真实 `profiles.json`、备份目录、截图或本机私有日志贴到 Issue、PR 或公开文档里。
