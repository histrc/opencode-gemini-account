# 新机器：只部署这一个 OpenCode 插件

## 目标与运行方式

在已安装 OpenCode 的机器上安装本插件，插件直接管理 AIStudio2API 和 Gemini Web 后端。运行链路为：

`OpenCode → 原生插件 → 插件托管的本机后端 → Google`

无需安装或启动 Magpie，无需安装 Edge 扩展，无需手动部署后端或填写 baseURL、本机服务 API Key。后端按需下载并验证固定 SHA-256，使用插件自己的数据目录、随机本机凭据和回环端口。新安装不扫描或借用其他应用的账号。

## 当前源码包的安装

当前面向 Windows x64、OpenCode 2.2.5。源码 ZIP 的双击安装器需要 Node.js 22+（含 npm）；如果机器尚无这个运行环境，需要先安装。插件包尚未发布到 npm。

1. 将 ZIP 完整解压到固定目录，双击 **install.cmd**。安装器安装插件运行依赖并注册 OpenCode V2 插件，不改写原有全局 opencode.json。
2. 重启 OpenCode，打开 **/connect**，选择 **AI Studio 账号 · OpenCode** 或 **Gemini 网页账号 · OpenCode**。
3. 根据账号连接说明操作。首次使用自动下载对应后端；按需完成 Google 账号连接。模型列表会在连接完成后刷新。
4. 在 **/models** 选择该入口的型号，先发一条短消息。编程任务优先选择 AI Studio。

两个 Provider 互相独立，不必同时连接。可双击 connect-studio.cmd 连接 AI Studio，再双击 test-call.cmd 发一条真实 Reply only OK.。

0.8.0 已接入 AI Studio 生图和参考图编辑。完成上述安装和登录即可使用，无需额外配置。保持聊天模型为 Flash Lite、Argon 等对话型号，发送“请用 gemini_generate_image，用 Nano Banana 2 Lite 生成一幅水彩风景画，1:1、1K”。可以改为其他实际可用的生图型号；详情见 IMAGE_GENERATION.md。

模型选择器中应出现 **AI Studio 账号 · OpenCode** 分组；同名的旧 **Google AI Studio** 配置可能仍指向先前手工部署的接口。0.7.4 支持安装器参数 --managed --data-dir PATH，为不同宿主固定同一数据目录；此路径只记录在本机 .managed-install.json 中，不随源码包分发。调整目录时需先停止该插件后端并迁移其自身数据，避免同一账号被两个实例占用。

## 账号连接的实际区别

AI Studio：后端首次需要准备自己的登录浏览器（可能数百 MB），由本人在弹出的窗口登录。日常生成由后端处理，无需保持浏览器窗口。

0.7.1 的当前 Windows 登录浏览器压缩包约 470 MiB。连接时会显示本机进度页链接；双击 connect-studio.cmd 的命令窗口也会显示下载量、百分比、解压和安装阶段。完整缓存直接复用，网络中断保留进度供续传。准备成功后无需每次下载。当前后端不能直接以系统 Edge 替换这个登录组件；轻量化登录适配尚未实现。

Gemini Web：当前复用后端的专用网页会话连接方式，需要本人在单独的隐私窗口登录，并在 OpenCode 的连接流程中提供该专用会话的 Cookie。请按连接页的说明获取完整 Cookie，请勿使用日常浏览器的会话。此步骤仍需本人操作；没有承诺已经实现两个入口统一的一键 Google OAuth。

网络仍需能访问 GitHub 下载站点和 Google。连接时可填写网络代理；已有可用 TUN 可留空。这里的代理是网络出口，不是要求用户部署 API 服务。

对于特定代理“按域名连接 Google 发生 TLS/EOF、按实际 IPv4 则可连通”的情况，0.7.3 提供可选兼容组件。在插件数据目录 managed-network.json 保留 proxy 并加入 studioIPv4: true，插件会自动管理本机辅助进程；只支持无认证的 HTTP 上游代理，常规网络保持默认关闭。它动态查询地址并保留证书校验，不保证修复所有网络问题。

若提示账号由另一个 AIStudio2API runtime 使用，表示同一账号已有其他服务占用。先停止旧实例及其自动重启，再重试连接；不必删除账号、清理浏览器或重复登录。插件不会擅自终止其他应用的服务，也不会删除或绕过账号运行锁。

## 后续功能

继续完善跨设备部署与 Gemini Web 账号调用。AI Studio 使用原生 Function Calling；Gemini Web 的工具实现和能力边界需分别处理。Gemini Web 生图、搜索来源、用量展示和后端升级界面仍待完善。

独立浏览器与 Edge 扩展代码暂时保留为备用，默认入口 managed.mjs 不加载它们。
