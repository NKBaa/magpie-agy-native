# Magpie Antigravity agy Native

一个 Magpie 供应商插件（插件形态兼容 OpenCode 1.x）：**直接驱动本机官方 `agy acp` 运行时**，把 Antigravity 订阅作为 Magpie 模型使用。

它不调用 Antigravity 私有 HTTP 接口，不复制 OAuth token，不伪装 IDE，也不做账号轮换或额度绕过。登录、模型权限和上游配额仍由 Google Antigravity / `agy` 自己管理。

## 功能

- 官方 ACP JSON-RPC 接入：`agy acp`
- 多账号配置、token、ACP 进程、模型缓存和额度按 `GEMINI_HOME` 隔离
- 从 `session/new` 动态读取当前账号可见模型
- 自动合并 `-low` / `-medium` / `-high` 等推理档位
- OpenAI Chat Completions 兼容
- 原生流式文本与思考内容
- 请求取消、进程回收
- 图片输入（账号 / agy 版本声明支持时）
- `agy -p /usage --output-format json` 额度展示
- 可选自动批准 agy 自己的工作区工具；默认关闭

## 前置条件

1. 安装官方 Antigravity CLI `agy`。
2. 先在终端完成登录：

   ```sh
   agy
   ```

3. 确认 ACP 可用：

   ```sh
   agy acp
   ```

   ACP 使用 stdin/stdout 的 JSON-RPC，正常启动后会等待输入，不会打印网页地址。

## 安装到 Magpie

在插件目录执行：

```sh
magpie plugin add https://github.com/NKBaa/magpie-agy-native
```

本地开发也可以直接安装 checkout 目录：

```sh
magpie plugin add <插件目录>
```

然后：

```sh
magpie plugin login agy-native
magpie models
```

`plugin login agy-native` 只是在 Magpie 里建立一个 keyless 账号标记；真正的 Google 登录态仍由 `agy` 管理。

## 多账号隔离

不填 profile 名时使用 `agy` 的全局登录态，这一种模式不隔离。需要多账号时，每个账号使用独立的 `GEMINI_HOME`，插件通过：

```text
agy acp --gemini_dir=<profile-dir>
```

启动独立 ACP 子进程。Magpie 的每个账号行只绑定一个 profile，因此 token、模型列表、额度读取和 ACP 进程不会串用。

### 1. 登录一个隔离 profile

使用插件自带的账号 CLI：

```sh
node <插件目录>/bin/agy-native-account.mjs login work
```

或者手动执行：

```powershell
$env:GEMINI_HOME = "$env:USERPROFILE\.config\magpie-agy-native\accounts\work"
$env:WSL_INTEROP = "1"   # Windows 上强制 agy 使用文件 token，而不是整机 Credential Manager
agy --gemini_dir="$env:GEMINI_HOME"
Remove-Item Env:\WSL_INTEROP
```

登录完成后应存在：

```text
<profile-dir>/antigravity-cli/antigravity-oauth-token
```

### 2. 在 Magpie 登记 profile

```sh
magpie plugin login agy-native
```

在 `agy profile name` 输入：

```text
work
```

重复登录并输入另一个名字，即可增加第二个账号：

```text
personal
```

插件会为每个 profile 返回独立的 Magpie `accountId`，例如 `agy-work`、`agy-personal`。Magpie 的账号选择和路由规则决定本次请求使用哪个 profile。

### 3. 默认账号

profile 留空时返回 `agy` 默认账号，继续使用 `agy` 原本的全局登录。默认账号与命名 profile 可以同时保留。

### 隔离边界

- 已隔离：`GEMINI_HOME`、OAuth token 文件、ACP 子进程、模型发现缓存、额度读取。
- 未隔离：操作系统账号、网络出口、同一用户对 profile 目录的文件访问权限。
- Windows 的文件 token 是明文 JSON，建议限制账号目录 ACL。
- `WSL_INTEROP=1` 在原生 Windows 上是 agy 的文件存储开关；真实 WSL 环境中不要覆盖已有的 `WSL_INTEROP`。
- 如果要求更强隔离，请让每个账号运行在独立 Windows 用户、独立 WSL 发行版或独立容器中。

## 配置

