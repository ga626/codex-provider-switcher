# 安装、更新与卸载

`CodeX Provider Switcher` 是 Windows alpha 软件。Microsoft Store 是下一次正式发布的优先渠道，但首个 Store 版本尚未通过认证；当前日常使用仍以 GitHub Release 中标为 Latest 的版本为准，不要把源码目录或临时构建当成稳定安装版。

## 安装

1. 打开 [最新发布版](https://github.com/ga626/codex-provider-switcher/releases/latest)。
2. 下载名称带 `setup.exe` 的 Windows 安装包和同名 `.sha256` 文件。
3. 双击安装包，按安装向导完成安装。
4. 从开始菜单或桌面图标打开 `CodeX Provider Switcher`。

正常情况下会出现一个桌面窗口：不需要浏览器、不需要输入端口、不应保留 CMD 窗口。若安装器被 Windows 拦截或窗口无法打开，先看 [排错指南](troubleshooting.zh.md)。

## 第一次使用

新安装的服务商列表为空，不会附带任何其他人的接口地址、模型或 API 密钥。先新增并保存你自己的 provider，再运行“服务商可用性测试”：它会用当前模型发送一次短时、已认证的 Responses 请求。只有测试通过，应用才会允许切换并创建恢复点；不要为了测试而手工覆盖 Codex 的 `config.toml` 或 `auth.json`。

最终 provider 切换应在新的 Codex 会话中完成。不要在正在使用的同一会话里切换当前 provider。

## 检查更新

当前 GitHub 安装版中的“检查更新”会从 GitHub Release 获取签名更新包。首个 Microsoft Store 版本认证后，Store 安装版会由 Store 自动检查和交付更新，应用内按钮会打开对应的 Store 页面。你不需要输入私钥、口令或发布配置。

- 只信任应用内更新或 GitHub Release 中同一版本的安装包。不要从聊天记录、网盘或未知镜像下载 setup。
- 更新失败时不要手动替换程序目录；记录提示，按排错指南处理，或保留当前稳定版等待受控升级。
- Store 认证完成后，安装指南会在对应发布版本中同步切换到 Store 入口；在那之前不要尝试从空的 Store 产品页安装。

## 卸载与数据保留

升级和卸载只会替换或移除程序文件，不会自动删除 `%LOCALAPPDATA%\CodeX Provider Switcher` 中的 provider 目录、备份和本地状态。这是为了让受控升级、重新安装后仍能恢复。保存的 API 密钥使用当前 Windows 用户的凭据保护，不会以明文保存在该目录。

如果你确实要清空数据，请先在应用中确认恢复点或自行备份，再手动删除该目录。不要把其中的文件发送到公开 Issue。

## 开发者和源码使用者

开发版与已安装版本是两条不同路线。查看当前 PR 的界面和普通功能时，开发者使用：

```powershell
npm run qa:dev-desktop
```

它会构建并直接打开当前源码的桌面候选，但不会安装、卸载或升级稳定版。只有安装器、版本、启动入口、更新或 Release 资产变更时，才需要进行安装发布验收。开发方式见仓库中的 [开发与 PR 指南](https://github.com/ga626/codex-provider-switcher/blob/main/docs/contributing/development-and-prs.zh.md)。
