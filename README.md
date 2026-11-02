# OpenCode Gemini Account

通过原生 OpenCode 插件连接 Google AI Studio 与 Gemini Web，自动管理所需的本机后端。

**当前版本：0.8.1，实验版。** 提供 AI Studio 对话、识图、编程工具调用、生图和参考图编辑。Gemini Web 已接入后端部署及账号连接流程，仍处于实验阶段。

## 功能与运行方式

```text
OpenCode → 原生插件 → 插件托管的本机后端 → Google
```

- 用户无需另装 Magpie 或 Edge 扩展，无需手工部署后端或填写 baseURL、本机服务密钥。
- 插件自动下载并校验固定版本的后端，创建本机凭据、选择回环端口并启动服务。
- AI Studio 对话逐段返回 SSE，复用成熟的请求和原生 Function Calling 实现。
- `gemini_generate_image` 支持选择型号、文生图、本地参考图编辑、宽高比和分辨率，保存真实图片并返回附件。
- 本人完成 Google 登录；本项目不提供账号、访问资格或订阅额度。

当前默认入口是 `managed.mjs`。后端管理与协议模块复用自 [Magpie Gemini Web](https://github.com/BUKOWSKIREAL/magpie-gemini-web)，后端为 AIStudio2API 与 gemini-web2api-go。来源、固定版本及许可证见 [THIRD_PARTY.md](THIRD_PARTY.md) 和 [vendor/magpie/PROVENANCE.md](vendor/magpie/PROVENANCE.md)。

## 安装

当前面向 **Windows x64、OpenCode 2.2.5**。源码安装器需要 **Node.js 22+（含 npm）**。其他 OpenCode 版本和操作系统的兼容性仍需确认；插件尚未发布到 npm。

1. 从 [Releases](https://github.com/histrc/opencode-gemini-account/releases) 下载源码包，完整解压到准备长期保留的目录。
2. 双击 `install.cmd`，等待安装完成。不要移动安装目录。
3. 重启 OpenCode，在 `/connect` 选择 **AI Studio 账号 · OpenCode**。
4. 根据本机进度页提示准备后端和登录浏览器，由本人完成 Google 登录。
5. 在 `/models` 选择该提供商下的对话型号，例如 `gemini-3.5-flash-lite`。

也可在项目目录执行：

```powershell
npm ci --omit=dev --ignore-scripts
node scripts/install.mjs --v2 --managed
```

首次 AI Studio 登录浏览器的 Windows 压缩包约 **470 MiB**。连接流程显示下载、解压和安装进度；完整缓存可复用，网络中断保留续传进度。日常生成不需要保持登录浏览器窗口。

网络需能访问 GitHub 下载站点及 Google。连接时可填写本机网络代理，已有可用 TUN 可留空。网络代理不是要求用户自行搭建 API 服务。

`connect-studio.cmd` 可连接账号，`test-call.cmd` 可发送一条真实短请求。新机、数据目录、旧服务占用与网络兼容说明见 [NEW_MACHINE.md](NEW_MACHINE.md)。安装器保留原有全局 `opencode.json`；若保留了旧提供商，请确认选中的是新入口。

出现 HTTP 403 / 协议错误码 7 时，可按 [工具请求诊断](NEW_MACHINE.md#工具请求诊断) 对照纯文本和附带函数声明的请求。0.8.1 增加诊断与错误提示，不承诺消除 Google 的拒绝响应。

## 生图与参考图编辑

聊天继续选择 Flash Lite、Argon 等对话型号，在消息中指定生图工具和型号：

> 请用 gemini_generate_image，用 Nano Banana 2 Lite 生成一幅水彩风景画，1:1、1K。

> 请用 gemini_generate_image，用 Nano Banana 2.1 编辑 D:/Pictures/scene.jpg，把黄色风筝改成红色，保留主体和构图。

支持使用后端目录中的显示名称或模型 ID 选择生图型号。未指定时优先使用实际可用的 Nano Banana 2 Lite；指定型号失败后，插件不会自动更换型号或重新生成。

生图型号注册为 `image` 类型，由工具选择，不混入普通聊天型号列表。图片保存到插件数据目录的 `generated/` 下，同时返回附件和路径。参数、型号及验证范围见 [IMAGE_GENERATION.md](IMAGE_GENERATION.md)。

可用型号及其参数以已连接账号的实际后端目录为准。

## Gemini Web

在 `/connect` 选择 **Gemini 网页账号 · OpenCode**，插件自动部署对应后端。当前后端要求本人在单独的隐私窗口登录，并按连接流程提供该专用会话的 Cookie；不是统一的一键 Google OAuth。不要在 GitHub Issue、日志或聊天中粘贴 Cookie。

Gemini Web 的多轮与工具能力仍处于实验阶段，托管实现暂未接入其生图功能。

## 开发与验证

```powershell
npm ci --ignore-scripts
npm test
npm run check
```

如需自行检查真实调用，先完成账号连接。下列命令会使用账号实际额度：

```powershell
npm run verify:managed
npm run verify:image:managed
```

仓库保留测试代码和检查命令，不发布本机验证报告、截图或实测记录。

早期独立浏览器和 Edge 扩展代码作为备用保留，默认入口不加载。不要混用旧命令与当前默认实现。

## 许可证

本项目采用 [MIT License](LICENSE)。复用模块及依赖保留各自的版权、许可证和来源说明；下载的后端及浏览器也适用其各自许可证。
