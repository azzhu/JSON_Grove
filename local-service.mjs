import http from 'node:http';
import { access, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const JSONVIEW_ROOT = fileURLToPath(new URL('.', import.meta.url));
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export class LocalDocumentStore {
  constructor() { this.byToken = new Map(); this.byPath = new Map(); }

  async register(filename) {
    const path = await realpath(filename);
    if (!/\.(json|jsonc)$/i.test(path)) throw fail('请选择 .json 或 .jsonc 文件（标准 JSON）');
    await access(path, constants.R_OK | constants.W_OK);
    const info = await stat(path);
    if (!info.isFile()) throw fail('指定路径不是普通文件');
    if (info.size > MAX_DOCUMENT_BYTES) throw fail('请选择小于 20 MB 的 JSON 文件');
    let record = this.byPath.get(path);
    if (!record) {
      record = { path, name: basename(path), id: createHash('sha256').update(path).digest('hex'), token: randomBytes(32).toString('hex'), pending: Promise.resolve() };
      this.byPath.set(path, record); this.byToken.set(record.token, record);
    }
    const file = await this.read(record);
    try { JSON.parse(file.content.replace(/^\uFEFF/, '')); } catch { throw fail('原文件不是有效的标准 JSON'); }
    return { id: record.id, name: record.name, path, token: record.token };
  }

  authorized(token) {
    const record = this.byToken.get(token);
    if (!record) throw fail('文件连接已失效，请在终端重新运行 jsonview 打开此文件', 403);
    return record;
  }

  async read(record) {
    if (await realpath(record.path) !== record.path) throw fail('文件路径已改变，请在终端重新打开文件');
    const file = await open(record.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) throw fail('原文件不是普通文件或已超过 20 MB');
      const bytes = await file.readFile();
      if (bytes.length > MAX_DOCUMENT_BYTES) throw fail('原文件已超过 20 MB');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw fail('原文件不是有效的 UTF-8 文本，请先转换编码'); }
      return { id: record.id, name: record.name, path: record.path, content, size: bytes.length, modified: info.mtimeMs, mode: info.mode & 0o777 };
    } finally { await file.close(); }
  }

  write(record, expectedContent, content) {
    const operation = record.pending.catch(() => {}).then(async () => {
      if (typeof expectedContent !== 'string' || typeof content !== 'string' || Buffer.byteLength(content) > MAX_DOCUMENT_BYTES || Buffer.byteLength(expectedContent) > MAX_DOCUMENT_BYTES) throw fail('写入内容无效或超过 20 MB');
      try { JSON.parse(content.replace(/^\uFEFF/, '')); } catch { throw fail('JSON 格式错误，未写入原文件'); }
      const check = async () => {
        const latest = await this.read(record);
        if (latest.content !== expectedContent) throw Object.assign(fail('原文件已被其他程序修改，已停止写入', 409), { content: latest.content });
        return latest;
      };
      const original = await check();
      await access(record.path, constants.W_OK);
      const temporary = join(dirname(record.path), `.${record.name}.jsonview-${randomUUID()}.tmp`);
      let staged;
      try {
        staged = await open(temporary, 'wx', original.mode);
        await staged.chmod(original.mode);
        await staged.writeFile(content, 'utf8');
        await staged.sync(); await staged.close(); staged = null;
        await check();
        await rename(temporary, record.path);
      } finally { if (staged) await staged.close().catch(() => {}); await rm(temporary, { force: true }); }
      return { saved: true };
    });
    record.pending = operation;
    return operation;
  }
}

async function readJSON(request, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw fail('请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fail('无效的 JSON 请求'); }
}

const reply = (response, status, data) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
};

export function createLocalService({ root = JSONVIEW_ROOT, secret, store = new LocalDocumentStore(), onStop = () => {} }) {
  const handler = async (request, response) => {
    try {
      const address = server.address();
      const host = `127.0.0.1:${address.port}`;
      if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== `http://${host}`)) throw fail('不允许的请求来源', 403);
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname.startsWith('/__jsonview/')) {
        if (url.pathname === '/__jsonview/file') {
          const record = store.authorized(request.headers['x-jsonview-file']);
          if (request.method === 'GET') { const { mode, ...file } = await store.read(record); reply(response, 200, file); }
          else if (request.method === 'PUT') {
            const body = await readJSON(request, MAX_DOCUMENT_BYTES * 12 + 1024);
            reply(response, 200, await store.write(record, body.expectedContent, body.content));
          } else throw fail('不支持的请求方法', 405);
          return;
        }
        if (!secret || request.headers['x-jsonview-admin'] !== secret) throw fail('无效的服务凭据', 403);
        if (url.pathname === '/__jsonview/status' && request.method === 'GET') reply(response, 200, { app: 'jsonview', version: 1, root });
        else if (url.pathname === '/__jsonview/open' && request.method === 'POST') {
          const body = await readJSON(request, 32768);
          if (typeof body.path !== 'string') throw fail('请提供文件路径');
          reply(response, 200, await store.register(body.path));
        } else if (url.pathname === '/__jsonview/stop' && request.method === 'POST') {
          await Promise.allSettled([...store.byToken.values()].map(record => record.pending));
          reply(response, 200, { stopped: true });
          server.close(() => { void onStop(); });
          server.closeIdleConnections();
        } else throw fail('接口不存在', 404);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) throw fail('不支持的请求方法', 405);
      const pathname = decodeURIComponent(url.pathname);
      const relative = pathname === '/' ? 'JSON查看器.html' : pathname.slice(1);
      if (relative !== 'JSON查看器.html') throw fail('文件不存在', 404);
      const data = await readFile(join(root, relative));
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      response.writeHead(200, { 'Content-Type': mime[extname(relative)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "frame-ancestors 'none'" });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 500);
      reply(response, status, { error: error.code === 'ENOENT' ? '原文件或页面不存在，请重新运行 jsonview 打开文件' : error.message, ...(typeof error.content === 'string' ? { content: error.content } : {}) });
    }
  };
  const server = http.createServer(handler);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, handler, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = randomBytes(32).toString('hex');
  const runtimePath = join(JSONVIEW_ROOT, '.jsonview-runtime.json');
  const cleanup = async () => {
    try { const state = JSON.parse(await readFile(runtimePath, 'utf8')); if (state.pid === process.pid) await rm(runtimePath, { force: true }); } catch {}
    process.exit(0);
  };
  const { server, store } = createLocalService({ secret, onStop: cleanup });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await Promise.allSettled([...store.byToken.values()].map(record => record.pending));
    server.close(() => { void cleanup(); });
    server.closeIdleConnections();
  });
  server.once('error', error => {
    const message = error.code === 'EADDRINUSE' ? 'JSON 查看器端口被占用，可使用 JSONVIEW_PORT=其他端口 重试' : error.message;
    process.send?.({ error: message });
    console.error(message); process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
  server.listen(Number(process.env.JSONVIEW_PORT || 5176), '127.0.0.1', () => {
    process.send?.({ version: 1, port: server.address().port, secret, pid: process.pid, root: JSONVIEW_ROOT });
  });
}
