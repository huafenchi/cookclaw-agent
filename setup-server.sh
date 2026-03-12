#!/bin/bash
# CookClaw Agent — 服务器端一键部署
# 用法: curl -sSL https://raw.githubusercontent.com/huafenchi/cookclaw-agent/main/setup-server.sh | bash

set -e

SETUP_VERSION="0.2.0"

# --version 支持
if [ "$1" = "--version" ] || [ "$1" = "-v" ]; then
  echo "cookclaw-agent setup v${SETUP_VERSION}"
  exit 0
fi

echo "🦞 CookClaw Agent Hub — 服务器端部署 v${SETUP_VERSION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 检查 Node.js
if ! command -v node &>/dev/null; then
  echo "❌ 需要 Node.js，正在安装..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - 2>/dev/null
  apt-get install -y nodejs 2>/dev/null || {
    echo "❌ 自动安装失败，请手动安装 Node.js >= 18"
    exit 1
  }
fi
echo "✅ Node.js $(node -v)"

# 创建目录
INSTALL_DIR="${COOKCLAW_DIR:-/opt/cookclaw-agent}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# 下载代码
echo "📥 下载代码..."
if command -v git &>/dev/null; then
  if [ -d ".git" ]; then
    git pull --quiet
  else
    git clone https://github.com/huafenchi/cookclaw-agent.git . 2>/dev/null || {
      # 目录非空，直接下载文件
      curl -sSL https://raw.githubusercontent.com/huafenchi/cookclaw-agent/main/hub-standalone.js -o hub-standalone.js
      curl -sSL https://raw.githubusercontent.com/huafenchi/cookclaw-agent/main/openclaw-plugin/index.js -o openclaw-plugin/index.js
      mkdir -p openclaw-plugin
      curl -sSL https://raw.githubusercontent.com/huafenchi/cookclaw-agent/main/openclaw-plugin/package.json -o openclaw-plugin/package.json
    }
  fi
else
  curl -sSL https://raw.githubusercontent.com/huafenchi/cookclaw-agent/main/hub-standalone.js -o hub-standalone.js
  mkdir -p openclaw-plugin
  curl -sSL https://raw.githubusercontent.com/huafenchi/cookclaw-agent/main/openclaw-plugin/index.js -o openclaw-plugin/index.js
  curl -sSL https://raw.githubusercontent.com/huafenchi/cookclaw-agent/main/openclaw-plugin/package.json -o openclaw-plugin/package.json
fi

# 安装 ws 模块
echo "📦 安装依赖..."
npm install ws 2>/dev/null || npm init -y && npm install ws

# 生成配置
AGENT_KEY=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')
HUB_SECRET=$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
HUB_PORT="${COOKCLAW_PORT:-3006}"

# 端口可用性检查
if command -v ss &>/dev/null; then
  if ss -tlnp 2>/dev/null | grep -q ":${HUB_PORT} "; then
    echo "⚠️  端口 ${HUB_PORT} 已被占用:"
    ss -tlnp 2>/dev/null | grep ":${HUB_PORT} " | head -3
    echo ""
    echo "请用 COOKCLAW_PORT=其他端口 重新运行，或先停止占用进程"
    exit 1
  fi
elif command -v lsof &>/dev/null; then
  if lsof -iTCP:${HUB_PORT} -sTCP:LISTEN &>/dev/null; then
    echo "⚠️  端口 ${HUB_PORT} 已被占用:"
    lsof -iTCP:${HUB_PORT} -sTCP:LISTEN 2>/dev/null | head -5
    echo ""
    echo "请用 COOKCLAW_PORT=其他端口 重新运行，或先停止占用进程"
    exit 1
  fi
elif command -v netstat &>/dev/null; then
  if netstat -tlnp 2>/dev/null | grep -q ":${HUB_PORT} "; then
    echo "⚠️  端口 ${HUB_PORT} 已被占用"
    echo "请用 COOKCLAW_PORT=其他端口 重新运行，或先停止占用进程"
    exit 1
  fi
fi
echo "✅ 端口 ${HUB_PORT} 可用"

# 保存配置
cat > config.env << ENVEOF
AGENT_KEY=$AGENT_KEY
HUB_SECRET=$HUB_SECRET
HUB_PORT=$HUB_PORT
ENVEOF

# 检测服务器 IP
SERVER_IP=$(curl -s4 ifconfig.me 2>/dev/null || curl -s4 icanhazip.com 2>/dev/null || echo "YOUR_SERVER_IP")

# 启动 Hub
echo "🚀 启动 Hub..."
if command -v pm2 &>/dev/null; then
  pm2 delete cookclaw-hub 2>/dev/null || true
  pm2 start hub-standalone.js --name cookclaw-hub -- --port "$HUB_PORT" --secret "$HUB_SECRET" --agent-key "$AGENT_KEY"
  pm2 save 2>/dev/null
  echo "✅ Hub 已通过 PM2 启动"
else
  # 用 nohup 后台跑
  nohup node hub-standalone.js --port "$HUB_PORT" --secret "$HUB_SECRET" --agent-key "$AGENT_KEY" > hub.log 2>&1 &
  echo $! > hub.pid
  echo "✅ Hub 已后台启动 (PID: $(cat hub.pid))"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🎉 部署完成！"
echo ""
echo "📌 步骤 1: 配置 OpenClaw"
echo "   在 openclaw.json 的 tools.mcp 里加:"
echo ""
echo '   "remote-files": {'
echo '     "command": "node",'
echo "     \"args\": [\"$INSTALL_DIR/openclaw-plugin/index.js\"],"
echo '     "env": {'
echo "       \"COOKCLAW_API_URL\": \"http://localhost:$HUB_PORT\","
echo "       \"COOKCLAW_SECRET\": \"$HUB_SECRET\""
echo '     }'
echo '   }'
echo ""
echo "📌 步骤 2: 用户电脑运行 Agent"
echo ""
echo "   Mac (Apple Silicon):"
echo "     curl -sSL https://cookclaw.com/downloads/cookclaw-agent-darwin-arm64 -o cookclaw-agent && chmod +x cookclaw-agent"
echo "     ./cookclaw-agent --key=$AGENT_KEY --dir=~/Documents --server=ws://$SERVER_IP:$HUB_PORT/ws/agent"
echo ""
echo "   Mac (Intel):"
echo "     curl -sSL https://cookclaw.com/downloads/cookclaw-agent-darwin-amd64 -o cookclaw-agent && chmod +x cookclaw-agent"
echo "     ./cookclaw-agent --key=$AGENT_KEY --dir=~/Documents --server=ws://$SERVER_IP:$HUB_PORT/ws/agent"
echo ""
echo "   Linux:"
echo "     curl -sSL https://cookclaw.com/downloads/cookclaw-agent-linux-amd64 -o cookclaw-agent && chmod +x cookclaw-agent"
echo "     ./cookclaw-agent --key=$AGENT_KEY --dir=~/Documents --server=ws://$SERVER_IP:$HUB_PORT/ws/agent"
echo ""
echo "   Windows:"
echo "     下载 https://cookclaw.com/downloads/cookclaw-agent-windows-amd64.exe"
echo "     cookclaw-agent.exe --key=$AGENT_KEY --dir=C:\\Users\\你的用户名\\Documents --server=ws://$SERVER_IP:$HUB_PORT/ws/agent"
echo ""
echo "📌 步骤 3: 测试"
echo "   curl http://localhost:$HUB_PORT/health"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "配置已保存到: $INSTALL_DIR/config.env"
