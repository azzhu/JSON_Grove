import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, writeFile, mkdtemp, rm, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LocalDocumentStore, validateDocument } from '../local-service.mjs';

const html = await readFile(new URL('../JSON查看器.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
const core = script.slice(script.indexOf('const MAX_FILE_SIZE'), script.indexOf('const $ ='));
const context = vm.createContext({ Blob });
vm.runInContext(core + '\nglobalThis.api={parseDocument,buildIndex,jsonValueSource,replaceJsonValue,JsonFileWriter,searchNodes,visibleNodes,expandedToLevel};', context);
const api = context.api;
const raw = '\uFEFF { "id":9007199254740993, "flag":false, "option":"{\\"debug\\":false}" }\r\n\r\n[1,{"name":"中文"}]\r\n9007199254740995\r\nnull\r\n"hello"\r\ntrue\r\n';

test('JSONL records, number sources, embedded JSON, searching and physical error lines', () => {
  const parsed = api.parseDocument(raw, '记录.JSONL');
  assert.equal(parsed.data.length, 6);
  const indexed = api.buildIndex(parsed.data, parsed);
  const node = parts => indexed.nodes.find(n => JSON.stringify(n.parts) === JSON.stringify(parts));
  assert.equal(node([0, 'id']).numberSource, '9007199254740993');
  assert.equal(node([2]).numberSource, '9007199254740995');
  assert.equal(node([0, 'option']).decodedString, true);
  assert.equal(node([0, 'option', 'debug']).value, false);
  const result = api.searchNodes(indexed.nodes, '中文');
  assert.equal(result.matches.length, 1);
  assert.ok(api.visibleNodes(indexed.nodes, new Set(), result, true, 1500).rows.length >= 3);
  assert.equal(api.parseDocument(' \r\n\t\r\n', 'empty.jsonl').data.length, 0);
  assert.equal(api.parseDocument('{"a":1}', 'one.jsonl').data.length, 1);
  assert.equal(api.parseDocument('[1,2]\n', 'one.jsonl').data.length, 1);
  assert.throws(() => api.parseDocument('\uFEFF{}\r\n \r\n{broken}', 'bad.jsonl'), /第 3 行/);
  assert.throws(() => api.parseDocument('{} {}', 'bad.jsonl'), /第 1 行/);
  assert.throws(() => api.parseDocument('{\n"a":1\n}', 'bad.jsonl'), /第 1 行/);
  assert.throws(() => api.parseDocument('{}\n{}', 'bad.json'));
  assert.equal(api.parseDocument('{\n"a":1\n}', 'good.json').data.a, 1);
  assert.throws(() => api.buildIndex(api.parseDocument('0\n'.repeat(100000), 'large.jsonl').data), /100,000/);
});

test('field edits preserve BOM, blank lines, CRLF, other records, large numbers and string encoding', () => {
  const updated = api.replaceJsonValue(raw, [0, 'flag'], 'true', '记录.jsonl');
  assert.equal(updated, raw.replace('"flag":false', '"flag":true'));
  const decoded = api.replaceJsonValue(raw, [0, 'option', 'debug'], 'true', '记录.jsonl');
  assert.equal(decoded, raw.replace('debug\\":false', 'debug\\":true'));
  const nested = api.replaceJsonValue(raw, [1, 1], '{\n "name": "a b\\n\\\"c",\n "n":9007199254740997\n}', '记录.jsonl');
  assert.match(nested, /"n":9007199254740997/);
  assert.equal(api.parseDocument(nested, '记录.jsonl').data[1][1].name, 'a b\n"c');
  assert.equal(nested.split('\r\n').length, raw.split('\r\n').length);
  assert.equal(api.jsonValueSource(raw, [0, 'id'], '记录.jsonl'), '9007199254740993');
  assert.equal(JSON.parse(api.jsonValueSource(raw, [], '记录.jsonl')).length, 6);
  assert.throws(() => api.replaceJsonValue(raw, [0, 'flag'], '1\n2', '记录.jsonl'));
  assert.throws(() => api.replaceJsonValue(raw, [99], '{}', '记录.jsonl'), /记录已/);
  const root = api.replaceJsonValue(raw, [], '[\n {"id":9007199254740999},\n false\n]', '记录.jsonl');
  assert.equal(root, '\uFEFF{"id":9007199254740999}\r\nfalse\r\n');
  assert.throws(() => api.replaceJsonValue(raw, [], '{}', '记录.jsonl'), /记录数组/);
  const json = '\uFEFF{ "big":9007199254740993, "flag": false }\r\n';
  assert.equal(api.replaceJsonValue(json, ['flag'], 'true', 'old.json'), json.replace('false', 'true'));
});

test('browser writer validates JSONL and keeps autosave conflict protection', async () => {
  let disk = raw, writes = 0;
  const handle = { name: 'data.jsonl', queryPermission: async () => 'granted', getFile: async () => ({ text: async () => disk }),
    createWritable: async () => { let next; return { write: async value => { next = value; }, close: async () => { disk = next; writes++; }, abort: async () => {} }; } };
  const writer = new api.JsonFileWriter(handle, raw);
  const next = raw.replace('"flag":false', '"flag":true');
  await writer.save(next); assert.equal(disk, next); assert.equal(writes, 1);
  await assert.rejects(writer.save('{}\n{bad}'), /第 2 行/); assert.equal(disk, next);
  disk = '{}\n{"external":true}\n';
  await assert.rejects(writer.save(raw), error => error.code === 'EXTERNAL_MODIFICATION');
  assert.equal(writes, 1);
});

function makeElement(tag = 'div') {
  const attributes = {};
  return { tag, children: [], dataset: {}, style: { setProperty(k, v) { this[k] = v; } }, hidden: false, value: '', open: false, scrollTop: 0, scrollLeft: 0,
    classList: { toggle() {}, add() {}, remove() {} }, setAttribute(k,v) { attributes[k] = v; }, getAttribute(k) { return attributes[k]; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items.flatMap(x => x.tag === 'fragment' ? x.children : [x]); },
    get firstElementChild() { return this.children[0]; }, focus() {}, select() {}, scrollIntoView() {}, addEventListener() {}, remove() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    querySelector(selector) { return selector === 'kbd' ? makeElement('kbd') : null; }, querySelectorAll() { return []; } };
}
async function loadApp(initial = raw, name = 'data.jsonl') {
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"<>]+)"/g)].map(([, id]) => [id, makeElement()]));
  elements['theme-select'].options = ['grove','classic','ocean','lavender','midnight'].map(value => ({ value }));
  const viewer = makeElement(), events = {}, windowEvents = {}, storage = new Map();
  let disk = initial, writes = 0, pickerOptions;
  const file = () => ({ name, size: new Blob([disk]).size, lastModified: Date.now(), text: async () => disk });
  const handle = { name, queryPermission: async () => 'granted', requestPermission: async () => 'granted', isSameEntry: async other => other === handle, getFile: async () => file(),
    createWritable: async () => { let next; return { write: async raw => { next = raw; }, close: async () => { disk = next; writes++; }, abort: async () => {} }; } };
  const document = { hidden: false, body: makeElement(), getElementById: id => elements[id], createElement: makeElement, createElementNS: (_,tag) => makeElement(tag),
    createTextNode: text => ({ textContent: text }), createDocumentFragment: () => makeElement('fragment'), querySelector: s => s === '.viewer' ? viewer : null,
    querySelectorAll: () => [], addEventListener: (name,fn) => { events[name] = fn; } };
  const scope = vm.createContext({ document, navigator: { platform:'MacIntel' }, window: { addEventListener: (name,fn) => { windowEvents[name] = fn; },
      showOpenFilePicker: async options => { pickerOptions = options; return [handle]; } }, Blob, URL, console, crypto: { randomUUID }, setTimeout: () => 1, clearTimeout() {},
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v) },
    indexedDB: { open() { const request = {}; queueMicrotask(() => request.onerror()); return request; } } });
  const exposed = script.replace('initTheme();\ninitUiStyles();\nclearViewer();', 'globalThis.app={loadFile,openHistory,pollFile,showSourceEditor,showEditableValue,processEditorInput,restorePendingEdit,adoptDisk,get active(){return active},get nodes(){return nodes},get session(){return editSession},get records(){return records},set records(value){records=value}};\ninitTheme();\ninitUiStyles();\nclearViewer();');
  await vm.runInContext(exposed, scope);
  return { api: scope.app, elements, viewer, handle, file, events, windowEvents, get disk() { return disk; }, set disk(value) { disk = value; }, get writes() { return writes; }, get pickerOptions() { return pickerOptions; } };
}

