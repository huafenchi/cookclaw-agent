/**
 * CookClaw Remote Files — OpenClaw Tool Provider
 * 
 * 通过 HTTP API 调用 CookClaw Hub，转发请求到用户电脑上的 agent
 * 
 * 环境变量:
 *   COOKCLAW_API_URL  — CookClaw API 地址 (默认 http://host.docker.internal:3005)
 *   COOKCLAW_BOT_ID   — Bot ID
 *   COOKCLAW_SECRET   — Worker Secret
 * 
 * 这个文件放在 Bot 容器的 OpenClaw workspace 目录里，
 * 通过 AGENTS.md 的 tools 配置让 Bot 调用
 */

const http = require('http');
const https = require('https');

const API_URL = process.env.COOKCLAW_API_URL || 'http://host.docker.internal:3005';
const BOT_ID = process.env.COOKCLAW_BOT_ID || '';
const SECRET = process.env.COOKCLAW_SECRET || 'cookclaw-worker-2026';

// 清理错误消息：去除内部路径和 IP 地址，避免泄露给 LLM
function sanitizeError(msg) {
  if (!msg || typeof msg !== 'string') return msg;
  return msg
    // 去除绝对路径 (Unix)
    .replace(/\/(?:home|Users|opt|var|etc|tmp|root)\/[^\s,)}\]"']*/g, '<path>')
    // 去除 Windows 路径
    .replace(/[A-Z]:\\[^\s,)}\]"']*/gi, '<path>')
    // 去除 IPv4 地址（含端口）
    .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g, '<host>')
    // 去除 IPv6 地址
    .replace(/\[?[0-9a-fA-F:]{3,39}\]?(:\d+)?/g, (match) => {
      // 只替换看起来像 IPv6 的（至少两个冒号）
      return (match.match(/:/g) || []).length >= 2 ? '<host>' : match;
    });
}

// 调用 Hub 转发请求到 agent
// 兼容两种模式：CookClaw API (/api/agent/request + botId) 和独立 Hub (/request)
function callAgent(action, params) {
  return new Promise((resolve, reject) => {
    const isStandalone = !BOT_ID;
    const data = JSON.stringify(isStandalone
      ? { action, params: params || {}, secret: SECRET }
      : { botId: BOT_ID, action, params: params || {}, secret: SECRET }
    );

    const endpoint = isStandalone ? '/request' : '/api/agent/request';
    const parsed = new URL(API_URL + endpoint);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 35000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(result);
        } catch (e) {
          reject(new Error('响应解析失败'));
        }
      });
    });

    req.on('error', e => reject(new Error(sanitizeError(e.message))));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(data);
    req.end();
  });
}

// ─── 工具定义（符合 OpenClaw tool provider 格式）───

