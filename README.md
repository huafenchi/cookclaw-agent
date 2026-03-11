# CookClaw Agent + Remote Files Plugin

让 AI Bot 访问你电脑上的文件和执行命令。

## 架构

```
你的电脑                        服务器
┌──────────────┐  WebSocket   ┌─────────────────┐
│ cookclaw-    │ ◄──────────► │ CookClaw / 你的  │
│ agent        │   wss://     │ OpenClaw 服务器   │
│ 文件+命令    │              └────────┬────────┘
└──────────────┘                       │
                              ┌────────▼────────┐
                              │ openclaw-plugin  │
                              │ (MCP Tool)       │
                              │ Bot 调用文件操作  │
                              └─────────────────┘
```

## 快速开始

### 1. 运行 Agent（你的电脑）

```bash
# 只允许文件操作
./cookclaw-agent --key=YOUR_KEY --dir=~/Documents

# 文件 + 命令执行
./cookclaw-agent --key=YOUR_KEY --dir=~/Documents --enable-exec

# 只读 + 命令白名单
./cookclaw-agent --key=YOUR_KEY --dir=~/Documents --readonly --enable-exec --allow-commands=ls,cat,grep,python3
```

### 2. 配置 OpenClaw 插件（服务器）

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

### 3. 跟 Bot 对话

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
| `--readonly` | false | 只读模式 |
| `--enable-exec` | false | 启用命令执行 |
| `--allow-commands` | (空) | 命令白名单，逗号分隔 |
| `--deny-commands` | (空) | 额外黑名单，逗号分隔 |
| `--exec-timeout` | 60 | 命令超时秒数 |
| `-v` | false | 详细日志 |

## 安全

- **路径隔离**: Agent 只能操作 `--dir` 指定目录，无法逃逸
- **黑名单**: `.ssh`、`.env`、私钥等敏感文件自动屏蔽
- **命令控制**: 默认关闭，需 `--enable-exec` 明确启用
- **危险命令**: `rm -rf /`、`shutdown` 等永久禁止
- **白名单**: `--allow-commands` 限制只能跑特定命令
- **传输加密**: WebSocket 走 WSS (TLS)
- **随时断开**: 关闭 Agent 即断开，Bot 立刻失去访问权限

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
