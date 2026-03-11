/**
 * CookClaw WebSocket Hub — Agent 连接管理
 * 
 * agent 连接到 /ws/agent，Bot 容器通过 /ws/bot-request 发请求
 * Hub 做路由转发，不存储文件内容
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');
const url = require('url');

class AgentHub {
  constructor(db) {
    this.db = db;
    this.agents = new Map();     // key → { ws, info, botId }
    this.pending = new Map();    // requestId → { resolve, reject, timeout }
    this.REQUEST_TIMEOUT = 30000; // 30s
  }

  // Agent 连接认证
  authenticateAgent(key) {
    if (!key) return null;
    // 查找绑定了这个 agent key 的 bot
    const bot = this.db.prepare(
      "SELECT id, user_id, name FROM bots WHERE agent_key = ?"
    ).get(key);
    return bot || null;
  }

  // 处理 agent WebSocket 连接
  handleAgentConnection(ws, req) {
    const key = req.headers['x-agent-key'];
    const version = req.headers['x-agent-version'] || 'unknown';
    
    const bot = this.authenticateAgent(key);
    if (!bot) {
      ws.close(4001, 'Invalid agent key');
      console.log('[Hub] Agent rejected: invalid key');
      return;
    }

    const agentId = bot.id;
    
    // 如果已有连接，踢掉旧的
    if (this.agents.has(agentId)) {
      const old = this.agents.get(agentId);
      try { old.ws.close(4002, 'New connection'); } catch (e) {}
    }

    this.agents.set(agentId, {
      ws, botId: bot.id, userId: bot.user_id, botName: bot.name,
      version, connectedAt: new Date().toISOString(),
      info: {}
    });

    // 更新数据库：agent 在线
    this.db.prepare(
      "UPDATE bots SET agent_online = 1, agent_connected_at = datetime('now') WHERE id = ?"
    ).run(bot.id);

    console.log(`[Hub] Agent connected: ${bot.name} (${agentId}) v${version}`);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'heartbeat') {
          ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
          return;
        }
        
        if (msg.type === 'register') {
          // 更新 agent 信息
          const agent = this.agents.get(agentId);
          if (agent) {
            agent.info = {
              baseDir: msg.base_dir,
              readOnly: msg.read_only,
              platform: msg.platform,
            };
          }
          return;
        }

        // 这是对请求的响应
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          clearTimeout(p.timeout);
          this.pending.delete(msg.id);
          p.resolve(msg);
          return;
        }
      } catch (e) {
        console.error('[Hub] Parse error:', e.message);
      }
    });

    ws.on('close', () => {
      this.agents.delete(agentId);
      this.db.prepare(
        "UPDATE bots SET agent_online = 0 WHERE id = ?"
      ).run(bot.id);
      console.log(`[Hub] Agent disconnected: ${bot.name} (${agentId})`);
    });

    ws.on('error', (e) => {
      console.error(`[Hub] Agent error (${agentId}):`, e.message);
    });
  }

  // 发送请求给 agent，等待响应
  sendToAgent(botId, action, params) {
    return new Promise((resolve, reject) => {
      const agent = this.agents.get(botId);
      if (!agent) {
        reject(new Error('Agent 不在线'));
        return;
      }

      const requestId = crypto.randomBytes(8).toString('hex');
      const timeoutHandle = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Agent 请求超时'));
      }, this.REQUEST_TIMEOUT);

      this.pending.set(requestId, { resolve, reject, timeout: timeoutHandle });

      const msg = JSON.stringify({ id: requestId, action, params });
      agent.ws.send(msg);
    });
  }

  // 检查 agent 是否在线
  isAgentOnline(botId) {
    const agent = this.agents.get(botId);
    return agent && agent.ws.readyState === WebSocket.OPEN;
  }

  // 获取 agent 信息
  getAgentInfo(botId) {
    const agent = this.agents.get(botId);
    if (!agent) return null;
    return {
      online: agent.ws.readyState === WebSocket.OPEN,
      botName: agent.botName,
      version: agent.version,
      connectedAt: agent.connectedAt,
      ...agent.info,
    };
  }

  // 所有在线 agent
  listOnlineAgents() {
    const list = [];
    for (const [botId, agent] of this.agents) {
      if (agent.ws.readyState === WebSocket.OPEN) {
        list.push({
          botId, botName: agent.botName,
          version: agent.version, connectedAt: agent.connectedAt,
          ...agent.info,
        });
      }
    }
    return list;
  }
}

module.exports = AgentHub;