const tools = {
  remote_list_dir: {
    description: '列出用户电脑上指定目录的文件和文件夹',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径（相对于 agent 根目录），默认为根目录' },
      },
    },
    handler: async (params) => {
      const result = await callAgent('list_dir', { path: params.path || '.' });
      if (!result.success) return `错误: ${sanitizeError(result.error)}`;
      const data = result.data;
      if (data.error) return `错误: ${sanitizeError(data.error)}`;
      const files = data.files || [];
      if (files.length === 0) return `目录 ${data.dir} 为空`;
      const lines = files.map(f => 
        `${f.is_dir ? '📁' : '📄'} ${f.name}${f.is_dir ? '/' : ''} (${formatSize(f.size)}, ${f.mod_time})`
      );
      return `📂 ${data.dir} (${data.count} 项)\n${lines.join('\n')}`;
    },
  },

  remote_read_file: {
    description: '读取用户电脑上的文件内容',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        offset: { type: 'number', description: '读取起始位置（字节）' },
        limit: { type: 'number', description: '最多读取字节数' },
      },
      required: ['path'],
    },
    handler: async (params) => {
      const result = await callAgent('read_file', params);
      if (!result.success) return `错误: ${sanitizeError(result.error)}`;
      const data = result.data;
      if (data.error) return `错误: ${sanitizeError(data.error)}`;
      return `📄 ${data.path} (${formatSize(data.size)}, ${data.mod_time})\n\n${data.content}`;
    },
  },

  remote_write_file: {
    description: '在用户电脑上写入或追加文件（需要 agent 非只读模式）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的内容' },
        append: { type: 'boolean', description: '是否追加模式（默认覆盖）' },
      },
      required: ['path', 'content'],
    },
    handler: async (params) => {
      const result = await callAgent('write_file', params);
      if (!result.success) return `错误: ${sanitizeError(result.error)}`;
      const data = result.data;
      if (data.error) return `错误: ${sanitizeError(data.error)}`;
      return `✅ 已写入 ${data.path} (${data.written} 字节)`;
    },
  },

  remote_search: {
    description: '在用户电脑上搜索文件（按文件名匹配）',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（匹配文件名）' },
        max_depth: { type: 'number', description: '最大搜索深度（默认5）' },
        file_only: { type: 'boolean', description: '是否只搜索文件（不含文件夹）' },
      },
      required: ['query'],
    },
    handler: async (params) => {
      const result = await callAgent('search', params);
      if (!result.success) return `错误: ${sanitizeError(result.error)}`;
      const data = result.data;
      if (data.error) return `错误: ${sanitizeError(data.error)}`;
      const results = data.results || [];
      if (results.length === 0) return `未找到匹配 "${data.query}" 的文件`;
      const lines = results.map(f =>
        `${f.is_dir ? '📁' : '📄'} ${f.path} (${formatSize(f.size)}, ${f.mod_time})`
      );
      return `🔍 搜索 "${data.query}": ${data.count} 个结果\n${lines.join('\n')}`;
    },
  },

  remote_file_info: {
    description: '获取用户电脑上某个文件的详细信息',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
      },
      required: ['path'],
    },
    handler: async (params) => {
      const result = await callAgent('file_info', params);
      if (!result.success) return `错误: ${sanitizeError(result.error)}`;
      const data = result.data;
      if (data.error) return `错误: ${sanitizeError(data.error)}`;
      return `${data.is_dir ? '📁' : '📄'} ${data.name}\n路径: ${data.path}\n大小: ${formatSize(data.size)}\n修改时间: ${data.mod_time}\n类型: ${data.is_dir ? '目录' : '文件'}`;
    },
  },

  remote_exec: {
    description: '在用户电脑上执行命令（需要 agent 启用 --enable-exec）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', description: '超时秒数（默认60）' },
      },
      required: ['command'],
    },
    handler: async (params) => {
      const result = await callAgent('exec', params);
      if (!result.success) return `错误: ${sanitizeError(result.error)}`;
      const data = result.data;
      if (data.error) return `错误: ${sanitizeError(data.error)}`;
      let output = '';
      if (data.stdout) output += data.stdout;
      if (data.stderr) output += (output ? '\n--- stderr ---\n' : '') + data.stderr;
      return `⚡ ${data.command} (exit: ${data.exit_code}, ${data.elapsed})\n${output || '(无输出)'}`;
    },
  },

  remote_status: {
    description: '查看用户电脑上 Agent 的状态和信息',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const result = await callAgent('status', {});
      if (!result.success) return `Agent 不在线: ${sanitizeError(result.error)}`;
      const data = result.data;
      return `🦞 CookClaw Agent v${data.version}\n📁 目录: ${data.base_dir}\n🔒 只读: ${data.read_only ? '是' : '否'}\n⚡ 命令: ${data.exec_enabled ? '已启用' : '未启用'}\n💻 平台: ${data.platform}`;
    },
  },

  remote_upload_file: {
    description: '读取用户电脑上的二进制文件（base64 编码返回），支持任意文件类型，上限 50MB',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对于 agent 根目录）' },
      },
      required: ['path'],
    },
    handler: async (params) => {
      const result = await callAgent('upload_file', { path: params.path });
      if (!result.success) return `错误: ${sanitizeError(result.error)}`;
      const data = result.data;
      if (data.error) return `错误: ${sanitizeError(data.error)}`;
      return `📦 ${data.name}\n路径: ${data.path}\n大小: ${formatSize(data.size)}\n类型: ${data.mime_type}\n内容(base64): ${data.content_base64}`;
    },
  },

  remote_download_file: {
    description: '将二进制文件写入用户电脑（base64 编码传入），需要 agent 非只读模式',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径（相对于 agent 根目录）' },
        content_base64: { type: 'string', description: '文件内容的 base64 编码' },
        overwrite: { type: 'boolean', description: '是否覆盖已存在的文件（默认 false）' },
      },
      required: ['path', 'content_base64'],
    },
    handler: async (params) => {
      const result = await callAgent('download_file', {
        path: params.path,
        content_base64: params.content_base64,
        overwrite: params.overwrite || false,
      });
      if (!result.success) return `错误: ${sanitizeError(result.error)}`;
      const data = result.data;
      if (data.error) return `错误: ${sanitizeError(data.error)}`;
      return `✅ 已写入 ${data.path} (${formatSize(data.size)})`;
    },
  },

  remote_screenshot: {
    description: '截取用户电脑的屏幕截图（返回 base64 编码的 PNG 图片）',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const result = await callAgent('screenshot', {});
      if (!result.success) return `错误: ${sanitizeError(result.error)}`;
      const data = result.data;
      if (data.error) return `错误: ${sanitizeError(data.error)}`;
      return `📸 截图 ${data.width}x${data.height} (${data.format}, ${formatSize(data.size)})\n内容(base64): ${data.content_base64}`;
    },
  },
};

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + 'MB';
  return (bytes / 1073741824).toFixed(1) + 'GB';
}

