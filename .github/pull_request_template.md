## 修改内容

- TODO

## 验证

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] 如果改到 Rust/Tauri：`cargo check --manifest-path src-tauri/Cargo.toml`
- [ ] 如果改到界面流程：已运行本地预览和 `npm run qa:smoke`

## 安全检查

- [ ] 没有提交真实 API key、token、auth 文件、profiles、备份、截图或本机私有日志。
- [ ] 没有修改旧版本机工具目录。
- [ ] 涉及 `config.toml` / `auth.json` 写入时，已经说明备份、恢复和失败路径。

## 用户影响

- [ ] 说明了是否影响用户启动入口、Release 资产或旧工具替换路径。
- [ ] 文档已同步更新。
