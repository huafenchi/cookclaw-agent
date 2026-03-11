/**
 * CookClaw Agent Hub — 独立版
 * 
 * 一个独立的 WebSocket 中继服务，连接 agent（用户电脑）和 OpenClaw（服务器）
 * 
 * 用法: node hub-standalone.js [--port 3006] [--secret your-secret]
 * 
 * Agent 连接: ws://localhost:3006/ws/agent (Header: X-Agent-Key)
 * OpenClaw 调用: POST http://localhost:3006/request (Body: { action, params, secret })
 */
const http = require('http');
const crypto = require('crypto');

let WebSocket;
try { WebSocket = require('ws'); } catch (e) {
  console.error('需要安装 ws 模块: npm install ws');
  process.exit(1);
}

// ─── 配置 ───
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const PORT = parseInt(getArg('port', '3006'));
const SECRET = getArg('secret', crypto.randomBytes(16).toString('hex'));
const AGENT_KEY = getArg('agent-key', crypto.randomBytes(24).toString('hex'));

// ─── Agent 连接管理 ───
let agentWs = null;
let agentInfo = {};
const pending = new Map(); // requestId → { resolve, timeout }
const REQUEST_TIMEOUT = 30000;

function sendToAgent(action, params) {
  return new Promise((resolve, reject) => {
    if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
      reject(new Error('Agent 不在线'));
      return;
    }
    const id = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Agent 请求超时'));
    }, REQUEST_TIMEOUT);
    pending.set(id, { resolve, timeout: timer });
    agentWs.send(JSON.stringify({ id, action, params: params || {} }));
  });
}

// ─── HTTP + WebSocket 服务 ───
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.url === '/health' && req.method === 'GET') {
    res.end(JSON.stringify({
      status: 'ok',
      agentOnline: !!(agentWs && agentWs.readyState === WebSocket.OPEN),
      agentInfo,
    }));
    return;
  }

  if (req.url === '/request' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { action, params, secret } = JSON.parse(body);
        if (secret !== SECRET) {
          res.writeHead(401);
          res.end(JSON.stringify({ success: false, error: 'Invalid secret' }));
          return;
        }
        const result = await sendToAgent(action, params);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = require('url').parse(req.url);
  if (url.pathname === '/ws/agent') {
    const key = req.headers['x-agent-key'];
    if (key !== AGENT_KEY) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      console.log('❌ Agent 连接被拒绝: key 不匹配');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // 踢掉旧连接
      if (agentWs && agentWs.readyState === WebSocket.OPEN) {
        agentWs.close(4002, 'New connection');
      }
      agentWs = ws;
      console.log('✅ Agent 已连接');

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'heartbeat') {
            ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
            return;
          }
          if (msg.type === 'register') {
            agentInfo = {
              version: msg.version,
              baseDir: msg.base_dir,
              readOnly: msg.read_only,
              execEnabled: msg.exec_enabled,
              platform: msg.platform,
              connectedAt: new Date().toISOString(),
            };
            console.log(`📋 Agent 注册: v${msg.version} ${msg.platform} dir=${msg.base_dir}`);
            return;
          }
          // 请求响应
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            clearTimeout(p.timeout);
            pending.delete(msg.id);
            p.resolve(msg);
          }
        } catch (e) {}
      });

      ws.on('close', () => {
        agentWs = null;
        agentInfo = {};
        console.log('🔌 Agent 断开连接');
      });
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🦞 CookClaw Agent Hub (独立版)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

端口:       ${PORT}
Secret:     ${SECRET}
Agent Key:  ${AGENT_KEY}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📌 用户电脑运行:
   ./cookclaw-agent --key=${AGENT_KEY} --dir=~/Documents --server=ws://YOUR_SERVER_IP:${PORT}/ws/agent

📌 OpenClaw MCP 配置 (openclaw.json):
   "tools": {
     "mcp": {
       "remote-files": {
         "command": "node",
         "args": ["openclaw-plugin/index.js"],
         "env": {
           "COOKCLAW_API_URL": "http://localhost:${PORT}",
           "COOKCLAW_SECRET": "${SECRET}"
         }
       }
     }
   }

📌 健康检查: curl http://localhost:${PORT}/health
`);
});
