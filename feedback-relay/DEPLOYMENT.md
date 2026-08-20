# Signalman 在线反馈中继

这是一个很小的 Cloudflare Worker。它只接收严格白名单中的脱敏诊断单，然后在你的 **GitHub 私有仓库** 创建一条 Issue。用户不需要 GitHub 账号；GitHub 只作为维护者收件箱。

## 用户和维护者分别会看到什么

用户在应用中确认提交后，会看到 `SM-123` 这类编号。你登录 GitHub，打开私有仓库的 **Issues** 页面，就能看到一条普通中文问题单：服务商接口协议、域名和路径、模型、失败阶段、HTTP 状态、目录摘要、各检查项和最近操作名称。它不含访问密钥、配置正文、路径、响应正文、Cookie、日志或截图。

这版是单向收件箱：用户提交，你处理和适配。不要把 GitHub 评论当成用户一定看得到的回复。以后需要应用内回复时，再在相同 Worker 后增加工单数据库；本版不虚构在线客服能力。

## 你需要准备的东西

1. 一个 Cloudflare 免费账户。无需购买域名，部署后可使用 `workers.dev` 地址。
2. 一个只用于收件的 GitHub **私有仓库**，例如 `signalman-feedback-inbox`。
3. 一个 GitHub fine-grained personal access token：只授权这个私有仓库，Repository permissions 里只开启 **Issues: Read and write**，设置较短有效期。这个 token 只保存在 Cloudflare Secret，绝不进入桌面应用、Git、截图或聊天。
4. 一个 Cloudflare KV namespace，用于按来源做五分钟节流。它不保存诊断内容。

## 配置步骤

在本机 PowerShell 进入本目录后执行。以下命令会要求你在浏览器登录 Cloudflare；不要把密码或 token 发到聊天里。

```powershell
npx wrangler login
npx wrangler kv namespace create RATE_LIMIT
Copy-Item wrangler.toml.example wrangler.toml
```

把上一步输出的 namespace ID 填入本地 `wrangler.toml` 的 `id`。然后写入两项 Worker 配置：

```powershell
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_FEEDBACK_REPOSITORY
npx wrangler secret put ALLOWED_ORIGINS
npx wrangler deploy
```

输入内容分别是：

- `GITHUB_TOKEN`：刚创建的细粒度 GitHub token。
- `GITHUB_FEEDBACK_REPOSITORY`：例如 `你的 GitHub 用户名/signalman-feedback-inbox`。
- `ALLOWED_ORIGINS`：本地网页开发可填 `http://127.0.0.1:47833,http://localhost:47833`。桌面应用请求没有 `Origin` 时仍可提交；这不是放宽权限，因为 Origin 从来不是身份认证。

`wrangler deploy` 最后会输出 Worker URL，例如 `https://signalman-feedback-relay.你的子域.workers.dev`。这就是唯一可以写进发布构建的公开配置：

```powershell
$env:VITE_FEEDBACK_RELAY_URL = 'https://signalman-feedback-relay.你的子域.workers.dev'
npm run build
```

不要把 `GITHUB_TOKEN` 写入 `.env`、`package.json`、源码或任何发布包。

## 本地验证和首次真测

先运行不联网的合同检查：

```powershell
npm run feedback:contract
```

然后用本地开发板打开“报告兼容问题”，确认预览中没有不该上传的信息，再提交一条受控测试。验收条件不是 HTTP 成功，而是 GitHub 私有收件箱里实际出现一条完整 Issue。

## 运行边界

- 免费层适合低频反馈；具体额度以你开通当日的 Cloudflare 和 GitHub 页面为准。
- CORS 只处理浏览器兼容性，不能防刷；Worker 还会做字段白名单、12 KB 上限和按来源五分钟节流。
- Cloudflare/GitHub 暂时不可用时，应用仍保留“导出脱敏诊断单”作为离线兜底。
- 收件仓库必须保持私有；若日后改为公开 Issue，必须重新设计隐私提示和内容范围。
