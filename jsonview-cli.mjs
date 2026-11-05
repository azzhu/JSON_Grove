import { spawn } from 'node:child_process';
import { access, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSONVIEW_ROOT, MAX_DOCUMENT_BYTES } from './local-service.mjs';

const runtimeFile = join(JSONVIEW_ROOT, '.jsonview-runtime.json');
const startupLock = join(JSONVIEW_ROOT, '.jsonview-start.lock');

async function serviceRequest(state, path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${state.port}/__jsonview/${path}`, {
    method, signal: AbortSignal.timeout(path === 'status' ? 1500 : 15000),
    headers: { 'X-Jsonview-Admin': state.secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '本地服务请求失败');
  return data;
}

async function runningService() {
  try {
    const state = JSON.parse(await readFile(runtimeFile, 'utf8'));
    if (state.root !== JSONVIEW_ROOT || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !/^[a-f0-9]{64}$/.test(state.secret)) return null;
    const status = await serviceRequest(state, 'status');
    return status.app === 'jsonview' && status.root === JSONVIEW_ROOT ? state : null;
  } catch { return null; }
}

async function startService() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./local-service.mjs', import.meta.url))], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const state = await new Promise((resolveState, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('本地服务启动超时')); }, 10000);
    const cleanup = () => { clearTimeout(timer); child.removeAllListeners('error'); child.removeAllListeners('exit'); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', () => { cleanup(); reject(new Error('本地服务启动失败')); });
    child.once('message', message => { cleanup(); message.error ? reject(new Error(message.error)) : resolveState(message); });
  });
  try {
    const temporary = `${runtimeFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, runtimeFile);
  } catch (error) { child.kill(); throw error; }
  child.disconnect(); child.unref();
  return state;
}

async function obtainService() {
  const existing = await runningService();
  if (existing) return existing;
  // Serialize concurrent terminal invocations without spawning duplicate services.
  for (let attempt = 0; attempt < 120; attempt++) {
    let lock;
    try { lock = await open(startupLock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - (await stat(startupLock)).mtimeMs > 30000) await rm(startupLock, { force: true }); } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      const ready = await runningService();
      if (ready) return ready;
      continue;
    }
    try { return await runningService() || await startService(); }
    finally { await lock.close(); await rm(startupLock, { force: true }); }
  }
  throw new Error('其他终端正在启动 JSON 查看器，请稍后重试');
}

export async function browserOpen(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'darwin' ? ['-a', 'Microsoft Edge', url] : process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((resolveOpen, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveOpen() : reject(new Error('浏览器未能自动打开，请复制上面的地址访问')));
  });
}

export function parseJsonviewArgs(args) {
  if (args.length === 1 && args[0] === '--stop') return { stop: true };
  let noBrowser = false; let options = true; const paths = [];
  for (const arg of args) {
    if (options && arg === '--') { options = false; continue; }
    if (options && ['--help', '-h'].includes(arg)) return { help: true };
    if (options && ['--no-browser', '--print-url'].includes(arg)) { noBrowser = true; continue; }
    if (options && arg.startsWith('-')) throw new Error(`未知选项 ${arg}，使用 --help 查看用法`);
    paths.push(arg);
  }
  if (paths.length > 1) throw new Error('请指定一个 JSON 文件，例如：jsonview "./配置.json"');
  return { path: paths[0], noBrowser };
}

export async function launchJsonview(args) {
  const parsed = parseJsonviewArgs(args);
  if (parsed.help) {
    console.log('用法：jsonview [--no-browser] [--] [JSON 文件路径]\n      jsonview --stop\n\n自动启动或复用本地服务，在 Edge 打开，修改实时写回原文件。不带路径时打开空白查看器。支持相对路径、绝对路径和带空格的路径。\n--no-browser  只输出打开地址\n--stop        停止本地服务（请先确认网页修改已保存）');
    return;
  }
  if (parsed.stop) {
    const state = await runningService();
    if (state) { await serviceRequest(state, 'stop', 'POST'); console.log('JSON 查看器本地服务已停止'); }
    else console.log('JSON 查看器本地服务未运行');
    return;
  }
  let path;
  if (parsed.path) {
    path = await realpath(resolve(parsed.path));
    const info = await stat(path);
    if (!info.isFile() || !/\.(json|jsonc)$/i.test(path)) throw new Error('请选择已有的 .json 或 .jsonc 文件');
    if (info.size > MAX_DOCUMENT_BYTES) throw new Error('请选择小于 20 MB 的 JSON 文件');
    await access(path, constants.R_OK | constants.W_OK);
  }
  const state = await obtainService();
  const file = path ? await serviceRequest(state, 'open', 'POST', { path }) : null;
  const url = `http://127.0.0.1:${state.port}/${file ? '#jsonview=' + file.token : ''}`;
  console.log(`${file ? '原文件：' + file.path + '\n' : ''}打开地址：${url}`);
  if (!parsed.noBrowser) await browserOpen(url);
}
