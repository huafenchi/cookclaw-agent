# CookClaw Agent + Remote Files Plugin

让 AI Bot 访问你电脑上的文件和执行命令。

## 架构

```
你的电脑                          服务器
┌──────────────────┐            ┌──────────────────────────┐
│  cookclaw-agent  │  WebSocket │  Hub (hub-standalone.js) │
│  (Go binary)     │◄──────────►│  ┌─ /ws/agent (WS)      │
│                  │   wss://   │  ├─ /request  (HTTP)     │
│  📁 文件操作     │            │  └─ /health   (HTTP)     │
│  ⚡ 命令执行     │            │         │                │
└──────────────────┘            │         │ 速率限制       │
                                │         │ 60 req/min/IP  │
                                └─────────┼────────────────┘
                                          │
                                ┌─────────▼────────────────┐
                                │  openclaw-plugin         │
                                │  (MCP Tool Provider)     │
                                │  Bot 通过 MCP 调用       │
                                │  文件/命令操作           │
                                └──────────────────────────┘
```

## 快速开始

### 1. 运行 Agent（你的电脑）

```bash
# 只允许文件操作
./cookclaw-agent --key=YOUR_KEY --dir=~/Documents

# 文件 + 命令执行（白名单模式，推荐）
./cookclaw-agent --key=YOUR_KEY --dir=~/Documents --enable-exec --allow-commands=ls,cat,grep,python3

# 文件 + 命令执行（允许所有非黑名单命令）
./cookclaw-agent --key=YOUR_KEY --dir=~/Documents --enable-exec --allow-all-commands

# 使用配置文件
./cookclaw-agent --config=config.json

# 只读模式
./cookclaw-agent --key=YOUR_KEY --dir=~/Documents --readonly
```

### 2. 配置文件格式（可选）

创建 `config.json`，CLI 参数会覆盖配置文件中的值：

```json
{
  "server": "wss://cookclaw.com/ws/agent",
  "key": "your-agent-key",
  "dir": "~/Documents",
  "readonly": false,
  "enable_exec": false,
  "allow_commands": ["ls", "cat", "grep"],
  "exec_timeout": 30,
  "max_search_depth": 10
}
```

### 3. 配置 OpenClaw 插件（服务器）

在 OpenClaw 的 `openclaw.json` 里添加 MCP 工具：

```json
{
  "tools": {
    "mcp": {
      "cookclaw-remote": {
        "command": "node",
        "args": ["/path/to/openclaw-plugin/index.js"],
        "env": {
          "COOKCLAW_API_URL": "http://localhost:3005",
          "COOKCLAW_BOT_ID": "your-bot-id",
          "COOKCLAW_SECRET": "your-secret"
        }
      }
    }
  }
}
```

### 4. 跟 Bot 对话

```
你: 帮我看看桌面上有什么文件
Bot: 📂 Desktop (15 项)
     📁 项目/ (4KB, 2026-03-10)
     📄 合同.docx (128KB, 2026-03-08)
     ...

你: 读一下那个合同文件
Bot: 📄 合同.docx (128KB)
     [文件内容...]

你: 帮我跑一下 python3 analyze.py
Bot: ⚡ python3 analyze.py (exit: 0, 2.3s)
     分析完成，结果已保存到 output.csv
```

## Agent 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--key` | (必填) | 连接密钥 |
| `--dir` | `.` | Bot 可访问的目录 |
| `--server` | `wss://cookclaw.com/ws/agent` | 服务器地址 |
| `--config` | (无) | JSON 配置文件路径（CLI 参数优先） |
| `--readonly` | false | 只读模式 |
| `--enable-exec` | false | 启用命令执行 |
| `--allow-commands` | (空) | 命令白名单，逗号分隔 |
| `--allow-all-commands` | false | 允许所有非黑名单命令（需配合 --enable-exec） |
| `--deny-commands` | (空) | 额外黑名单，逗号分隔 |
| `--exec-timeout` | 60 | 命令超时秒数 |
| `--max-search-depth` | 10 | 文件搜索最大目录深度 |
| `--version` | - | 显示版本号并退出 |
| `-v` | false | 详细日志 |

## 安全

- **路径隔离**: Agent 只能操作 `--dir` 指定目录，无法逃逸
- **黑名单**: `.ssh`、`.env`、私钥等敏感文件自动屏蔽
- **命令控制**: 默认关闭，需 `--enable-exec` 明确启用
- **白名单优先**: 启用 exec 后，默认要求 `--allow-commands` 白名单；不设白名单需显式 `--allow-all-commands`
- **危险命令**: `rm -rf /`、`shutdown` 等永久禁止
- **错误脱敏**: 错误消息不暴露服务器绝对路径
- **传输加密**: WebSocket 走 WSS (TLS)
- **随时断开**: 关闭 Agent 即断开，Bot 立刻失去访问权限

### 安全建议

- **使用 WSS**: 生产环境务必使用 `wss://` 加密传输，不要用明文 `ws://`
- **Nginx 反向代理**: 推荐用 Nginx 做 TLS 终结 + 反向代理，示例：
  ```nginx
  location /ws/agent {
      proxy_pass http://127.0.0.1:3006;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header X-Real-IP $remote_addr;
  }
  ```
- **Hub 速率限制**: Hub 内置 60 请求/分钟/IP 的速率限制，防止滥用
- **Hub 超时配置**: 通过环境变量 `HUB_REQUEST_TIMEOUT` 调整请求超时（默认 30000ms）
- **最小权限**: 优先使用 `--readonly` + `--allow-commands` 白名单

## Hub 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HUB_REQUEST_TIMEOUT` | 30000 | 请求超时毫秒数 |

## 插件提供的工具

| 工具 | 说明 |
|------|------|
| `remote_list_dir` | 列目录 |
| `remote_read_file` | 读文件 |
| `remote_write_file` | 写文件 |
| `remote_search` | 搜索文件 |
| `remote_file_info` | 文件详情 |
| `remote_exec` | 执行命令 |
| `remote_status` | Agent 状态 |
| `remote_upload_file` | 读取二进制文件（base64） |
| `remote_download_file` | 写入二进制文件（base64） |
| `remote_screenshot` | 截取屏幕截图 |

## 文件传输

Agent 支持二进制文件的上传和下载，通过 base64 编码传输：

- **上传** (`upload_file`): 从用户电脑读取任意文件，base64 编码返回。上限 50MB。只读模式下可用。
- **下载** (`download_file`): 将 base64 编码的内容写入用户电脑。支持 overwrite 参数控制是否覆盖。只读模式下禁用。

## 屏幕截图

Agent 支持跨平台截图，自动检测并使用系统工具：

- **macOS**: `screencapture`
- **Linux**: `import` (ImageMagick) / `scrot` / `gnome-screenshot`（按顺序尝试）
- **Windows**: PowerShell `System.Drawing`

截图不受 `--readonly` 和 `--enable-exec` 限制（内置能力，不涉及用户文件或命令执行）。

## CI/CD

项目使用 GitHub Actions 自动构建发布。推送 `v*` 标签时自动：
- 交叉编译 Linux/macOS/Windows (amd64 + arm64)
- 创建 GitHub Release 并附带所有二进制文件

```bash
git tag v0.3.0
git push origin v0.3.0
```