// ─── MCP Stdio Server ───

const readline = require('readline');

function startStdioServer() {
  const rl = readline.createInterface({ input: process.stdin });

  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'initialized',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cookclaw-remote-files', version: '0.3.0' },
    },
  }) + '\n');

  rl.on('line', async (line) => {
    try {
      const msg = JSON.parse(line);

      if (msg.method === 'tools/list') {
        const toolList = Object.entries(tools).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: t.parameters,
        }));
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { tools: toolList },
        }) + '\n');
      } else if (msg.method === 'tools/call') {
        const toolName = msg.params?.name;
        const toolArgs = msg.params?.arguments || {};
        const tool = tools[toolName];

        if (!tool) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: '未知工具: ' + toolName }], isError: true },
          }) + '\n');
          return;
        }

        try {
          const result = await tool.handler(toolArgs);
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: result }] },
          }) + '\n');
        } catch (e) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: '调用失败: ' + sanitizeError(e.message) }], isError: true },
          }) + '\n');
        }
      } else if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'cookclaw-remote-files', version: '0.3.0' },
          },
        }) + '\n');
      }
    } catch (e) {
      // ignore parse errors
    }
  });
}

// ─── HTTP Server 模式（备选）───

function startHttpServer() {
  const port = parseInt(process.env.PORT || '3100');
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tools: Object.keys(tools) }));
      return;
    }

    if (req.method === 'POST' && req.url === '/call') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', async () => {
        try {
          const { tool, params } = JSON.parse(body);
          if (!tools[tool]) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: '未知工具' }));
            return;
          }
          const result = await tools[tool].handler(params || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: sanitizeError(e.message) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`CookClaw Remote Files plugin on :${port}`);
  });
}

// ─── 入口 ───

const mode = process.argv[2] || 'stdio';
if (mode === 'http') {
  startHttpServer();
} else {
  startStdioServer();
}