test('full page picker, field/source autosave, external update, conflicts, drafts and history snapshots', async () => {
  const app = await loadApp();
  assert.equal(app.api.active, null); assert.equal(app.viewer.hidden, true);
  await app.elements['open-file'].onclick();
  assert.equal(app.api.active.name, 'data.jsonl'); assert.equal(app.viewer.hidden, false);
  assert.ok(app.pickerOptions.types[0].accept['application/json'].includes('.jsonl'));
  assert.equal(app.api.nodes[0].count, 6);
  const flag = app.api.nodes.find(n => JSON.stringify(n.parts) === '[0,"flag"]');
  app.api.showEditableValue(flag.index); app.elements['full-value'].value = 'true'; app.elements['full-value'].oninput();
  await app.api.processEditorInput(); assert.equal(app.writes, 1); assert.equal(app.disk, raw.replace('"flag":false', '"flag":true'));
  app.api.showSourceEditor(); app.elements['json-editor'].value = '{"new":1}\n{"new":2}\n'; app.elements['json-editor'].oninput();
  await app.api.processEditorInput(); assert.equal(app.writes, 2); assert.equal(app.api.nodes[0].count, 2); assert.ok(app.disk.startsWith('\uFEFF'));
  app.disk = '{"external":42}\nnull\n'; await app.api.pollFile(true);
  assert.equal(app.api.active.raw, app.disk); assert.equal(app.elements['json-editor'].value, app.disk);
  const valid = app.disk; app.disk = '{}\n{broken}'; await app.api.pollFile(true);
  assert.equal(app.api.active.raw, valid); assert.match(app.api.session.validationError, /第 2 行/);
  app.disk = valid; await app.api.pollFile(true);
  app.elements['json-editor'].value = '{}\n{broken}'; app.elements['json-editor'].oninput(); await app.api.processEditorInput();
  assert.match(app.api.session.validationError, /第 2 行/); assert.equal(app.writes, 2);
  app.disk = '{"conflict":true}\n'; await app.api.pollFile(true); assert.ok(app.api.session.conflict);
  await app.api.adoptDisk(); assert.equal(app.api.active.raw, app.disk); assert.equal(app.api.session.conflict, null);
  const record = { ...app.api.records[0], handle: null, raw: '{"snapshot":true}\n{"second":2}\n', pendingEdit: null };
  await app.api.openHistory(record); assert.equal(app.api.nodes[0].count, 2); assert.equal(app.api.active.syncEnabled, false);
  const draft = record.raw.replace('true', 'false');
  app.api.restorePendingEdit({ ...record, pendingEdit: { baseRaw: record.raw, raw: draft, editorDraft: null } });
  assert.equal(app.api.active.raw, draft); assert.equal(app.api.session.dirty, true);
});

