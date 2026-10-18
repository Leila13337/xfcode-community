# xfcode 社区网站 · 1.1.0

独立运行的 xfcode 中文社区，采用深灰色界面和绿色品牌文字。
所有讨论合并到一个 Community 分组，提供真实保存状态的订阅、资源下载和实时聊天。

## 启动

需要 Node.js 24（本机使用 24.22.0 验证）。无需 npm install。

双击 START.cmd，或在本目录运行：

    npm start

首页：http://localhost:4173/forums/index.php

注册已开放，无需邀请码。用户名为 3–25 位字母或数字，密码至少 10 位。
全新安装中，第一个注册成功的真实账号自动成为管理员，顶栏会出现 Admin。管理员可在 Admin → Members 禁用或解禁其他真实账号；禁用立即使现有会话失效，并阻止重新登录。
升级已有安装时，最早注册的真实账号成为管理员；原有账号、帖子和回复保留。

## 一次性管理员账号重置

`node scripts/reset-accounts.mjs --dry-run` 只预览、不改数据库。实际执行需显式添加 `--apply --confirm-delete-other-accounts`，并将 `GS_DATA_DIR` 指向网站当前使用的数据目录。执行前会在数据库目录创建一致性备份；脚本仅手动运行，不会在网站启动时自动删除账号。 源码 ZIP 不含线上 `forum.sqlite`；部署代码后，仍需在能访问线上持久化数据目录的运行环境里单独执行一次脚本。

通过环境变量提供密码（源码和数据库均不保存明文）。若数据库中还没有 Leila 账号，建议设置 `LEILA_ADMIN_EMAIL` 使用真实邮箱；不设置时会使用 `leila-admin@invalid.local`，该占位邮箱不能用于收信或找回密码。已有 Leila 时不设置邮箱变量会沿用其现有邮箱。示例 PowerShell：

```powershell
$env:LEILA_ADMIN_EMAIL = "admin@example.com"
$securePassword = Read-Host "请输入 Leila 管理员密码" -AsSecureString
$env:LEILA_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $securePassword).Password
node scripts/reset-accounts.mjs --dry-run
# 检查预览无误后，再有意执行：
node scripts/reset-accounts.mjs --apply --confirm-delete-other-accounts
Remove-Item Env:LEILA_ADMIN_PASSWORD
```

该操作删除其他可登录账号，清理其个人资料、会员/订阅申请、收藏和会话；主题、帖子、聊天内容保留并改由不可登录的匿名系统用户显示，下载记录保留但解除账号关联。订阅激活码的创建者/兑换者也会匿名化。请先核对预览和数据库备份。
## 一个分组

所有原有主题和回复合并至 Community。主题、回复和收藏的 ID 保留，原有论坛链接也能指向合并后的社区。
首页集中显示订阅、下载、聊天入口和社区讨论。

## 订阅

入口：Subscription。

- 通过管理员审批或激活码开通订阅，不提供免费试用。
- 会员方案为 30 / 90 / 365 天。
- 用户可提交激活申请，在 Admin 中由管理员审核开通。
- 管理员可以生成一次性激活码，用户在 Subscription 兑换。
- 续期会加到现有到期时间；过期后失去会员下载权限。
- 用户可以查看申请状态、取消未审核申请、查看激活记录。

当前采用人工审核 / 激活码模式，没有接入在线支付，不会扣款，也不会将未付款申请显示为支付成功。

## 下载

入口：Downloads；管理员在 Admin → Publish a download 发布文件。

- 支持实际文件上传，不设应用层文件大小上限；上传内容分块写入磁盘，并计算 SHA-256 校验值。
- 设置标题、版本、说明及公开 / 订阅会员权限。
- 展示实际大小、SHA-256 校验码、下载次数。
- 文件由后端作为附件传输；会员权限在服务端校验。
- 默认自带一份社区配置 JSON，供验证下载流程；不是原站客户端。

实际需要分发的客户端或其他资源，可以通过后台上传。

## 聊天

入口：Chat。所有登录用户在同一个 Community 聊天室交流。

- SSE 实时推送，多页面、多用户同步。
- 保存历史消息，支持加载更早记录。
- 统计真实在线账号，同一账号打开多个页面只算一人。
- 单条最多 1,000 字符，Ctrl + Enter 发送。
- 刷新后仍可看到历史；离开聊天页或退出时关闭对应实时连接。

## 其他功能

注册、登录、发帖、回复、引用、正文预览、主题搜索、收藏和个人资料均保留。
个人资料显示角色、会员状态和到期时间。

未配置第三方密钥时，验证码是本地展示复选框，注册邮箱验证码保持关闭。配置 Turnstile 和 Resend 后，注册会要求通过真实人机验证和邮箱验证码；密码邮件找回和 2FA 仍未配置。
网站账号、会员和数据由 xfcode 本地服务独立管理。

## 数据与环境变量

默认数据：data/forum.sqlite；上传文件：data/releases/。
这些数据需要同时备份。

- PORT：默认 4173。
- HOST：默认 127.0.0.1。
- GS_DATA_DIR：更改数据库和上传文件所在目录。
- GS_SECURE_COOKIE=1：HTTPS 环境启用 Secure Cookie。
- TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY：同时配置后启用 Cloudflare Turnstile；留空时本地使用兼容的勾选框。
- RESEND_API_KEY / MAIL_FROM：同时配置后启用注册邮箱验证码；验证码只保存哈希值，10 分钟过期，单个邮箱每小时最多发送 5 次。
- EMAIL_CODE_SECRET：可选，用于邮箱验证码哈希；生产环境建议设置为随机长字符串。

当前聊天中的运行预览使用工作区 work/preview-data，升级时保留已有数据。
ZIP 包不包含预览账号、订阅、会话或测试上传文件；解压启动后会创建独立数据。

## 主要文件

- server.mjs：HTTP、会话、账号和论坛 API。
- features.mjs：分组合并、订阅、资源发布 / 下载及实时聊天。
- public/app.js：页面和交互。
- public/styles.css：桌面 / 手机样式。
- test/forum.test.mjs：原有论坛流程测试。
- test/features.test.mjs：订阅、下载、聊天和升级迁移测试。
- preview/：当前界面的截图。
- TEST_REPORT.md：验证记录。

## 验证

    npm test

37 项测试通过，包括原有功能回归、旧内容迁移、免费试用接口已关闭、激活码不可重用、管理员权限、审批幂等、过期下载限制、文件字节一致性、双用户消息推送、聊天分页与重启持久化。

前端样式参考了 2026-10-15 可见的原站公开页面，并按本次需求扩展；未宣称会员区域与原站完全一致。
Raleway 字体的许可证位于 public/assets/OFL.txt。
