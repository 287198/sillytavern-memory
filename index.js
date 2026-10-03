import './shared.js';
import './engine.js';
import './api.js';

const E = globalThis.ConversationMemoryEngine;
const R = globalThis.ConversationMemoryRules;
const API = globalThis.ConversationMemoryAPI;
const SLOT = 'conversation_memory';
let activeKey = '', state = null, controller = null, box = null, sessionKey = '', generation = 0, job = false;
let lastRecall = '', pendingImport = null, editId = '', page = 0, failurePage = 0, autoTimer = null, generating = false, enabled = true, jobCancelled = false;
const context = () => SillyTavern.getContext();
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('ConversationMemoryPlugin', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('chats');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('记忆存储无法打开，请检查浏览器存储权限'));
});
async function read(key) {
  const db = await database;
  return new Promise((resolve, reject) => {
    const req = db.transaction('chats').objectStore('chats').get(key);
    req.onsuccess = () => resolve(req.result || E.empty(key)); req.onerror = () => reject(new Error('记忆读取失败'));
  });
}
async function save(next, key = activeKey) {
  const db = await database;
  await new Promise((resolve, reject) => {
    const tx = db.transaction('chats', 'readwrite'); tx.objectStore('chats').put(next, key);
    tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(new Error('记忆保存失败，游标未推进'));
  });
  if (key === activeKey) { state = next; renderStatus(); renderMemories(); renderFailures(); }
}
function identity() {
  const ctx = context();
  if (ctx.groupId || ctx.characterId == null || !ctx.characters?.[ctx.characterId]) return '';
  const char = ctx.characters[ctx.characterId];
  const chatId = ctx.getCurrentChatId?.() || ctx.chatId || char.chat;
  return chatId ? 'st_' + R.MemoryLibraryModel.stableHash(char.avatar + '|' + chatId) + '_' + R.MemoryLibraryModel.stableHash('chat|' + char.avatar + '|' + chatId) : '';
}
function settings() {
  const ctx = context();
  const cfg = ctx.extensionSettings[SLOT] || {};
  return { ...E.defaults, ...cfg, apiKey: sessionKey || cfg.apiKey || '', characterName: ctx.name2, userName: ctx.name1 };
}
function chat() {
  const ctx = context();
  return ctx.chat.map(message => {
    const copy = { ...message };
    const stamp = message.swipe_info?.[message.swipe_id]?.send_date || message.send_date;
    if (ctx.timestampToMoment && stamp) {
      try {
        const parsed = ctx.timestampToMoment(stamp);
        if (parsed.isValid()) {
          copy.send_date = parsed.valueOf();
          if (message.swipe_info?.[message.swipe_id]) {
            copy.swipe_info = [...message.swipe_info];
            copy.swipe_info[message.swipe_id] = { ...message.swipe_info[message.swipe_id], send_date: parsed.valueOf() };
          }
        }
      } catch {}
    }
    return copy;
  });
}
function clearInjection() { context().setExtensionPrompt(SLOT, '', 1, 1, false, 0); lastRecall = ''; }
function notice(text) { if (box) box.querySelector('[data-cm-notice]').textContent = text; }
function memoryStamp(memory) { const { failures, ...data } = memory; return JSON.stringify(data); }
function progressNotice(p, verb = '总结') {
  if (p.attempt) notice(`${verb}第 ${p.start || '?'}–${p.end || '?'} 楼：${p.reason}；${p.retry ? `准备自动重试 ${p.attempt}/2` : '两次自动重试均失败，已转入失败记录'}。`);
  else if (p.start) notice(`正在${verb}第 ${p.start}–${p.end} 楼…`);
}
function completionNotice(label) {
  const pending = (state.failures || []).filter(row => row.status === 'pending').length;
  notice(`${label}结束，已保存进度。${pending ? `有 ${pending} 条失败记录，请在管理面板手动重试。` : ''}`);
}
function available() {
  if (!enabled) throw new Error('插件已禁用，请启用后操作记忆');
  if (!state || !activeKey || identity() !== activeKey) throw new Error('请选择单角色聊天并等待记忆加载');
}
function idle() { available(); if (job || controller?.busy()) throw new Error('总结任务运行中，请先暂停并等待当前请求结束'); }
function generationBusy() {
  const processor = context().streamingProcessor;
  return generating || Boolean(processor && (processor.isStreaming || processor.isFinished === false));
}
function node(tag, text, cls) {
  const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el;
}
function button(text, action, parent) {
  const el = node('button', text, 'menu_button cm-button'); el.type = 'button'; el.dataset.action = action; parent.append(el); return el;
}
function field(parent, key, label, type = 'text', hint = '') {
  const wrap = node('label', null, 'cm-field'); const span = node('span', label); wrap.append(span);
  const input = node('input'); input.type = type; input.dataset.setting = key; input.className = 'text_pole';
  if (type === 'checkbox') input.checked = Boolean(settings()[key]); else input.value = settings()[key] ?? '';
  if (type === 'password') { input.autocomplete = 'off'; input.value = sessionKey || context().extensionSettings[SLOT]?.apiKey || ''; }
  if (type === 'number') { input.min = ['contextFloors', 'depth', 'anchorFloor'].includes(key) ? '0' : '1'; input.step = '1'; }
  wrap.append(input); if (hint) wrap.append(node('small', hint)); parent.append(wrap); return input;
}
function details(parent, title, open = false) {
  const d = node('details'); d.open = open; d.append(node('summary', title)); const body = node('div', null, 'cm-fields'); d.append(body); parent.append(d); return body;
}
function shell() {
  if (document.getElementById('conversation-memory')) return;
  const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (!host) throw new Error('酒馆扩展设置面板未就绪');
  box = node('section', null, 'cm-panel'); box.id = 'conversation-memory';
  const main = node('details'); main.open = true; main.append(node('summary', '眠眠记忆 · Conversation Memory'));
  const body = node('div', null, 'cm-body'); main.append(body); box.append(main);
  body.append(node('p', '按楼层整理经历，在回复前唤起相关记忆。char 与 user 各一条算一楼。', 'cm-muted'));
  const stats = node('p'); stats.dataset.cmStats = ''; stats.setAttribute('role', 'status'); body.append(stats);
  const actions = node('div', null, 'cm-actions'); body.append(actions);
  button('补充总结', 'supplement', actions); button('暂停', 'pause', actions); button('整理核心记忆', 'digest', actions);
  const toggles = node('div', null, 'cm-fields'); body.append(toggles);
  field(toggles, 'auto', '自动总结', 'checkbox'); field(toggles, 'inject', '注入记忆', 'checkbox');
  const connect = details(body, '独立总结 API', true);
  field(connect, 'apiUrl', 'API 地址', 'url', 'OpenAI 兼容地址，例如 https://服务地址/v1。需要服务允许浏览器跨域。');
  field(connect, 'apiKey', 'API Key', 'password'); field(connect, 'saveKey', '保存密钥到酒馆设置', 'checkbox', '未勾选时密钥仅在本次页面会话中使用。');
  field(connect, 'model', '模型'); field(connect, 'maxTokens', '输出 token 上限', 'number'); field(connect, 'timeout', '请求超时秒数', 'number');
  button('测试连接并获取模型', 'models', connect); const models = node('datalist'); models.id = 'cm-models'; connect.append(models); connect.querySelector('[data-setting="model"]').setAttribute('list', models.id);
  const counting = details(body, '楼层与注入设置');
  field(counting, 'triggerFloors', '自动总结触发楼数', 'number'); field(counting, 'batchFloors', '每批总结楼数', 'number');
  field(counting, 'historyFloors', '回复历史楼数', 'number', '最近历史楼数，当前输入另外保留一次；只影响本次请求，不删除聊天。');
  field(counting, 'contextFloors', '总结前置上下文楼数', 'number'); field(counting, 'budget', '记忆注入字符预算', 'number', '与楼层数分开计算，上限 2800 字符，整条选取。');
  field(counting, 'depth', '记忆注入深度', 'number');
  const positionLabel = node('label','记忆挂载位置','cm-field'), position = node('select'); position.className = 'text_pole'; position.dataset.setting = 'position';
  for (const [value,label] of [[1,'聊天内（按深度）'],[0,'主提示后'],[2,'主提示前']]) { const option = node('option',label); option.value = value; position.append(option); }
  position.value = settings().position; positionLabel.append(position); counting.append(positionLabel);
  const extracting = details(body, '摘要与剧情时间提取');
  field(extracting, 'summaryPattern', '摘要正则', 'text', '使用第一个捕获组，例如 <memory_summary>([\\s\\S]*?)</memory_summary>。');
  field(extracting, 'summaryPath', '摘要 JSON 字段路径', 'text', '例如 memory.summary；不填写则使用正则或正文。');
  field(extracting, 'timePattern', '时间正则', 'text', '例如 <time>(.*?)</time>；可从状态栏取得日期。');
  field(extracting, 'timePath', '时间 JSON 字段路径');
  field(extracting, 'realTime', '使用现实发送时间作为发生时间', 'checkbox', '剧情聊天默认关闭，没有明确剧情日期就保留未知。');
  field(extracting, 'anchorFloor', '日期锚点楼层', 'number'); field(extracting, 'anchorDate', '该楼剧情日期', 'text', 'YYYY-MM-DD；只从指定楼层向后解析明确时间承接。');
  const timezone = field(extracting, 'timezoneOffset', '剧情时区 UTC 偏移小时', 'number'); timezone.min = '-12'; timezone.max = '14';
  field(extracting, 'maxPromptChars', '总结输入字符容量', 'number'); button('测试摘要与时间提取', 'extract', extracting);
  const previewFloor = field(extracting, 'previewFloor', '测试提取楼层', 'number'); previewFloor.value = settings().previewFloor || 1;
  const exchange = details(body, '导入导出与来源重算');
  button('导出记忆 JSON', 'export', exchange); button('导入记忆 JSON', 'import', exchange);
  button('确认从失效楼重算', 'rewind', exchange); button('游标归零检查全史', 'reset', exchange);
  field(exchange, 'rangeStart', '重算起始楼层', 'number').value = settings().rangeStart || 1;
  field(exchange, 'rangeEnd', '重算结束楼层', 'number').value = settings().rangeEnd || 1;
  button('重算指定楼层范围', 'range', exchange);
  const file = node('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true; file.dataset.cmFile = ''; exchange.append(file);
  const preview = node('div'); preview.dataset.cmImport = ''; exchange.append(preview);
  const recall = details(body, '测试召回与本次注入');
  const queryLabel = node('label', '召回测试问题'); const query = node('input'); query.dataset.cmQuery = ''; query.className = 'text_pole'; queryLabel.append(query); recall.append(queryLabel);
  button('测试召回', 'recall', recall); const rec = node('pre'); rec.dataset.cmRecall = ''; recall.append(rec);
  const records = node('div'); records.dataset.cmRecords = ''; body.append(records);
  const failures = details(body, '失败记录与手动重试'); failures.dataset.cmFailures = '';
  const credits = details(body, '开源项目致谢');
  credits.append(node('p', '记忆整理规则源自眠眠机，参考以下项目的公开架构与提示词设计原则；未引入它们的数据库、服务端或运行时依赖。', 'cm-muted'));
  for (const [name, license, url] of [
    ['Graphiti', 'Apache-2.0', 'https://github.com/getzep/graphiti'],
    ['Cognee', 'Apache-2.0', 'https://github.com/topoteretes/cognee'],
    ['Mem0', 'Apache-2.0', 'https://github.com/mem0ai/mem0'],
    ['Hexis', 'MIT', 'https://github.com/QuixiAI/Hexis'],
    ['OmniMemory', 'MIT', 'https://github.com/omnirexflora-labs/omnimemory'],
    ['Ombre-Brain', 'MIT', 'https://github.com/P0luz/Ombre-Brain']
  ]) {
    const row = node('p'), link = node('a', name); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    row.append(link, document.createTextNode(' · ' + license)); credits.append(row);
  }
  const repo = node('a', '插件 GitHub 与完整致谢'); repo.href = 'https://github.com/287198/sillytavern-memory'; repo.target = '_blank'; repo.rel = 'noopener noreferrer'; credits.append(repo);
  const status = node('p'); status.dataset.cmNotice = ''; status.setAttribute('role', 'status'); body.append(status);
  host.append(box);
  box.addEventListener('input', updateSetting); box.addEventListener('change', updateSetting);
  box.addEventListener('click', event => {
    const action = event.target.closest('button[data-action]'); if (action) handle(action).catch(error => notice(error.message));
  });
  file.addEventListener('change', () => previewImport(file.files?.[0]).catch(error => notice(error.message)));
}
function updateSetting(event) {
  const key = event.target.dataset.setting; if (!key) return;
  const input = event.target; const ctx = context(); const cfg = ctx.extensionSettings[SLOT] ||= {};
  const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim();
  if (input.type === 'number' && (!Number.isFinite(value) || value < Number(input.min || 0))) return;
  if (key === 'saveKey' && !value) sessionKey = sessionKey || cfg.apiKey || '';
  if (key === 'apiKey') sessionKey = input.value; else cfg[key] = value;
  if (key === 'realTime') cfg.dateMode = value ? 'real' : 'story';
  if (cfg.saveKey) cfg.apiKey = key === 'apiKey' ? input.value : sessionKey || cfg.apiKey || ''; else delete cfg.apiKey;
  ctx.saveSettingsDebounced();
  if (key === 'inject' && !value) clearInjection();
  if (key === 'auto') scheduleAuto();
}
function renderStatus() {
  if (!box) return;
  const total = E.floors(chat()).length; const invalid = state ? E.invalidFrom(state, chat()) : -1;
  const pending = (state?.failures || []).filter(row => row.status === 'pending').length;
  box.querySelector('[data-cm-stats]').textContent = state ? `${context().name2} · 已总结 ${state.cursor} / ${total} 楼 · 已检查至 ${E.through(state)} 楼 · 下一批从 ${E.through(state) + 1} 楼 · 事件 ${state.periods.length} 条${pending ? ` · 待重试 ${pending} 条` : ''}${invalid >= 0 ? ` · 第 ${invalid + 1} 楼起来源有修改` : ''}` : '请选择单角色聊天';
  box.querySelector('[data-cm-recall]').textContent = lastRecall || '本次尚未注入记忆。';
}
function renderFailures() {
  if (!box) return;
  const host = box.querySelector('[data-cm-failures]'); host.replaceChildren();
  const all = (state?.failures || []).slice().sort((a,b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.updatedAt - a.updatedAt);
  host.append(node('p', '首次失败后自动重试两次；仍失败则继续后续楼层，失败批次在此手动补齐。原因不包含 API 密钥，记录保存在当前浏览器，不随记忆 JSON 导出。', 'cm-muted'));
  if (!all.length) { host.append(node('p', '暂无失败记录。')); return; }
  failurePage = Math.min(failurePage, Math.ceil(all.length / 20) - 1);
  for (const row of all.slice(failurePage * 20, failurePage * 20 + 20)) {
    const article = node('article', null, 'cm-record'); article.dataset.failureId = row.id;
    const operation = { summary: '补充总结', range: '范围重算', digest: '核心整理' }[row.operation] || row.operation;
    article.append(node('strong', `${operation} · ${row.operation === 'digest' ? `${row.blockIds?.length || 0} 条事件` : `第 ${row.start}–${row.end} 楼`} · ${{pending:'待重试',resolved:'已解决',invalidated:'来源失效'}[row.status] || row.status}`));
    article.append(node('p', `累计尝试 ${row.attempts} 次；最近一轮 ${row.lastAttempts} 次。${new Date(row.updatedAt).toLocaleString()}`));
    article.append(node('p', row.reason || '无错误详情'));
    if (row.invalidationReason) article.append(node('p', row.invalidationReason));
    const history = node('details'); history.append(node('summary', '查看失败原因历史'));
    for (const item of row.history || []) history.append(node('p', `第 ${item.attempt} 次 · ${new Date(item.at).toLocaleString()} · ${item.reason}`));
    article.append(history);
    if (row.status === 'pending') { const retry = button('手动重试', 'retry-failure', article); retry.dataset.id = row.id; }
    host.append(article);
  }
  const nav = node('div', null, 'cm-actions'); button('失败上一页', 'failure-previous', nav); nav.append(node('span', `${failurePage + 1} / ${Math.ceil(all.length / 20)}`)); button('失败下一页', 'failure-next', nav); host.append(nav);
}
function renderMemories() {
  if (!box) return;
  const host = box.querySelector('[data-cm-records]'); host.replaceChildren(); if (!state) return;
  const all = state.cores.concat(state.periods.slice().reverse());
  host.append(node('h3', '已保存记忆'));
  if (!all.length) { host.append(node('p', '还没有记忆。配置 API 后点击补充总结，或导入记忆 JSON。', 'cm-muted')); return; }
  page = Math.min(page, Math.max(0, Math.ceil(all.length / 20) - 1));
  for (const record of all.slice(page * 20, page * 20 + 20)) {
    const article = node('article', null, 'cm-record');
    article.append(node('strong', record.kind === 'digested_block' ? '核心记忆' : record.title || record.timeLabel || '事件记忆'));
    article.append(node('p', record.eventSummary || record.summary || R.MemoryLibraryModel.corePromptText(record)));
    if (record.state !== 'active') article.append(node('small', '来源已变化，旧记录保留，当前不参与召回。'));
    const edit = button('查看与编辑', 'edit', article); edit.dataset.id = record.id;
    if (record.id === editId) {
      const evidence = node('details'); evidence.append(node('summary', '来源、事实与时间依据'));
      evidence.append(node('pre', JSON.stringify({ sourceRefs: record.sourceRefs, activityRefs: record.activityRefs,
        facts: record.facts, timeAnchors: record.timeAnchors, occurredAt: record.occurredAt, knownAt: record.knownAt }, null, 2)));
      article.append(evidence);
      if (record.kind === 'digested_block' && record.items?.length) {
        for (const item of record.items) {
          const wrap = node('label', '核心条目'); const input = node('textarea'); input.value = item.text; input.dataset.item = item.id; input.rows = 3; wrap.append(input); article.append(wrap);
        }
      } else {
        for (const [key, name] of [['eventSummary', '事件摘要'], ['summary', '完整记忆正文']]) {
          const wrap = node('label', name); const input = node('textarea'); input.value = record[key] || ''; input.dataset.edit = key; input.rows = key === 'summary' ? 8 : 3; wrap.append(input); article.append(wrap);
        }
      }
      const saveButton = button('保存修改并保护内容', 'save-edit', article); saveButton.dataset.id = record.id;
    }
    host.append(article);
  }
  const nav = node('div', null, 'cm-actions'); button('上一页', 'previous', nav); nav.append(node('span', `${page + 1} / ${Math.ceil(all.length / 20)}`)); button('下一页', 'next', nav); host.append(nav);
}
function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const anchor = node('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function previewImport(file) {
  idle(); if (!file) return;
  if (file.size > R.MemoryTransfer.MAX_BYTES) throw new Error('记忆 JSON 超过 20 MB');
  const key = activeKey; const payload = R.MemoryTransfer.validate(await file.text());
  if (identity() !== key) throw new Error('聊天已切换，请在目标聊天重新选择文件');
  const report = R.MemoryTransfer.merge(payload, state, key); pendingImport = { payload, key };
  const preview = box.querySelector('[data-cm-import]'); preview.replaceChildren();
  preview.append(node('p', `来源：${payload.subject.name || payload.subject.id} → ${context().name2} / 当前聊天。新增 ${report.added}，重复 ${report.duplicates}，冲突保留 ${report.conflicts}，核心候选 ${report.coreCandidates}。`));
  for (const record of report.writes.slice(0, 10)) preview.append(node('p', record.eventSummary || record.summary || R.MemoryLibraryModel.corePromptText(record)));
  button('确认追加导入', 'confirm-import', preview); button('取消导入', 'cancel-import', preview);
  notice('先查看候选记忆。确认导入将追加内容，保留已有记忆和总结游标。');
}
async function handle(btn) {
  const action = btn.dataset.action;
  if (action === 'pause') { jobCancelled = true; controller?.pause(); notice('已请求暂停，等待当前请求结束；已保存的批次保留。'); return; }
  if (action === 'models') {
    notice('正在测试独立总结连接…'); const ids = await API.models(settings());
    const list = box.querySelector('#cm-models'); list.replaceChildren(...ids.map(id => { const option = node('option'); option.value = id; return option; }));
    notice(`连接成功，取得 ${ids.length} 个模型。选择或填写总结模型后开始。`); return;
  }
  if (action === 'supplement') {
    available(); if (job) throw new Error('请等待当前记忆操作结束');
    if (generationBusy()) throw new Error('角色仍在回复，请等本楼完成后再总结');
    API.validate(settings()); notice('从已检查进度下一楼开始补充总结；旧失败在失败记录中手动重试。'); await controller.run(true); completionNotice('补充总结'); return;
  }
  if (action === 'recall') {
    available(); const result = await E.recall(state, box.querySelector('[data-cm-query]').value, settings());
    lastRecall = result.text || '没有命中相关记忆。'; renderStatus(); notice(`召回使用 ${result.used || 0} 字符，来源条目 ${result.items?.length || 0}。`); return;
  }
  if (action === 'extract') {
    available(); const floor = Math.max(1, Math.floor(settings().previewFloor || 1));
    const source = { ...state, cursor: floor - 1, anchorAt: state.activities.filter(a => a.sourceOrder < floor && !a.timeUnknown).at(-1)?.occurredAt || 0 };
    const result = E.prepare(source, chat(), { ...settings(), batchFloors: 1 });
    const row = result.prepared.activities[0]; notice(row ? `第 ${floor} 楼（消息索引 ${E.floors(chat())[floor-1].index}），${row.source === 'preset_summary' ? '命中已有摘要' : '未命中摘要，回退正文'}：${row.summary}\n时间：${row.timeLabel}；${row.timeUnknown ? '具体剧情日期未知' : new Date(row.occurredAt).toISOString()}` : '该楼不存在。'); return;
  }
  if (action === 'export') {
    available(); const ctx = context();
    download(R.MemoryTransfer.serialize(state, { id: activeKey, name: ctx.name2, userName: ctx.name1,
      source: { application: 'sillytavern', characterId: ctx.characters[ctx.characterId].avatar, chatId: ctx.getCurrentChatId?.() || ctx.chatId } },
      { name: 'sillytavern-memory', version: '0.1.0' }), 'conversation-memory.json'); return;
  }
  if (action === 'import') { idle(); const input = box.querySelector('[data-cm-file]'); input.value = ''; input.click(); return; }
  if (action === 'cancel-import') { pendingImport = null; box.querySelector('[data-cm-import]').replaceChildren(); return; }
  if (action === 'confirm-import') {
    idle(); if (!pendingImport || pendingImport.key !== activeKey) throw new Error('请重新选择导入文件');
    const result = R.MemoryTransfer.merge(pendingImport.payload, state, activeKey); await save({ ...state, ...result.data });
    pendingImport = null; box.querySelector('[data-cm-import]').replaceChildren(); notice(`导入完成：新增 ${result.added}，重复 ${result.duplicates}，冲突保留 ${result.conflicts}。`); return;
  }
  if (action === 'previous' || action === 'next') { page = Math.max(0, page + (action === 'next' ? 1 : -1)); renderMemories(); return; }
  if (action === 'failure-previous' || action === 'failure-next') { failurePage = Math.max(0, failurePage + (action === 'failure-next' ? 1 : -1)); renderFailures(); return; }
  if (action === 'retry-failure') {
    idle(); if (generationBusy()) throw new Error('角色仍在回复，请等本楼完成后再重试');
    API.validate(settings());
    const failure = state.failures.find(row => row.id === btn.dataset.id && row.status === 'pending');
    if (!failure) throw new Error('失败记录已解决或失效');
    if (failure.operation === 'summary') { await controller.retry(failure.id); completionNotice('手动重试'); }
    else if (failure.operation === 'range') await recalculateRange(failure);
    else if (failure.operation === 'digest') await digestMemory(failure);
    return;
  }
  if (action === 'edit') { idle(); editId = editId === btn.dataset.id ? '' : btn.dataset.id; renderMemories(); return; }
  if (action === 'save-edit') {
    idle(); const next = structuredClone(state); const row = next.periods.concat(next.cores).find(r => r.id === btn.dataset.id);
    const article = btn.closest('article');
    article.querySelectorAll('[data-edit]').forEach(input => { row[input.dataset.edit] = input.value; });
    article.querySelectorAll('[data-item]').forEach(input => { const item = row.items.find(i => i.id === input.dataset.item); item.text = input.value; item.locked = true; item.userEditedAt = Date.now(); });
    if (row.items?.some(item => !item.text.trim())) throw new Error('核心条目不能为空');
    if (!row.items?.length && !row.summary.trim()) throw new Error('记忆正文不能为空');
    row.userEditedAt = Date.now(); row.updatedAt = Date.now(); row.pinned = true; editId = ''; await save(next); notice('修改已保存，内容受保护。'); return;
  }
  if (action === 'rewind' || action === 'reset') {
    idle(); const invalid = action === 'reset' ? 0 : E.invalidFrom(state, chat());
    if (invalid < 0) { notice('已总结来源没有变化。'); return; }
    if (!confirm(`从第 ${invalid + 1} 楼重新检查？既有记录保留，来源已改变的未手改记录暂停召回。`)) return;
    const next = structuredClone(state);
    if (action !== 'reset') {
      retireSources(next, invalid + 1, Infinity);
    }
    next.cursor = invalid; next.processedThrough = invalid; next.signatures = next.signatures.slice(0, invalid);
    (next.failures || []).forEach(row => { if (row.status === 'pending' && (row.end > invalid || row.operation === 'digest')) { row.status = 'invalidated'; row.updatedAt = Date.now(); } });
    next.anchorAt = next.activities.filter(a => a.sourceOrder <= invalid && a.occurredAt).at(-1)?.occurredAt || 0;
    await save(next); notice(`游标调整为 ${invalid}，点击补充总结继续。`); return;
  }
  if (action === 'range') { await recalculateRange(); return; }
  if (action === 'digest') { await digestMemory(); return; }
}
async function recalculateRange(failure) {
    idle(); if (generationBusy()) throw new Error('角色仍在回复，请等本楼完成后再重算');
    const cfg = settings(), snapshot = chat(), list = E.floors(snapshot); API.validate(cfg);
    let from = Number(failure?.start || cfg.rangeStart), to = Number(failure?.end || cfg.rangeEnd);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > list.length) throw new Error('请输入有效的起止楼层');
    const sourceFloors = new Map(state.activities.filter(a => localSource(a,state)).map(a => [a.id,a.sourceOrder]));
    let expanded;
    do {
      expanded = false;
      for (const p of state.periods.filter(p => p.state === 'active' && !p.pinned && !p.userEditedAt)) {
        const covered = (p.activityRefs || []).map(id => sourceFloors.get(id)).filter(n => n > 0 && n <= list.length);
        if (covered.some(n => n >= from && n <= to)) {
          const lower = Math.min(from,...covered), upper = Math.max(to,...covered);
          if (lower !== from || upper !== to) { from = lower; to = upper; expanded = true; }
        }
      }
    } while (expanded);
    if (!confirm(`重算第 ${from}–${to} 楼？结果全部校验后保存，保留手改记忆；连续总结游标不跳过未处理楼层。`)) return;
    job = true; jobCancelled = false;
    const key = activeKey, before = memoryStamp(state), previous = controller, originalThrough = E.through(state);
    const info = { id: failure?.id, operation: 'range', start: from, end: to, signatures: list.slice(from-1,to).map(f => f.signature) };
    const priorFailure = failure || state.failures.find(row => row.operation === 'range' && row.status === 'pending' && row.start === from && row.end === to && JSON.stringify(row.signatures) === JSON.stringify(info.signatures));
    if (priorFailure) info.id = priorFailure.id;
    let staged = structuredClone(state); retireSources(staged, from, to); staged.cursor = from - 1; staged.processedThrough = from - 1;
    staged.failures = staged.failures.filter(row => row.operation !== 'summary');
    staged.signatures = list.slice(0, from - 1).map(f => f.signature);
    staged.anchorAt = staged.activities.filter(a => a.sourceOrder < from && !a.timeUnknown).at(-1)?.occurredAt || 0;
    const sourceUnchanged = () => { const fresh = E.floors(chat()); return enabled && identity() === key && state && memoryStamp(state) === before && list.every((f,i) => fresh[i]?.signature === f.signature); };
    const combined = { ok: true, count: 0, history: [] }; let exhausted = false;
    const rangeController = E.create({ getState: () => staged, getChat: () => snapshot.slice(0, list[to-1].index+1), getSettings: settings,
      isCurrent: sourceUnchanged, save: async next => { staged = next; }, request: request => API.generate(settings(), request.prompt), operation: 'range',
      batchResult: result => { const beforeCount = combined.count; combined.count += result.count; combined.history.push(...result.history.map(row => ({...row,attempt:beforeCount+row.attempt}))); combined.ok = result.ok; combined.reason = result.reason; },
      recordFailure: async () => { exhausted = true; const next = structuredClone(state); E.recordFailure(next, info, combined); await save(next,key); },
      progress: p => progressNotice(p, '重算') });
    controller = rangeController;
    try {
      await rangeController.run(true);
      if (exhausted) { completionNotice('范围重算'); return; }
      if (E.through(staged) !== to || !sourceUnchanged()) throw new Error('范围任务未完成或来源变化，重算结果未保存');
      const updatedSignatures = [...state.signatures];
      for (let i=from-1; i<Math.min(to,originalThrough); i++) updatedSignatures[i]=list[i].signature;
      staged.cursor = state.cursor; staged.processedThrough = originalThrough; staged.signatures = updatedSignatures;
      staged.failures = structuredClone(state.failures);
      if (priorFailure) E.recordFailure(staged, info, combined);
      staged.failures.forEach(row => { if (row.operation === 'summary' && row.status === 'pending' && row.start >= from && row.end <= to) { row.status = 'resolved'; row.resolvedAt = row.updatedAt = Date.now(); row.resolvedBy = 'range'; } });
      E.advanceCursor(staged);
      staged.anchorAt = state.anchorAt; await save(staged,key); notice('指定范围已重算并保存；已补齐的失败楼层计入连续总结游标。');
    } finally { job = false; if (activeKey === key && controller === rangeController) controller = previous; }
}
async function digestMemory(failure) {
    idle(); API.validate(settings());
    if (E.invalidFrom(state,chat()) >= 0) throw new Error('已总结来源有修改，请先确认失效楼层并重算');
    job = true; jobCancelled = false; const key = activeKey, original = structuredClone(state), before = memoryStamp(state);
    const candidates = state.periods.filter(row => row.state === 'active' && row.digestionState !== 'digested').slice(0,8);
    const info = { id: failure?.id, operation: 'digest', blockIds: failure?.blockIds || candidates.map(row => row.id) };
    const current = () => enabled && identity() === key && state && memoryStamp(state) === before && E.invalidFrom(original,chat()) < 0;
    try {
      if (failure && failure.blockSignature !== JSON.stringify(state.periods.filter(row => info.blockIds.includes(row.id)))) {
        const next = structuredClone(state), row = next.failures.find(row => row.id === failure.id);
        row.status = 'invalidated'; row.updatedAt = Date.now(); row.invalidationReason = '核心整理来源已变化，请重新选择事件整理。';
        await save(next,key); notice(row.invalidationReason); return;
      }
      notice('正在整理核心记忆…');
      const result = await E.retryTask({ isCurrent: current, isPaused: () => jobCancelled, getSettings: settings,
        progress: p => notice(`核心整理：${p.reason}；${p.retry ? `准备自动重试 ${p.attempt}/2` : '已转入失败记录'}。`),
        task: () => E.digest(original, settings(), request => { info.blockIds = request.blockIds; return API.generate(settings(), request.prompt); }, failure?.blockIds) });
      if (result.cancelled) { notice('核心整理已暂停，原记忆保留。'); return; }
      info.blockSignature = JSON.stringify(original.periods.filter(row => info.blockIds.includes(row.id)));
      const next = result.ok ? result.value : structuredClone(state); next.failures = structuredClone(state.failures);
      const priorFailure = failure || state.failures.find(row => row.operation === 'digest' && row.status === 'pending' && JSON.stringify(row.blockIds) === JSON.stringify(info.blockIds) && row.blockSignature === info.blockSignature);
      if (priorFailure) info.id = priorFailure.id;
      if (!result.ok || priorFailure) E.recordFailure(next, info, result);
      await save(next, key); completionNotice('核心整理');
    } finally { job = false; } return;
}
function retireSources(next, from, to) {
  const affected = new Set(next.activities.filter(a => localSource(a,next) && a.sourceOrder >= from && a.sourceOrder <= to).map(a => a.id));
  const retired = new Set();
  next.activities.forEach(a => { if (affected.has(a.id) && !a.userEditedAt && !a.pinned) a.state = 'retired_source'; });
  next.periods.forEach(p => {
    if (!p.userEditedAt && !p.pinned && (p.activityRefs || []).some(id => affected.has(id))) { p.state = 'retired_source'; retired.add(p.id); }
  });
  next.cores.forEach(core => (core.items || []).forEach(item => {
    if (!item.locked && !item.pinned && !item.userEditedAt && retired.has(item.originBlockId)) item.state = 'retired_source';
  }));
}
function localSource(row, memory) { return (row.sourceRefs || []).some(ref => ref.startsWith('sillytavern:' + memory.charId + ':floor:')); }
async function loadChat() {
  if (!enabled) return;
  const token = ++generation; controller?.pause(); jobCancelled = true; clearInjection(); state = null; pendingImport = null; editId = ''; page = failurePage = 0;
  activeKey = identity(); renderStatus(); renderMemories(); renderFailures(); if (!activeKey) return;
  const key = activeKey; const loaded = await read(key); if (token !== generation || identity() !== key) return;
  state = loaded; state.failures ||= []; state.processedThrough = E.through(state);
  controller = E.create({ getState: () => state, getChat: chat, getSettings: settings, isCurrent: () => enabled && activeKey === key && identity() === key,
    save: next => save(next, key), request: request => API.generate(settings(), request.prompt),
    progress: progress => { renderStatus(); progressNotice(progress); } });
  renderStatus(); renderMemories(); renderFailures(); scheduleAuto();
}
function scheduleAuto() {
  clearTimeout(autoTimer);
  if (!enabled || !settings().auto || !state) return;
  autoTimer = setTimeout(async () => {
    try { if (!job && !generationBusy()) { API.validate(settings()); await controller.run(false); renderStatus(); } }
    catch (error) { notice(error.message); }
  }, 800);
}
globalThis.conversationMemoryInterceptor = async function (requestChat, _contextSize, _abort, type) {
  clearInjection();
  if (!enabled) return;
  if (!['normal', 'regenerate', 'swipe', 'continue'].includes(type)) return;
  try {
    available(); const key = activeKey; const cfg = settings();
    if (cfg.inject) {
      const latest = E.floors(chat()).slice(-Math.max(1, Number(cfg.historyFloors) || 20));
      const query = latest.filter(f => f.user).slice(-3).map(f => f.body).join('\n');
      const result = await E.recall(state, query, cfg);
      if (identity() !== key) return;
      lastRecall = result.text;
      const position = [0,1,2].includes(Number(cfg.position)) ? Number(cfg.position) : 1;
      context().setExtensionPrompt(SLOT, lastRecall, position, Math.max(0, Number(cfg.depth) || 0), false, 0);
    }
    // Current SillyTavern builds a separate coreChat before invoking interceptors.
    // Refuse to splice if a version supplies the persisted chat array itself.
    if (requestChat !== context().chat && Array.isArray(requestChat)) {
      const eligible = E.floors(requestChat).map(f => f.index);
      const currentInput = requestChat[eligible.at(-1)]?.is_user ? 1 : 0;
      const keep = new Set(eligible.slice(-(Math.max(1, Number(cfg.historyFloors) || 20) + currentInput)));
      for (let i = requestChat.length - 1; i >= 0; i--) if (eligible.includes(i) && !keep.has(i)) requestChat.splice(i, 1);
    }
    renderStatus();
  } catch (error) { clearInjection(); notice('本次记忆召回未完成：' + error.message); }
};
async function init() {
  shell(); await loadChat(); const ctx = context(); const types = ctx.eventTypes || ctx.event_types;
  ctx.eventSource.on(types.CHAT_CHANGED, () => loadChat().catch(error => notice(error.message)));
  if (types.GENERATION_STARTED) ctx.eventSource.on(types.GENERATION_STARTED, () => { generating = true; clearTimeout(autoTimer); });
  if (types.GENERATION_ENDED) ctx.eventSource.on(types.GENERATION_ENDED, () => { generating = false; renderStatus(); scheduleAuto(); });
  for (const name of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) if (types[name]) ctx.eventSource.on(types[name], () => { renderStatus(); scheduleAuto(); });
}
export function onDisable() { enabled = false; generation++; jobCancelled = true; clearTimeout(autoTimer); controller?.pause(); clearInjection(); }
export function onEnable() { enabled = true; return loadChat().catch(error => notice(error.message)); }
export function onDelete() { onDisable(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(error => console.error('[ConversationMemory]', error.message)), { once: true });
else init().catch(error => console.error('[ConversationMemory]', error.message));
