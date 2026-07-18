# 安装、更新与卸载

`CodeX Provider Switcher` 是 Windows alpha 软件。日常使用请以 GitHub Release 中标为 Latest 的版本为准，不要把源码目录或临时构建当成稳定安装版。

## 安装

1. 打开 [最新发布版](https://github.com/ga626/codex-provider-switcher/releases/latest)。
2. 下载名称带 `setup.exe` 的 Windows 安装包和同名 `.sha256` 文件。
3. 双击安装包，按安装向导完成安装。
4. 从开始菜单或桌面图标打开 `CodeX Provider Switcher`。

正常情况下会出现一个桌面窗口：不需要浏览器、不需要输入端口、不应保留 CMD 窗口。若安装器被 Windows 拦截或窗口无法打开，先看 [排错指南](troubleshooting.zh.md)。

## 第一次使用

首次保存或切换前，确认应用界面已经展示目标 provider、模型和会影响的文件。应用会先创建恢复点；不要为了测试而手工覆盖 Codex 的 `config.toml` 或 `auth.json`。

最终 provider 切换应在新的 Codex 会话中完成。不要在正在使用的同一会话里切换当前 provider。

## 检查更新

稳定安装版中的“检查更新”会从 GitHub Release 获取签名更新包。你不需要输入私钥、口令或发布配置。

- 只信任应用内更新或 GitHub Release 中同一版本的安装包。
- 更新失败时不要手动替换程序目录；记录提示，按排错指南处理，或保留当前稳定版等待受控升级。
- 若版本说明写明需要一次性手动升级，请先下载新 setup 安装包。旧版不能保证自行修复旧版的更新缺陷。

## 卸载与数据保留

卸载会移除程序文件，但不会自动删除 `%LOCALAPPDATA%\CodeX Provider Switcher` 中的 provider 目录、备份和本地状态。这是为了让重新安装或升级后仍能恢复。

如果你确实要清空数据，请先在应用中确认恢复点或自行备份，再手动删除该目录。不要把其中的文件发送到公开 Issue。

## 开发者和源码使用者

开发版与已安装版本是两条不同路线。查看当前 PR 的界面和普通功能时，开发者使用：

```powershell
npm run qa:dev-desktop
```

它不会安装、卸载或升级稳定版。只有安装器、版本、启动入口、更新或 Release 资产变更时，才需要进行安装发布验收。开发方式见仓库中的 [开发与 PR 指南](https://github.com/ga626/codex-provider-switcher/blob/main/docs/contributing/development-and-prs.zh.md)。
