# 在 OpenCode 中生图和编辑参考图

0.8.0 使用插件托管的 AI Studio 后端。无需额外安装 Magpie 或 Edge 扩展，无需填写本机服务地址或密钥。新机器需先安装 OpenCode 2.x、Node.js 22+，解压本插件到固定目录，运行 install.cmd，再在 /connect 连接 AI Studio 账号 · OpenCode，由本人完成 Google 登录。

旧版用户更新代码后可运行 connect-studio.cmd；已有有效账号会复用登录状态，并刷新型号目录。

## 选择生图模型

聊天输入框继续使用 AI Studio 账号 · OpenCode 下的 Flash Lite、Argon 等对话模型。图片专用型号注册为 image 类型，由生图工具选择，不会混入普通聊天型号列表。

在消息中写明工具和型号即可：

> 请用 gemini_generate_image，用 Nano Banana Pro 生成一幅雨夜咖啡馆插画，16:9。

> 请用 gemini_generate_image，用 Nano Banana 2 Lite 生成一幅水彩风景画，1:1、1K。

支持显示名称或完整 ID。未指定时优先选择实际目录中的 Nano Banana 2 Lite；指定型号失败后，插件不会自动改用另一个型号。可让 OpenCode 用 model_list 查询 image 类型、aistudio-account 提供商的实际目录。

| 显示名称 | 模型 ID |
| --- | --- |
| Nano Banana 2 Lite | gemini-3.1-flash-lite-image |
| Nano Banana 2.1 | gemini-nano-banana-2.1 |
| Nano Banana 2 | gemini-3.1-flash-image |
| Nano Banana Pro | gemini-3-pro-image |
| Nano Banana | gemini-2.5-flash-image |

每个账号实际列出的型号可能不同。分辨率以所选型号的实际支持范围为准，并非所有型号都支持 4K。未指定分辨率时使用模型默认值。

## 编辑本地参考图

> 请用 gemini_generate_image，用 Nano Banana 2.1 编辑 D:/Pictures/observatory.jpg，把黄色风筝改成红色，保留主体和构图。

工具的 referenceImages 参数支持最多 4 个本地文件路径。相对路径以当前项目目录为准；读取前使用 OpenCode 原生 read 权限检查。每张参考图最多 10 MiB、合计最多 20 MiB。当前每次生成一张。

生成成功会返回图片附件和真实保存路径。文件保存在插件数据目录的 generated/<随机目录>/ 下，自动检查 PNG/JPEG/WebP/GIF 文件头与 MIME 类型，不把模型的文字描述当作图片文件。

## 生图请求诊断

若生图提示 HTTP 403 / 协议错误码 7，先区分聊天模型请求与图片模型请求。包含“调用生图工具”的用户消息并不能证明图片请求已实际发出。提供商应为 **AI Studio 账号 · OpenCode**；旧的 **Google AI Studio** 配置可能走另一套接口。

0.8.2 已包含 scripts/diagnose-image.mjs；旧的 0.8.1 安装可先从本仓库补充该文件。在插件目录执行：

```powershell
node scripts/diagnose-image.mjs
node scripts/diagnose-image.mjs --live --model gemini-3-pro-image
```

第一条显示本机版本、状态和缓存的图片目录，不发生成请求。第二条直接请求指定图片模型，使用 16:9 和默认分辨率，不经过聊天模型、不附带函数声明；会消耗生图额度，不自动重发、换型号、保存图片或上传记录。型号必须在该机器的图片目录中。

`IMAGE_RECEIVED` 表示直接请求收到了通过文件头检查的图片；不等于 OpenCode 完整工具链通过。若直接生图也为 `GOOGLE_PERMISSION_DENIED`，则单纯移除聊天工具声明不能解决该次图片请求的拒绝，仍需结合官网同账号、同型号的表现检查服务资格与后端兼容性。目录列出型号不保证该账号的每次请求都会被允许。

## 运行行为

复用成熟后端和 OpenCode 内置 Google 图片协议；OpenCode 2.2.5 的自定义图片模型类存在兼容限制，因此插件内部使用随机令牌、回环地址的临时适配器，只允许图片生成路径。真实后端密钥保留在插件内部，适配器端口和令牌无需用户管理，插件退出时关闭。

连接失败、HTTP 错误、模型内容限制及用户取消均不会由插件自动重新生成；没有额外调用另一个型号的隐藏回退。生成耗时和账号可用额度由实际模型及服务状态决定，本版不推算订阅额度。

Gemini Web 生图尚未接入这一托管实现。当前面向 Windows x64 + OpenCode 2.2.5。
