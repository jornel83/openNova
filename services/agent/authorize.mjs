/** User-driven official authorization. Never receives passwords or exposes credentials. */
import { createServer } from 'node:http';
import { createClient } from './chatgpt.mjs';

process.umask(0o077);
let authorizationUrl;
let status = 'starting';
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (request.headers.host !== '127.0.0.1:14556') { response.writeHead(403); response.end(); return; }
  if (request.url === '/login' && authorizationUrl) {
    response.writeHead(302, {Location:authorizationUrl}); response.end(); return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>OpenNova 授权</title><body style="font:20px system-ui;max-width:680px;margin:80px auto"><h1>OpenNova · ChatGPT 授权</h1><p>在官方页面登录并允许 OpenNova 使用订阅额度。凭据加密保存在本机。</p><p><a href="/login">Sign in with ChatGPT</a></p><p>状态：${status}</p></body></html>`);
});
try {
  const client = await createClient({openBrowser(url) {
    if (new URL(url).origin !== 'https://auth.openai.com') throw new Error('unexpected_auth_origin');
    authorizationUrl = url; status = '等待本人登录';
    console.log('请打开 http://127.0.0.1:14556/login ，在 OpenAI 页面完成授权。');
  }});
  const existing = await client.getSession();
  if (existing.status === 'connected' && existing.sharing) {
    console.log('OpenNova 已授权。可运行 node services/agent/worker.mjs --check 检查模型权限。');
  } else {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(14556, '127.0.0.1', resolve); });
    const result = await client.signIn();
    if (result.status !== 'connected' || !result.sharing) throw new Error('sharing_not_enabled');
    console.log('OpenNova 授权完成。');
  }
} catch (error) {
  console.error('授权未完成：' + (/^[a-z_]{1,80}$/.test(error.code ?? '') ? error.code : 'authorization_failed'));
  process.exitCode = 1;
} finally {
  authorizationUrl = undefined;
  server.close();
}
process.exit(process.exitCode ?? 0);
