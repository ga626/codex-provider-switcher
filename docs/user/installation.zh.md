# 安装与启动

`CodeX Provider Switcher` 当前是 alpha 项目。正式产品路线是轻量本地 Web 控制台：启动器静默启动本地后端，浏览器打开控制台页面。

当前仓库里的启动入口仍主要用于开发和预览，不代表最终安装体验。

## 开发预览

安装依赖：

```powershell
npm install
```

启动并打开本地预览：

```powershell
npm run preview:start
```

停止预览：

```powershell
npm run preview:stop
```

## Release 包预期

未来 Windows Release 包应提供：

- 双击启动入口。
- 静默本地后端。
- 浏览器本地控制台。
- 备份、恢复、验证和回滚入口。
- 版本说明和校验文件。

在达到这些条件前，不应把新版工具声明为已经替换旧版 `CodeX-Switcher.exe`。
