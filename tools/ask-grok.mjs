#!/usr/bin/env node
/**
 * tools/ask-grok.mjs
 * 
 * 本地协同编程 CLI：让 Antigravity 或开发者在终端直接调用本机已登录的 Grok
 * 原理：通过本地轻量 HTTP 通道（127.0.0.1:18288）与 XFollower 扩展 Background 握手，
 * 复用本机 Chrome 中已登录的 Grok 会话自动生成代码与算法解答。
 * 
 * 用法：
 *   node tools/ask-grok.mjs "你的编程问题或算法需求"
 *   node tools/ask-grok.mjs --file ./path/to/prompt.txt
 */

import http from 'http';
import fs from 'fs';

const PORT = 18288;
const HOST = '127.0.0.1';

// 解析命令行参数
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  console.log(`
使用方式:
  node tools/ask-grok.mjs "<你的编程问题/算法需求>"
  node tools/ask-grok.mjs --file <prompt文件路径>

示例:
  node tools/ask-grok.mjs "请用JavaScript实现一个多维标签过滤算法，要求支持AND/OR复合过滤"
`);
  process.exit(0);
}

let promptText = '';
if (args[0] === '--file' || args[0] === '-f') {
  if (!args[1] || !fs.existsSync(args[1])) {
    console.error('❌ 指定的 prompt 文件不存在:', args[1]);
    process.exit(1);
  }
  promptText = fs.readFileSync(args[1], 'utf8');
} else {
  promptText = args.join(' ');
}

const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
let taskClaimed = false;
let completed = false;

console.log(`\n======================================================`);
console.log(`🚀 已启动本地 Grok 协同编程通道 (Port: ${PORT})`);
console.log(`📌 任务编号: ${taskId}`);
console.log(`💬 问题摘要: ${promptText.slice(0, 100)}${promptText.length > 100 ? '...' : ''}`);
console.log(`⏳ 正在等待 XFollower 扩展接单并调起本机 Grok...`);
console.log(`======================================================\n`);

const server = http.createServer((req, res) => {
  // CORS 跨域支持
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || HOST}`);

  // 1. 扩展轮询获取当前任务
  if (req.method === 'GET' && url.pathname === '/task') {
    if (!taskClaimed && !completed) {
      taskClaimed = true;
      console.log(`✔ 扩展已成功拉取任务，正在由本机 Grok 实时思考生成中...`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId, prompt: promptText }));
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  // 2. 扩展提交 Grok 的解答结果
  if (req.method === 'POST' && url.pathname === '/result') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        if (data.taskId === taskId) {
          completed = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));

          console.log(`\n✨ ================= 本机 Grok 解答完成 (${data.channel || 'web'}) =================\n`);
          if (data.ok) {
            console.log(data.text);
          } else {
            console.error(`❌ Grok 执行未能成功:`, data.reason || '未知错误');
          }
          console.log(`\n========================================================================\n`);

          server.close(() => {
            process.exit(data.ok ? 0 : 1);
          });
          return;
        }
      } catch (err) {
        console.error('解析结果出错:', err);
      }
      res.writeHead(400);
      res.end('Bad Request');
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  // 设置 150 秒超时保护
  setTimeout(() => {
    if (!completed) {
      console.error(`\n⏱️ 等待超时 (150秒)。`);
      if (!taskClaimed) {
        console.error(`💡 提示：扩展未接单。请确保 Chrome 正在运行且已加载 XFollower 扩展（可点开一次扩展面板或刷新后台）。`);
      } else {
        console.error(`💡 提示：扩展已接单但 Grok 响应较慢，请检查浏览器中的 Grok 登录状态。`);
      }
      server.close(() => process.exit(1));
    }
  }, 150000);
});