插件默认从 `PATH` 查找 `agy`。如果有多个安装或找不到：

```powershell
$env:MAGPIE_AGY_BIN = "C:\path\to\agy.exe"
```

也可以指定完整 argv：

```powershell
$env:MAGPIE_AGY_COMMAND = '["C:\\path\\to\\agy.exe","acp"]'
```

支持的环境变量：

| 变量 | 说明 |
| --- | --- |
| `MAGPIE_AGY_BIN` | `agy` 可执行文件路径 |
| `MAGPIE_AGY_COMMAND` | 完整 argv 的 JSON 数组，优先级最高 |
| `MAGPIE_AGY_HOME` | 写入子进程的 `GEMINI_HOME` |
| `MAGPIE_AGY_CWD` | ACP 会话工作目录 |
| `MAGPIE_AGY_ACCOUNTS_DIR` | 命名账号根目录，默认 `~/.config/magpie-agy-native/accounts` |
| `MAGPIE_AGY_AUTO_APPROVE=1` | 等效于打开插件的自动批准工具选项 |
| `MAGPIE_AGY_PROMPT_LIMIT_BYTES` | 单次 ACP 文本预算，默认 `180000` |
| `MAGPIE_AGY_START_TIMEOUT_MS` | ACP 启动 / 初始化超时，默认 `45000` |
| `MAGPIE_AGY_CONFIG_TIMEOUT_MS` | 模型切换超时，默认 `30000` |
| `MAGPIE_AGY_DEBUG=1` | 输出模型选择与 stderr 诊断 |

## 权限与安全

插件在 Magpie 里提供一个供应商选项：

> **Auto-approve agy agent tools**

默认关闭。关闭时，ACP 发出的工具权限请求会被拒绝；模型仍可回答，但不能通过 agy 执行工作区工具。

打开后，ACP 的 `allow_once` / `allow_always` 会被自动选择。只应在可信工作区和可信账号上开启。

这个插件不会：

- 读取或上传 `antigravity-oauth-token`
- 调用 `cloudcode-pa` 等私有端点
- 模拟 Antigravity 网页客户端
- 把 token 写进 Magpie 账号存储
- 自动切换账号以规避限流

## 工作方式

```text
Magpie / OpenCode
       |
       | OpenAI Chat Completions
       v
magpie-agy-native
       |
       | ACP JSON-RPC over stdio
       v
agy acp
       |
       v
Google Antigravity account / model runtime
```

每次请求会启动一个短生命周期的 `agy acp` 子进程，依次完成：

1. `initialize`
2. `initialized`
3. `session/new`
4. `session/set_config_option`（选择模型）
5. `session/prompt`
6. 消费 `session/update`
7. 关闭进程

对话历史会按 OpenAI 请求重新构造为 ACP 文本 prompt。超出预算的旧消息会被截断，避免把过长内容直接交给 ACP。

## 已知边界

- 本插件把 agy 当成原生 agent 使用，不把调用方宿主的工具逐个翻译成 ACP MCP 工具。需要工作区操作时，请开启自动批准，让 agy 使用自己的能力。
- 每次 HTTP 请求新建 ACP 会话，因此不会跨请求复用 agy 内部会话缓存。
- 模型列表和图片能力取决于本机 `agy` 版本与账号权限。
- `/usage` 的 JSON 结构可能在 agy 升级后变化；解析器兼容常见的 `command.data.groups`、`data.groups`、`groups` 和 `windows` 形式。
- 不应把本插件当作绕过 Google 配额或服务条款的工具。

## 测试

```sh
npm test
```

测试使用 `tests/fake-agy.mjs` 模拟官方 ACP 进程，覆盖：

- 模型发现与推理档位合并
- ACP 权限请求拒绝
- 命名账号使用独立 `--gemini_dir`
- 原生流式 SSE
- 非流式 completion
- token usage
- 未知模型错误

真实账号联调需要本机已安装并登录 `agy`。

## 参考

- Agent Client Protocol: <https://agentclientprotocol.com/>
- Antigravity CLI / ACP 由 Google 提供
- 设计参考：`DylanLIiii/opencode-antigravity-bridge`、`yulong-ge/magpie-antigravity-acp`，均为 MIT




