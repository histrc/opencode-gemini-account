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

## 工具请求诊断

HTTP 403、协议错误码 7、`The caller does not have permission` 表示请求被拒绝，仅凭这条错误不能确定为账号缺少工具权限。先保留现有账号和网络设置，在插件目录的 PowerShell 中执行：

```powershell
node scripts/diagnose-tools.mjs
node scripts/diagnose-tools.mjs --live --model gemini-3.5-flash-lite
```

第一条只读取版本、后端状态和已缓存的模型目录；第二条必须改成出错时使用的实际模型 ID。它消耗两次短生成请求的额度，同样的文本和参数只增加一个函数声明，不执行函数、不自动重发，不输出原始响应、账号标识、Cookie 或密钥。结果仅显示在终端，不自动保存或上传报告。若配置了多个账号，两次请求可能被分配给不同账号，不能当作同账号对照。

- `TOOLS_REQUEST_REJECTED`：文本被接受，附带函数声明时 Google 拒绝；仍需检查模型、通道、后端兼容性或账号状态，不能直接判定为账号工具权限。
- `DECLARATIONS_ACCEPTED_TOOL_LOOP_NOT_TESTED`：两条请求都被接受；尚未验收 OpenCode 的文件读写、命令执行、多轮工具结果或流式请求。
- `INCONCLUSIVE`：当前对照不足以定位工具问题，结合两条状态分别检查。

0.8.1 保持原有后端版本，增加上述诊断及安全的错误分类提示；没有自动关闭编程工具、换模型或升级后端。迁移安装目录时，重新执行 install.cmd 注册新路径；若旧目录中存在手工指定数据目录的 .managed-install.json，需沿用原有数据目录，避免创建第二个账号运行实例。

### 最小工具声明成功、真实 OpenCode 首轮失败

0.8.2 包含实际首轮请求的差异诊断。旧的 0.8.1 发行包需先应用诊断更新包，或更新到 0.8.2，再执行：

```powershell
node scripts/verify-managed.mjs --live --diagnose-request
```

命令在临时测试项目中截取真实 OpenCode 首轮请求，截取时阻止生成和工具执行，读取后移除临时请求文件。诊断随后使用同一数据目录、同一型号请求后端，依次检查原始请求、非流式、移除输出上限、简化工具参数 Schema、短消息、移除工具。每个变体都基于原始请求独立构造，不累计修改；不会执行模型返回的工具。最多六条生成请求，遇到首个被接受的版本或非权限类失败即停止。

输出只包含宿主版本、模型 ID、流式开关、输出上限、工具与消息数量、HTTP 状态和固定分类，不显示提示词、工具参数详情、账号或凭据，不自动上传结果。`candidateDifference` 只表示一次对照中出现的候选差异，仍需复验，不能排除账号调度、会话或服务状态变化。`ORIGINAL_ACCEPTED_TOOL_LOOP_NOT_TESTED` 表示原始请求单独重放被接受，尚未定位差异，也不能代替编程闭环验收。此模式不改变正式插件的工具、输出上限或流式策略。

## 可选的非流式兼容模式

如果同一实际请求在 `original` 下被拒绝、在 `nonstream` 下被接受，可在 0.8.2 插件目录执行：

```powershell
node scripts/managed.mjs chat-mode studio nonstream
npm.cmd run verify:managed
```

第一条只保存模式，不发送生成请求；第二条用真实 OpenCode 在临时项目中验证读文件、改文件和执行命令，会使用模型额度。更新源码后需重启桌面 OpenCode，以加载新代码。已有 0.8.1 安装可将新版源码合并覆盖到原插件目录，保留已安装依赖与本机数据定位文件；此版本依赖未变。

兼容模式从第一条请求开始使用后端的非流式对话接口；插件不在 403 后自动再发一次。回复完整返回后，插件把文本和原生工具调用交给 OpenCode；工具 Schema、调用 ID、参数、Google 签名元数据与下一轮工具结果继续使用原生格式，不改成提示词模拟工具。文本和工具参数会在该轮生成完成后显示，不能提供逐字输出。插件只转发后端实际返回的用量。

设置保存在该插件数据目录的 managed-chat.json，独立于代理、账号和后端配置；没有设置时默认为 stream。可用 `node scripts/managed.mjs status studio` 查看 chatMode。恢复默认流式：

```powershell
node scripts/managed.mjs chat-mode studio stream
```

开发和验收可用环境变量 GEMINI_ACCOUNT_STUDIO_CHAT_MODE=stream 或 nonstream 临时覆盖保存值。该模式仅适配 AI Studio 对话及原生函数调用；图片请求仍使用原有 generateContent 路径，图片 403 需单独诊断。兼容模式的错误、取消和无效响应不会触发插件自动重试，也不承诺解决账号资格或全部 403。

## 后续功能

继续完善跨设备部署与 Gemini Web 账号调用。AI Studio 使用原生 Function Calling；Gemini Web 的工具实现和能力边界需分别处理。Gemini Web 生图、搜索来源、用量展示和后端升级界面仍待完善。

独立浏览器与 Edge 扩展代码暂时保留为备用，默认入口 managed.mjs 不加载它们。
