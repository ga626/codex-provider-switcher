# 安装、更新与卸载

`Signalman AI` 是 Windows alpha 软件，有两条安装路径：GitHub 提供日常更新较快的版本，Microsoft Store 提供低频稳定版本。它们不是两个不同产品；请在同一台电脑上选择其中一个作为日常入口，不要把源码开发版或维护者候选版当作稳定安装版。

## GitHub 最新版

1. 打开 [最新发布版](https://github.com/ga626/codex-provider-switcher/releases/latest)。
2. 下载名称带 `setup.exe` 的 Windows 安装包和同名 `.sha256` 文件。
3. 确认下载页属于官方仓库、版本号与校验文件一致后，双击安装包并按安装向导完成安装。
4. 从开始菜单或桌面图标打开 `Signalman AI`。

未购买 Windows 代码签名时，Windows 可能显示 SmartScreen 提示。这不表示可以忽略未知来源：只在确认下载来自官方 GitHub Release 后自行决定是否继续。企业策略或 Smart App Control 可能直接阻止未签名安装包，本项目不能也不会提供绕过方法。

GitHub 安装版的“检查更新”使用签名更新包。更新完成后应用会重新启动；不要手工替换程序目录。

## Microsoft Store 稳定版

1. 打开 [Microsoft Store 产品页](https://apps.microsoft.com/detail/9P7PGV62WKK6)。
2. 安装 `Signalman AI`，之后由 Microsoft Store 自动检查和交付稳定更新。
3. Store 版本只在稳定大版本时更新，因此版本可能晚于 GitHub。这是正常的发布节奏差异。

Store 安装版不使用 GitHub updater，也不要求任何私钥、口令或发布配置。

正常情况下两条路径都会打开一个桌面窗口：不需要浏览器、不需要输入端口、不应保留 CMD 窗口。若安装器被 Windows 拦截或窗口无法打开，先看 [排错指南](troubleshooting.zh.md)。

## 第一次使用

新安装的服务商列表为空，不会附带任何其他人的接口地址、模型或 API 密钥。先新增并保存你自己的 provider，再运行“服务商可用性测试”：它会用当前模型发送一次短时、已认证的 Responses 请求。只有测试通过，应用才会允许切换并创建恢复点；不要为了测试而手工覆盖 Codex 的 `config.toml` 或 `auth.json`。

最终 provider 切换应在新的 Codex 会话中完成。不要在正在使用的同一会话里切换当前 provider。

## 检查更新

- 只信任应用内更新、GitHub Release 或 Microsoft Store。不要从聊天记录、网盘或未知镜像下载 setup。
- 更新失败时不要手动替换程序目录；记录提示，按排错指南处理，或保留当前稳定版等待受控升级。

## 卸载与数据保留

升级和卸载只会替换或移除程序文件，不会自动删除已有的 provider 目录、备份和本地状态。这是为了让受控升级、重新安装后仍能恢复。保存的 API 密钥使用当前 Windows 用户的凭据保护，不会以明文保存在该目录。

如果你确实要清空数据，请先在应用中确认恢复点或自行备份，再手动删除该目录。不要把其中的文件发送到公开 Issue。

## 开发者和源码使用者

开发版与已安装版本是不同路线。查看当前 PR 的界面和普通功能时，开发者使用：

```powershell
npm run qa:dev-desktop
```

它会构建并直接打开当前源码的桌面候选，但不会安装、卸载或升级稳定版。只有安装器、版本、启动入口、更新或 Release 资产变更时，才需要进行安装发布验收。开发方式见仓库中的 [开发与 PR 指南](https://github.com/ga626/codex-provider-switcher/blob/main/docs/contributing/development-and-prs.zh.md)。
