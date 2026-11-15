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

### Docker / Linux 容器

Magpie 插件运行在容器里，所以 `agy` 也必须安装或挂载到容器内。宿主机 Windows 路径和 `%USERPROFILE%` 在容器里不可用。

建议把账号目录放到 Magpie 已持久化的 `/config` 卷中：

```yaml
services:
  magpie:
    environment:
      MAGPIE_AGY_BIN: /config/home/.local/bin/agy
      MAGPIE_AGY_ACCOUNTS_DIR: /config/agy-accounts
      AGY_CLI_DISABLE_AUTO_UPDATE: "true"
    volumes:
      - magpie-config:/config
```

如果 `agy` 由启动脚本安装到其他位置，把 `MAGPIE_AGY_BIN` 改成容器内的绝对路径；`AGY_PATH` 也被支持。

登录容器内的 profile：

```sh
docker compose exec -it magpie sh -lc '
  mkdir -p /config/agy-accounts/work
  /config/home/.local/bin/agy --gemini_dir=/config/agy-accounts/work
'
```

第二个账号：

```sh
docker compose exec -it magpie sh -lc '
  mkdir -p /config/agy-accounts/personal
  /config/home/.local/bin/agy --gemini_dir=/config/agy-accounts/personal
'
```

注意：

- Linux 容器里不需要也不要设置 `WSL_INTEROP`。
- 登录产生的 token 必须位于 `/config/agy-accounts/<name>/antigravity-cli/antigravity-oauth-token`。
- 如果容器内无法完成浏览器回调，请在有浏览器的环境完成一次文件 token 登录，然后只把 `antigravity-cli/antigravity-oauth-token` 放进对应 profile 目录。
- 官方 Magpie 镜像不一定自带 `agy`；可使用自己的带 `agy` 镜像，或在 entrypoint 中安装并固定版本。

### 在 Magpie 登记 profile

在宿主机执行：

```sh
docker compose exec -it magpie /magpie plugin login agy-native
```

在 `agy profile name` 输入容器 profile 名，例如：

```text
work
```

重复执行并输入另一个名字即可增加第二行账号：

```text
personal
```

插件会返回独立的 Magpie `accountId`，例如 `agy-work`、`agy-personal`。Magpie 的账号选择、路由和故障转移决定本次请求使用哪个 profile。

### Windows 原生安装

Windows 上要强制 agy 使用文件 token，而不是整机 Credential Manager：

```powershell
$env:GEMINI_HOME = "$env:USERPROFILE\.config\magpie-agy-native\accounts\work"
$env:WSL_INTEROP = "1"
agy --gemini_dir="$env:GEMINI_HOME"
Remove-Item Env:\WSL_INTEROP
```

也可以使用插件账号 CLI（需要本机有 Node）：

```sh
node <插件目录>/bin/agy-native-account.mjs login work
```

### 默认账号

profile 留空时返回 `agy` 默认账号，继续使用 `agy` 原本的全局登录。默认账号与命名 profile 可以同时保留。

### 隔离边界

- 已隔离：`GEMINI_HOME`、OAuth token 文件、ACP 子进程、模型发现缓存、额度读取。
- 未隔离：容器操作系统、网络出口、同一容器用户对 profile 目录的文件访问权限。
- Windows 的文件 token 是明文 JSON，建议限制账号目录 ACL。
- 容器内 `/config/agy-accounts` 必须放在持久化卷中，否则重建容器会丢失登录。
- 如果要求更强隔离，请让每个账号使用独立 Magpie 容器、独立 `/config` 卷，或独立用户/虚拟机。

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
| `AGY_PATH` | 兼容 cloady / Magpie 容器的 agy 路径变量 |
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