test('drag drop and ordinary JSON regression', async () => {
  const app = await loadApp('{}\n{"via":"drop"}', 'drop.jsonl');
  let prevented = false;
  await app.events.drop({ preventDefault() { prevented = true; }, dataTransfer: { types: ['Files'], items: [{ kind: 'file', getAsFile: () => app.file() }] } });
  assert.equal(prevented, true); assert.equal(app.api.nodes[0].count, 2); assert.equal(app.api.active.name, 'drop.jsonl');
  const json = await loadApp('{\n "id":9007199254740993, "flag":false\n}\n', 'old.json');
  await json.elements['open-file'].onclick();
  assert.equal(json.api.nodes[0].type, 'object');
  const flag = json.api.nodes.find(n => n.key === 'flag'); json.api.showEditableValue(flag.index);
  json.elements['full-value'].value = 'true'; json.elements['full-value'].oninput(); await json.api.processEditorInput();
  assert.equal(json.disk, '{\n "id":9007199254740993, "flag":true\n}\n');
});

test('local service registration/write, invalid line rejection and disk conflicts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonview-jsonl-'));
  try {
    const path = join(dir, '中文 records.JSONL'); await writeFile(path, raw, { mode: 0o640 });
    const store = new LocalDocumentStore(), descriptor = await store.register(path), record = store.authorized(descriptor.token);
    assert.equal((await store.read(record)).content, raw);
    const updated = api.replaceJsonValue(raw, [0, 'flag'], 'true', 'data.jsonl');
    await store.write(record, raw, updated); assert.equal(await readFile(path, 'utf8'), updated); assert.equal((await stat(path)).mode & 0o777, 0o640);
    await assert.rejects(store.write(record, updated, '{}\n{bad}'), /第 2 行/); assert.equal(await readFile(path, 'utf8'), updated);
    await writeFile(path, '{}\n{"external":true}');
    await assert.rejects(store.write(record, updated, raw), error => error.status === 409);
    await writeFile(path, '{}\n\n{bad}'); await assert.rejects(store.register(path), /第 3 行/);
    await writeFile(path, ''); await store.register(path);
    assert.throws(() => validateDocument('{}\n{}', 'bad.json'));
    assert.throws(() => validateDocument('{}\r\n \r\n{bad}', 'bad.jsonl'), /第 3 行/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Run the real CLI in an isolated copy, so the user's service/history are untouched.
test('terminal relative JSONL path, HTTP read/write and reused service', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonview-cli-jsonl-'));
  const execute = promisify(execFile);
  const options = { cwd: dir, env: { ...process.env, JSONVIEW_PORT: '0' }, timeout: 15000 };
  try {
    for (const name of ['jsonview', 'jsonview-cli.mjs', 'local-service.mjs', 'JSON查看器.html']) await copyFile(new URL('../' + name, import.meta.url), join(dir, name));
    await writeFile(join(dir, 'relative 中文.jsonl'), raw);
    const { stdout } = await execute(process.execPath, [join(dir, 'jsonview'), '--no-browser', './relative 中文.jsonl'], options);
    const address = /http:\/\/127\.0\.0\.1:\d+\/#jsonview=[a-f0-9]+/.exec(stdout)?.[0];
    if (!address) throw new Error('CLI did not produce a file link');
    const url = new URL(address), token = url.hash.slice('#jsonview='.length);
    const state = JSON.parse(await readFile(join(dir, '.jsonview-runtime.json'), 'utf8'));
    const headers = { 'X-Jsonview-File': token, 'Content-Type': 'application/json' };
    const endpoint = url.origin + '/__jsonview/file';
    const response = await fetch(endpoint, { headers }); assert.equal(response.status, 200);
    assert.equal((await response.json()).content, raw);
    const updated = raw.replace('"flag":false', '"flag":true');
    const saved = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ expectedContent: raw, content: updated }) });
    assert.equal(saved.status, 200); assert.equal(await readFile(join(dir, 'relative 中文.jsonl'), 'utf8'), updated);
    const invalid = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ expectedContent: updated, content: '{}\n{bad}' }) });
    assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /第 2 行/);
    await execute(process.execPath, [join(dir, 'jsonview'), '--no-browser', './relative 中文.jsonl'], options);
    assert.equal(JSON.parse(await readFile(join(dir, '.jsonview-runtime.json'), 'utf8')).pid, state.pid);
    assert.equal((await fetch(url.origin)).status, 200);
  } finally {
    await execute(process.execPath, [join(dir, 'jsonview'), '--stop'], options).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
