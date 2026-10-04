import './shared.js';
import './engine.js';
import './api.js';
import './summary-adapter.js';
import './vector.js';
import './console.js';

const E = globalThis.ConversationMemoryEngine;
const R = globalThis.ConversationMemoryRules;
const API = globalThis.ConversationMemoryAPI;
const Summary = globalThis.ConversationMemorySummary;
const vectors = globalThis.ConversationMemoryVector.create({api:API});
const SLOT = 'conversation_memory';
let activeKey = '', state = null, controller = null, box = null, sessionKey = '', generation = 0, job = false;
let lastRecall = '', pendingImport = null, editId = '', page = 0, failurePage = 0, autoTimer = null, generating = false, enabled = true, jobCancelled = false;
let sessionVectorKey = '', regexModule = null, detectionToken = 0, detectionCandidates = [], timeCandidates=[];
let vectorTimer=null,vectorTask=null,vectorQueued=false,vectorPaused=false,vectorEpoch=0;
let actionFeedback=null;
let management=null;
let hostIsGenerating=null;
const finishedProcessors=new WeakSet();
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
  if (key === activeKey) { state = next; renderStatus(); renderMemories(); renderFailures(); queueVectorIndex(); }
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
  return { ...E.defaults, vectorMinScore:0.45, ...cfg, summarySource:state?.summarySource==='raw'?'raw':'auto',autoSummary:cfg.autoSummary??(!cfg.summaryPattern&&!cfg.summaryPath||Boolean(cfg.summaryAutoSelection)), autoTime:cfg.autoTime??(!cfg.timePattern&&!cfg.timePath||Boolean(cfg.timeAutoSelection)), apiKey: sessionKey || cfg.apiKey || '', characterName: ctx.name2, userName: ctx.name1 };
}
function vectorSettings() { const cfg=settings();return {...cfg,apiLabel:'向量',apiUrl:cfg.vectorApiUrl||'',apiKey:sessionVectorKey||cfg.vectorApiKey||'',model:cfg.vectorModel||''}; }
function vectorStatus(text) { if(box)box.querySelector('[data-cm-vector-status]').textContent=text; }
function queueVectorIndex(resume=true) {
  clearTimeout(vectorTimer);vectorTimer=null;if(resume)vectorPaused=false;
  vectorQueued=Boolean(enabled&&!vectorPaused&&settings().vectorEnabled&&state&&activeKey&&identity()===activeKey);
  if(!vectorQueued)return;
  vectorStatus('向量索引已排队，当前记忆操作完成后自动补建；未改变的内容复用缓存。');
  vectorTimer=setTimeout(()=>{
    vectorTimer=null;if(!enabled||vectorPaused||!settings().vectorEnabled||!state)return;
    if(job||controller?.busy()||generationBusy()||vectorTask)return;
    vectorQueued=false;
    runVectorIndex(false,true).catch(()=>{});
  },700);
}
async function runVectorIndex(force=false,automatic=false) {
  if(vectorTask)throw new Error('向量索引正在更新，完成后会自动补建最新内容');
  available();const connection=vectorSettings(),key=activeKey,stamp=memoryStamp(state),epoch=vectorEpoch;
  const current=()=>enabled&&!vectorPaused&&epoch===vectorEpoch&&identity()===key&&state&&memoryStamp(state)===stamp&&(!automatic||settings().vectorEnabled&&!generationBusy())&&JSON.stringify([vectorSettings().apiUrl,vectorSettings().model,vectorSettings().apiKey])===JSON.stringify([connection.apiUrl,connection.model,connection.apiKey]);
  vectorTask=(async()=>{
    try {
      API.validate(connection);const candidates=state.periods.concat(state.cores).filter(row=>row.state==='active');
      vectorStatus(automatic?'正在自动补建向量索引…':'正在建立/更新向量索引…');
      const result=await vectors.index({charId:key,candidates,settings:connection,isCurrent:current,force,progress:p=>{if(current())vectorStatus(`${automatic?'自动补建':'索引'}进度 ${p.cached+p.created}/${p.total} 条…`);}});
      if(current())vectorStatus(`${automatic?'自动补建完成':'向量索引就绪'}：${result.total} 条，新增 ${result.created} 条，复用 ${result.cached} 条。`);
      return result;
    } catch(error){if(identity()===key&&epoch===vectorEpoch)vectorStatus(`${automatic?'自动补建未完成：':''}${E.failureReason(error,connection)}。可点击更新重试；记忆已保存，本地召回仍可用。`);throw error;}
  })().finally(()=>{vectorTask=null;if(vectorQueued)queueVectorIndex(false);});
  return vectorTask;
}
async function recallMemory(query) {
  const key=activeKey, memory=state, stamp=memoryStamp(state), cfg=settings(), connection=vectorSettings();
  const vector=cfg.vectorEnabled ? {search:request=>vectors.search({...request,settings:connection})} : undefined;
  const result=await E.recall(memory,query,cfg,vector);
  if(!enabled||identity()!==key||!state||memoryStamp(state)!==stamp)throw Error('聊天或记忆来源已变化，本次召回已取消');
  if(cfg.vectorEnabled && (!settings().vectorEnabled||JSON.stringify([vectorSettings().apiUrl,vectorSettings().model,vectorSettings().apiKey])!==JSON.stringify([connection.apiUrl,connection.model,connection.apiKey])))return E.recall(memory,query,settings());
  if(cfg.vectorEnabled)vectorStatus(result.route==='vector'?'本次使用向量增强召回。'+(result.vectorReason||''):'本次使用本地词法召回。'+(result.vectorReason||''));
  return result;
}
async function refreshDetection() {
  if(!box)return;
  const token=++detectionToken, ctx=context();let manager,preset={},scripts=[];
  try { manager=ctx.getPresetManager?.();preset=manager?.getPresetSettings?.(manager.getSelectedPresetName())||{}; } catch {}
  try {
    if(ctx.getRegexScripts)scripts=ctx.getRegexScripts({allowedOnly:true});
    else { regexModule ||= import('/scripts/extensions/regex/engine.js').catch(()=>null);const module=await regexModule;
      if(module?.getRegexScripts)scripts=module.getRegexScripts({allowedOnly:true});
      else {
        scripts=[...(ctx.extensionSettings.regex||[])];
        const character=ctx.characters?.[ctx.characterId];
        if(ctx.extensionSettings.character_allowed_regex?.includes(character?.avatar))scripts.push(...(character.data?.extensions?.regex_scripts||[]));
        if(manager && ctx.extensionSettings.preset_allowed_regex?.[manager.apiId]?.includes(manager.getSelectedPresetName()))scripts.push(...(manager.readPresetExtensionField({path:'regex_scripts'})||[]));
      }
    }
  } catch {}
  if(token!==detectionToken||identity()!==activeKey)return;
  const input={scripts,messages:chat(),preset};
  detectionCandidates=Summary.detect(input);timeCandidates=Summary.detectTime(input);
  applyDetection('summary',detectionCandidates);applyDetection('time',timeCandidates);
}
function applyDetection(kind,candidates) {
  const isTime=kind==='time',name=isTime?'剧情时间':'摘要',pattern=isTime?'timePattern':'summaryPattern',path=isTime?'timePath':'summaryPath',auto=isTime?'autoTime':'autoSummary',selection=isTime?'timeAutoSelection':'summaryAutoSelection';
  const selector=box.querySelector(`[data-cm-${kind}-candidate]`), signature=JSON.stringify(candidates);
  if(selector.dataset.signature!==signature){
    selector.dataset.signature=signature;selector.replaceChildren();
    const placeholder=node('option',candidates.length?`选择已识别的${name}格式`:`尚未识别到${name}格式`);placeholder.value='';selector.append(placeholder);
    candidates.forEach((row,i)=>{const option=node('option',`${row.label} · ${row.matches} 楼命中`);option.value=String(i);selector.append(option);});
  }
  selector.disabled=!candidates.length;
  const ctx=context(),cfg=ctx.extensionSettings[SLOT] ||= {}, matched=candidates.filter(row=>row.matches>0),info=box.querySelector(isTime?'[data-cm-time-detection]':'[data-cm-detection]');
  if(settings()[auto]) {
    const chosen=matched.length===1?matched[0]:null;
    const before=JSON.stringify([cfg[pattern]||'',cfg[path]||'',cfg[selection]||'',cfg[auto]]);
    cfg[pattern]=chosen?.pattern||'';cfg[path]=chosen?.path||'';cfg[selection]=chosen?.label||'';cfg[auto]=true;
    for(const key of [pattern,path]){const input=box.querySelector(`[data-setting="${key}"]`);if(input.value!==cfg[key])input.value=cfg[key];}
    if(before!==JSON.stringify([cfg[pattern],cfg[path],cfg[selection],cfg[auto]]))ctx.saveSettingsDebounced();
    info.textContent=chosen?`已自动填入 ${chosen.label}；${chosen.matches} 楼命中。预览：${chosen.preview.slice(0,200)}。${chosen.path?'使用 JSON 字段路径，正则无需填写。':'使用正则，JSON 字段路径无需填写。'}`:matched.length>1?`检测到多个有效${name}格式，请从上方选择。`:candidates.length?`已识别${name}格式约定，但历史消息尚无有效命中；可选择或等待新楼生成。`:isTime?'没有可靠的剧情日期字段；仅有时刻、空模板或现实发送时间不能推断剧情日期。':'没有可靠的摘要格式证据，继续总结正文。';
  } else {const chosen=candidates.find(row=>row.pattern===(cfg[pattern]||'')&&row.path===(cfg[path]||''));info.textContent=`保留手动${name}配置。${chosen?.preview?`预览：${chosen.preview.slice(0,200)}。`:''}发现 ${candidates.length} 个候选；启用自动识别或从上方选择可填入。`;}
  const selected=candidates.findIndex(row=>row.pattern===(cfg[pattern]||'')&&row.path===(cfg[path]||''));const value=selected>=0?String(selected):'';if(selector.value!==value)selector.value=value;
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
function notice(text) { if (box) box.querySelector('[data-cm-notice]').textContent = text;if(actionFeedback?.isConnected)actionFeedback.textContent=text; }
function actionNotice(btn) {
  actionFeedback?.remove();actionFeedback=null;
  if(['models','vector-models','vector-test','vector-index','vector-rebuild','detect-summary'].includes(btn.dataset.action))return;
  if(!btn.parentElement.querySelector('[data-action="supplement"]')){actionFeedback=node('p');actionFeedback.dataset.cmActionFeedback='';actionFeedback.setAttribute('role','status');actionFeedback.setAttribute('aria-live','polite');btn.insertAdjacentElement('afterend',actionFeedback);}
  notice(`正在处理「${btn.textContent}」…`);
}
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
  const ctx=context(),read=typeof ctx.isGenerating==='function'?()=>ctx.isGenerating():hostIsGenerating;
  if(read){try{const busy=read();if(typeof busy==='boolean')return generating=busy;}catch{ /* Older hosts fall back to lifecycle events. */ }}
  const processor = ctx.streamingProcessor;
  const streaming=processor&&!finishedProcessors.has(processor)&&!processor.isStopped&&!processor.abortController?.signal.aborted&&processor.isFinished!==true&&(processor.isStreaming===true||processor.isFinished===false);
  return generating || Boolean(streaming);
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
  input.setAttribute('aria-label',label);
  if (type === 'checkbox') input.checked = Boolean(settings()[key]); else input.value = settings()[key] ?? '';
  if (type === 'password') { input.autocomplete = 'off'; input.value = key==='vectorApiKey'?sessionVectorKey||context().extensionSettings[SLOT]?.vectorApiKey||'':sessionKey || context().extensionSettings[SLOT]?.apiKey || ''; }
  if (type === 'number') { input.min = ['contextFloors', 'depth', 'anchorFloor'].includes(key) ? '0' : '1'; input.step = '1'; }
  wrap.append(input); if (hint) wrap.append(node('small', hint)); parent.append(wrap); return input;
}
function details(parent, title, open = false) {
  const d = node('details'); d.open = open; d.append(node('summary', title)); const body = node('div', null, 'cm-fields'); d.append(body); parent.append(d); return body;
}
function connectionControls(parent, kind, modelKey, action) {
  const wrap = node('label', kind === 'summary' ? '选择总结模型' : '选择向量模型', 'cm-field');
  const select = node('select'); select.className = 'text_pole'; select.dataset.cmModel = kind; select.disabled = true; select.setAttribute('aria-label',kind === 'summary' ? '选择总结模型' : '选择向量模型');
  const option = node('option','先获取模型列表，也可在下面手动填写'); option.value = ''; select.append(option); wrap.append(select); parent.append(wrap);
  select.addEventListener('change', () => { if (!select.value) return; const input = box.querySelector(`[data-setting="${modelKey}"]`); input.value = select.value; updateSetting({target:input}); });
  button(kind === 'summary' ? '测试连接并获取模型' : '获取向量模型列表', action, parent);
  const status = node('div'); status.dataset.cmConnection = kind; status.setAttribute('role','status'); status.setAttribute('aria-live','polite'); status.append(node('p','填写接口地址和密钥后获取模型，或手动填写服务提供的模型名称。')); parent.append(status);
}
function connectionStatus(kind,text) { box.querySelector(`[data-cm-connection="${kind}"] p`).textContent = text; }
async function fetchModels(btn,kind = 'summary') {
  const cfg = settings(), key = kind === 'summary' ? 'model' : 'vectorModel';
  const snapshot = kind === 'summary' ? cfg : vectorSettings();
  const signature = config => JSON.stringify([config.apiUrl,config.apiKey]);
  btn.disabled = true; connectionStatus(kind,'正在连接并获取模型…最多等待 20 秒。');
  try {
    const ids = await API.models({...snapshot,timeout:Math.min(Number(snapshot.timeout)||90,20)});
    if (signature(kind === 'summary' ? settings() : vectorSettings()) !== signature(snapshot)) throw new Error('连接配置已变化，请重新获取模型');
    const select = box.querySelector(`[data-cm-model="${kind}"]`); select.replaceChildren();
    const empty = node('option',ids.length ? '请选择模型' : '没有返回模型，请手动填写'); empty.value = ''; select.append(empty);
    for (const id of ids) { const option = node('option',id); option.value = id; select.append(option); }
    select.disabled = !ids.length; select.value = ids.includes(settings()[key]) ? settings()[key] : '';
    connectionStatus(kind,ids.length ? `连接成功，获取 ${ids.length} 个模型。请从上方下拉列表选择。` : '服务未返回模型列表，可手动填写模型名称；连接测试尚未验证生成或向量能力。');
  } catch(error) { connectionStatus(kind,E.failureReason(error,snapshot)); }
  finally { btn.disabled = false; }
}
function shell() {
  if (document.getElementById('conversation-memory')) return;
  const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (!host) throw new Error('酒馆扩展设置面板未就绪');
  management=globalThis.ConversationMemoryConsole.create({host,name:'眠眠机记忆辅助插件',showLauncher:settings().showLauncher!==false,onLauncherChange:value=>{const cfg=context().extensionSettings[SLOT] ||= {};cfg.showLauncher=value;context().saveSettingsDebounced();}});
  box=management.dialog;const {memories,summary,connections,exchange:exchangePage,failures:failurePage}=management.panels,body=management.toolbar;
  memories.append(node('p', '按楼层整理经历，在回复前唤起相关记忆。char 与 user 各一条算一楼。', 'cm-muted'));
  const stats = node('p'); stats.dataset.cmStats = ''; stats.setAttribute('role', 'status'); memories.append(stats);
  const actions = node('div', null, 'cm-actions'); body.append(actions);
  button('补充总结', 'supplement', actions); button('暂停', 'pause', actions); button('整理核心记忆', 'digest', actions);
  const status = node('p', '配置总结 API 后，点击补充总结处理尚未总结的楼层。'); status.dataset.cmNotice = ''; status.setAttribute('role', 'status'); status.setAttribute('aria-live','polite'); body.append(status);
  const toggles = node('div', null, 'cm-fields'); summary.append(toggles);
  field(toggles, 'auto', '自动总结', 'checkbox'); field(toggles, 'inject', '注入记忆', 'checkbox');
  const sourceLabel=node('label','总结来源','cm-field'),sourceSelect=node('select');sourceSelect.className='text_pole';sourceSelect.dataset.setting='summarySource';sourceSelect.setAttribute('aria-label','总结来源');
  for(const [value,label] of [['auto','摘要优先，缺失时用原文'],['raw','仅从聊天原文精炼（旧聊天/混用预设）']]){const option=node('option',label);option.value=value;sourceSelect.append(option);}
  sourceLabel.append(sourceSelect,node('small','按当前聊天保存。原文模式跳过摘要和时间正则/JSON 字段，读取完整正文；剧情日期按正文证据或手动锚点确定。'));summary.append(sourceLabel);
  const connect = details(connections, '独立总结 API', true);
  field(connect, 'apiUrl', 'API 地址', 'url', 'OpenAI 兼容地址，例如 https://服务地址/v1。需要服务允许浏览器跨域。');
  field(connect, 'apiKey', 'API Key', 'password'); field(connect, 'saveKey', '保存密钥到酒馆设置', 'checkbox', '未勾选时密钥仅在本次页面会话中使用。');
  connectionControls(connect,'summary','model','models');
  field(connect, 'model', '模型', 'text', '下拉选择会自动填入；服务不支持模型列表时可以手动填写。'); field(connect, 'maxTokens', '输出 token 上限', 'number'); field(connect, 'timeout', '请求超时秒数', 'number');
  const vectorPanel=details(connections,'向量模型与语义召回');
  field(vectorPanel,'vectorEnabled','启用向量增强召回','checkbox','词法命中不足时，用已建立的向量索引补充语义召回。记忆摘要和查询会发送到你配置的向量接口。');
  field(vectorPanel,'vectorApiUrl','向量 API 地址','url','OpenAI 兼容 embeddings 接口，例如 https://服务地址/v1。');
  field(vectorPanel,'vectorApiKey','向量 API Key','password');field(vectorPanel,'vectorSaveKey','保存向量密钥到酒馆设置','checkbox');
  connectionControls(vectorPanel,'vector','vectorModel','vector-models');field(vectorPanel,'vectorModel','向量模型','text','选择服务提供的 embedding 模型；模型列表可包含非向量模型，需确认接口支持 embeddings。');
  const score=field(vectorPanel,'vectorMinScore','向量相似度阈值','number');score.min='0';score.max='1';score.step='0.05';
  button('测试向量接口','vector-test',vectorPanel);button('建立/更新向量索引','vector-index',vectorPanel);
  button('重建全部向量','vector-rebuild',vectorPanel);
  const vectorInfo=node('p','配置并启用后自动补建现有记忆；总结、导入、编辑和核心整理后自动更新，只处理新增或改动的内容。失败保留本地召回，可点击更新重试。');vectorInfo.dataset.cmVectorStatus='';vectorInfo.setAttribute('role','status');vectorInfo.setAttribute('aria-live','polite');vectorPanel.append(vectorInfo);
  const counting = details(summary, '楼层与注入设置',true);
  field(counting, 'triggerFloors', '自动总结触发楼数', 'number'); field(counting, 'batchFloors', '每批总结楼数', 'number');
  field(counting, 'historyFloors', '回复历史楼数', 'number', '最近历史楼数，当前输入另外保留一次；只影响本次请求，不删除聊天。');
  field(counting, 'contextFloors', '总结前置上下文楼数', 'number'); field(counting, 'budget', '记忆注入字符预算', 'number', '与楼层数分开计算，上限 2800 字符，整条选取。');
  field(counting, 'depth', '记忆注入深度', 'number');
  const positionLabel = node('label','记忆挂载位置','cm-field'), position = node('select'); position.className = 'text_pole'; position.dataset.setting = 'position';
  for (const [value,label] of [[1,'聊天内（按深度）'],[0,'主提示后'],[2,'主提示前']]) { const option = node('option',label); option.value = value; position.append(option); }
  position.value = settings().position; positionLabel.append(position); counting.append(positionLabel);
  const extracting = details(summary, '摘要与剧情时间提取');
  field(extracting,'autoSummary','自动识别当前摘要格式','checkbox','只读检查当前启用正则、预设和聊天证据；手动编辑提取规则会关闭自动识别。');button('识别当前预设与正则','detect-summary',extracting);
  const candidateLabel=node('label','识别到的摘要格式','cm-field'),candidate=node('select');candidate.className='text_pole';candidate.dataset.cmSummaryCandidate='';candidate.setAttribute('aria-label','识别到的摘要格式');candidateLabel.append(candidate);extracting.append(candidateLabel);
  candidate.addEventListener('change',()=>{const row=detectionCandidates[Number(candidate.value)];if(candidate.value===''||!row)return;const cfg=context().extensionSettings[SLOT] ||= {};cfg.summaryPattern=row.pattern;cfg.summaryPath=row.path;cfg.autoSummary=false;cfg.summaryAutoSelection='';box.querySelector('[data-setting="autoSummary"]').checked=false;for(const key of ['summaryPattern','summaryPath'])box.querySelector(`[data-setting="${key}"]`).value=cfg[key];context().saveSettingsDebounced();box.querySelector('[data-cm-detection]').textContent=`已填入 ${row.label}。预览：${row.preview.slice(0,200)||'历史中尚无命中'}；之后保留此选择，可重新启用自动识别。`;});
  const detectionInfo=node('p');detectionInfo.dataset.cmDetection='';detectionInfo.setAttribute('role','status');extracting.append(detectionInfo);
  field(extracting, 'summaryPattern', '摘要正则', 'text', '使用第一个捕获组，例如 <memory_summary>([\\s\\S]*?)</memory_summary>。');
  field(extracting, 'summaryPath', '摘要 JSON 字段路径', 'text', '例如 memory.summary；不填写则使用正则或正文。');
  field(extracting,'autoTime','自动识别剧情时间格式','checkbox','读取当前已启用日期规则和聊天证据；手动修改时间规则后保留你的配置。');
  const timeLabel=node('label','识别到的剧情时间格式','cm-field'),timeSelect=node('select');timeSelect.className='text_pole';timeSelect.dataset.cmTimeCandidate='';timeSelect.setAttribute('aria-label','识别到的剧情时间格式');timeLabel.append(timeSelect);extracting.append(timeLabel);
  timeSelect.addEventListener('change',()=>{const row=timeCandidates[Number(timeSelect.value)];if(timeSelect.value===''||!row)return;const cfg=context().extensionSettings[SLOT] ||= {};cfg.timePattern=row.pattern;cfg.timePath=row.path;cfg.autoTime=false;cfg.timeAutoSelection='';box.querySelector('[data-setting="autoTime"]').checked=false;for(const key of ['timePattern','timePath'])box.querySelector(`[data-setting="${key}"]`).value=cfg[key];context().saveSettingsDebounced();box.querySelector('[data-cm-time-detection]').textContent=`已填入 ${row.label}。预览：${row.preview.slice(0,200)||'历史中尚无命中'}；保留此选择。`;});
  const timeInfo=node('p');timeInfo.dataset.cmTimeDetection='';timeInfo.setAttribute('role','status');timeInfo.setAttribute('aria-live','polite');extracting.append(timeInfo);
  field(extracting, 'timePattern', '时间正则', 'text', '例如 <time>(.*?)</time>；可从状态栏取得日期。');
  field(extracting, 'timePath', '时间 JSON 字段路径');
  field(extracting, 'realTime', '使用现实发送时间作为发生时间', 'checkbox', '剧情聊天默认关闭，没有明确剧情日期就保留未知。');
  field(extracting, 'anchorFloor', '日期锚点楼层', 'number'); field(extracting, 'anchorDate', '该楼剧情日期', 'text', 'YYYY-MM-DD；只从指定楼层向后解析明确时间承接。');
  const timezone = field(extracting, 'timezoneOffset', '剧情时区 UTC 偏移小时', 'number'); timezone.min = '-12'; timezone.max = '14';
  field(extracting, 'maxPromptChars', '总结输入字符容量', 'number'); button('测试摘要与时间提取', 'extract', extracting);
  const previewFloor = field(extracting, 'previewFloor', '测试提取楼层', 'number'); previewFloor.value = settings().previewFloor || 1;
  const exchange = details(exchangePage, '导入导出与来源重算',true);
  button('导出记忆 JSON', 'export', exchange); button('导入记忆 JSON', 'import', exchange);
  button('确认从失效楼重算', 'rewind', exchange); button('游标归零检查全史', 'reset', exchange);
  field(exchange, 'rangeStart', '重算起始楼层', 'number').value = settings().rangeStart || 1;
  field(exchange, 'rangeEnd', '重算结束楼层', 'number').value = settings().rangeEnd || 1;
  button('重算指定楼层范围', 'range', exchange);
  const file = node('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true; file.dataset.cmFile = ''; exchange.append(file);
  const preview = node('div'); preview.dataset.cmImport = ''; exchange.append(preview);
  const recall = details(memories, '测试召回与本次注入');
  const queryLabel = node('label', '召回测试问题'); const query = node('input'); query.dataset.cmQuery = ''; query.className = 'text_pole'; queryLabel.append(query); recall.append(queryLabel);
  button('测试召回', 'recall', recall); const rec = node('pre'); rec.dataset.cmRecall = ''; recall.append(rec);
  const records = node('div'); records.dataset.cmRecords = ''; memories.append(records);
  const failures = details(failurePage, '失败记录与手动重试',true); failures.dataset.cmFailures = '';
  const credits = details(memories, '开源项目致谢');
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
  box.addEventListener('input', updateSetting); box.addEventListener('change', updateSetting);
  box.addEventListener('click', event => {
    const action = event.target.closest('button[data-action]'); if (action) {actionNotice(action);handle(action).catch(error => notice(E.failureReason(error,settings())));}
  });
  file.addEventListener('change', () => previewImport(file.files?.[0]).catch(error => notice(error.message)));
}
function updateSetting(event) {
  const key = event.target.dataset.setting; if (!key) return;
  if(key==='summarySource'){
    if(event.type!=='change')return;
    const input=event.target;
    try{idle();if(!['auto','raw'].includes(input.value))throw new Error('请选择有效的总结来源');const next=structuredClone(state),key=activeKey;next.summarySource=input.value;input.disabled=true;clearTimeout(autoTimer);
      save(next,key).then(()=>{if(activeKey===key&&identity()===key){notice(next.summarySource==='raw'?'当前聊天已切换为原文精炼。失败记录可手动重试；已有成功记忆可在「导入导出」指定范围重算。':'当前聊天已切换为摘要优先，未命中摘要的楼层仍使用原文。');scheduleAuto();}}).catch(error=>{if(activeKey===key){renderStatus();notice(error.message);}});
    }catch(error){input.value=settings().summarySource;notice(error.message);}return;
  }
  const input = event.target; const ctx = context(); const cfg = ctx.extensionSettings[SLOT] ||= {};
  const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim();
  if (input.type === 'number' && (!Number.isFinite(value) || value < Number(input.min || 0))) return;
  if (key === 'saveKey' && !value) sessionKey = sessionKey || cfg.apiKey || '';
  if (key === 'vectorSaveKey' && !value) sessionVectorKey = sessionVectorKey || cfg.vectorApiKey || '';
  if (key === 'apiKey') sessionKey = input.value; else if(key==='vectorApiKey')sessionVectorKey=input.value;else cfg[key] = value;
  if (key === 'realTime') cfg.dateMode = value ? 'real' : 'story';
  if (cfg.saveKey) cfg.apiKey = key === 'apiKey' ? input.value : sessionKey || cfg.apiKey || ''; else delete cfg.apiKey;
  if(cfg.vectorSaveKey)cfg.vectorApiKey=key==='vectorApiKey'?input.value:sessionVectorKey||cfg.vectorApiKey||'';else delete cfg.vectorApiKey;
  if(['summaryPattern','summaryPath'].includes(key)){cfg.autoSummary=false;cfg.summaryAutoSelection='';box.querySelector('[data-setting="autoSummary"]').checked=false;}
  if(['timePattern','timePath'].includes(key)){cfg.autoTime=false;cfg.timeAutoSelection='';box.querySelector('[data-setting="autoTime"]').checked=false;}
  ctx.saveSettingsDebounced();
  if (key === 'inject' && !value) clearInjection();
  if (key === 'auto') scheduleAuto();
  if(key==='autoSummary'||key==='autoTime')refreshDetection().catch(error=>notice(error.message));
  if(['vectorEnabled','vectorApiUrl','vectorApiKey','vectorModel'].includes(key))queueVectorIndex();
}
function renderStatus() {
  if (!box) return;
  const source=box.querySelector('[data-setting="summarySource"]');source.value=settings().summarySource;source.disabled=!state||job||Boolean(controller?.busy());
  const total = E.floors(chat()).length; const invalid = state ? E.invalidFrom(state, chat()) : -1;
  const pending = (state?.failures || []).filter(row => row.status === 'pending').length;
  box.querySelector('[data-cm-stats]').textContent = state ? `${context().name2} · 连续补齐 ${state.cursor} / ${total} 楼 · 已检查至 ${E.through(state)} 楼 · 已保存 ${state.periods.length} 条事件、${state.cores.length} 条核心记忆${E.through(state)<total?` · 下一批从 ${E.through(state)+1} 楼`:''}${pending ? ` · 待重试 ${pending} 批。失败楼层会阻挡连续进度，已保存的记忆仍可使用；请到「失败记录」手动重试。` : ''}${invalid >= 0 ? ` · 第 ${invalid + 1} 楼起来源有修改` : ''}` : '请选择单角色聊天';
  management?.status(state?`${context().name2} · 已存 ${state.periods.length} 条事件、${state.cores.length} 条核心 · 已检查 ${E.through(state)} / ${total} 楼 · 连续补齐 ${state.cursor} / ${total} 楼${pending?` · 待补 ${pending} 批`:''}`:'请选择单角色聊天',pending);
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
  if (action === 'pause') { jobCancelled = true; controller?.pause();vectorPaused=true;vectorEpoch++;vectorQueued=false;clearTimeout(vectorTimer);notice('已请求暂停总结与索引，等待当前请求结束；已保存的批次保留。'); return; }
  if (action === 'models') {
    await fetchModels(btn); return;
  }
  if(action==='vector-models'){await fetchModels(btn,'vector');return;}
  if(action==='detect-summary'){
    btn.disabled=true;const label=btn.textContent;btn.textContent='正在识别…';for(const selector of ['[data-cm-detection]','[data-cm-time-detection]'])box.querySelector(selector).textContent='正在读取当前预设、已启用正则和聊天内容…';
    try { const cfg=context().extensionSettings[SLOT] ||= {};cfg.autoSummary=cfg.autoTime=true;for(const key of ['autoSummary','autoTime'])box.querySelector(`[data-setting="${key}"]`).checked=true;await refreshDetection();notice('摘要与剧情时间识别完成，结果和提取预览见「摘要与剧情时间提取」。'); }
    catch(error){for(const selector of ['[data-cm-detection]','[data-cm-time-detection]'])box.querySelector(selector).textContent=E.failureReason(error,settings());throw error;}
    finally{btn.disabled=false;btn.textContent=label;}return;
  }
  if(action==='vector-test'||action==='vector-index'||action==='vector-rebuild') {
    try { if(action!=='vector-test')idle();else if(job)throw Error('请等待当前记忆操作结束');if(vectorTask)throw Error('向量索引正在更新，完成后会自动补建最新内容'); } catch(error){vectorStatus(error.message);return;}
    const connection=vectorSettings();btn.disabled=true;job=true;jobCancelled=false;const key=activeKey,stamp=state?memoryStamp(state):'';
    try {
      API.validate(connection);vectorStatus(action==='vector-test'?'正在测试向量接口…':'正在建立/更新向量索引…');
      if(action==='vector-test'){const [vector]=await API.embed(connection,['记忆检索连接测试']);if(JSON.stringify([vectorSettings().apiUrl,vectorSettings().model,vectorSettings().apiKey])!==JSON.stringify([connection.apiUrl,connection.model,connection.apiKey]))throw Error('向量连接配置已变化，请重新测试');vectorStatus(`向量接口正常，返回 ${vector.length} 维向量。可以建立索引。`);}
      else {
        vectorPaused=false;await runVectorIndex(action==='vector-rebuild');
      }
    } catch(error){vectorStatus(E.failureReason(error,connection));}finally{btn.disabled=false;job=false;renderStatus();if(vectorQueued)queueVectorIndex(false);}return;
  }
  if (action === 'supplement') {
    idle();
    if (generationBusy()) throw new Error('角色仍在回复，请等本楼完成后再总结');
    if(E.invalidFrom(state,chat())>=0)throw new Error('已总结来源有修改，请先确认失效楼层并重算');
    const remaining=E.floors(chat()).length-E.through(state);
    if(remaining<=0){const pending=(state.failures||[]).filter(row=>row.status==='pending').length;notice(`没有新的待总结楼层，已检查至第 ${E.through(state)} 楼。${pending?`有 ${pending} 条失败记录，请展开「失败记录与手动重试」补齐。`:'新增聊天后可继续补充总结。'}`);return;}
    API.validate(settings());const key=activeKey,label=btn.textContent;btn.disabled=true;btn.textContent='正在补充总结…';job=true;jobCancelled=false;vectorPaused=false;
    notice(`准备补充总结第 ${E.through(state)+1} 楼起，共 ${remaining} 楼；正在检查摘要规则…`);
    try { await refreshDetection();if(jobCancelled||identity()!==key||!enabled)return;await controller.run(true);if(identity()===key) {if(jobCancelled)notice('补充总结已暂停，已保存的批次保留。');else completionNotice('补充总结');} }
    finally { btn.disabled=false;btn.textContent=label;job=false;renderStatus();if(vectorQueued)queueVectorIndex(false); }
    return;
  }
  if (action === 'recall') {
    available(); const result = await recallMemory(box.querySelector('[data-cm-query]').value);
    lastRecall = result.text || '没有命中相关记忆。'; renderStatus(); notice(`召回使用 ${result.used || 0} 字符，来源条目 ${result.items?.length || 0}。`); return;
  }
  if (action === 'extract') {
    available(); await refreshDetection();const floor = Math.max(1, Math.floor(settings().previewFloor || 1));
    const source = { ...state, cursor: floor - 1, anchorAt: state.activities.filter(a => a.sourceOrder < floor && !a.timeUnknown).at(-1)?.occurredAt || 0 };
    const result = E.prepare(source, chat(), { ...settings(), batchFloors: 1 });
    const row = result.prepared.activities[0]; notice(row ? `第 ${floor} 楼（消息索引 ${E.floors(chat())[floor-1].index}），${settings().summarySource==='raw'?'直接使用聊天原文':row.source === 'preset_summary' ? '命中已有摘要' : '未命中摘要，回退正文'}：${row.summary}\n时间：${row.timeLabel}；${row.timeUnknown ? '具体剧情日期未知' : new Date(row.occurredAt).toISOString()}` : '该楼不存在。'); return;
  }
  if (action === 'export') {
    available(); const ctx = context();
    download(R.MemoryTransfer.serialize(state, { id: activeKey, name: ctx.name2, userName: ctx.name1,
      source: { application: 'sillytavern', characterId: ctx.characters[ctx.characterId].avatar, chatId: ctx.getCurrentChatId?.() || ctx.chatId } },
      { name: 'sillytavern-memory', version: '0.3.2' }), 'conversation-memory.json');notice('记忆 JSON 下载已发起。'); return;
  }
  if (action === 'import') { idle(); const input = box.querySelector('[data-cm-file]'); input.value = ''; input.click();notice('请选择记忆 JSON；读取后会显示导入预览。'); return; }
  if (action === 'cancel-import') { pendingImport = null; box.querySelector('[data-cm-import]').replaceChildren();notice('已取消导入。'); return; }
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
    if (failure.operation === 'summary') { try{await controller.retry(failure.id);completionNotice('手动重试');}finally{renderStatus();if(vectorQueued)queueVectorIndex(false);} }
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
    } finally { job = false; if (activeKey === key && controller === rangeController) controller = previous;renderStatus();if(vectorQueued)queueVectorIndex(false); }
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
    } finally { job = false;renderStatus();if(vectorQueued)queueVectorIndex(false); } return;
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
  const token = ++generation; generating=false;controller?.pause(); jobCancelled = true;vectorEpoch++;vectorQueued=false;clearTimeout(vectorTimer); clearInjection(); state = null; pendingImport = null; editId = ''; page = failurePage = 0;
  activeKey = identity(); renderStatus(); renderMemories(); renderFailures(); if (!activeKey) return;
  const key = activeKey; const loaded = await read(key); if (token !== generation || identity() !== key) return;
  state = loaded; state.failures ||= []; state.processedThrough = E.through(state);
  controller = E.create({ getState: () => state, getChat: chat, getSettings: settings, isCurrent: () => enabled && activeKey === key && identity() === key,
    save: next => save(next, key), request: request => API.generate(settings(), request.prompt),
    progress: progress => { renderStatus(); progressNotice(progress); } });
  renderStatus(); renderMemories(); renderFailures();await refreshDetection();scheduleAuto();queueVectorIndex();
}
function scheduleAuto() {
  clearTimeout(autoTimer);
  if (!enabled || !settings().auto || !state) return;
  autoTimer = setTimeout(async () => {
    try { if (enabled&&state&&controller&&activeKey===identity()&&!job&&!generationBusy()) { API.validate(settings());const key=activeKey,running=controller,before=E.through(state);await running.run(false);if(activeKey===key&&identity()===key&&controller===running){renderStatus();if(E.through(state)>before)completionNotice('自动总结');} } }
    catch (error) { notice(error.message); }
    finally{if(vectorQueued)queueVectorIndex(false);}
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
      const result = await recallMemory(query);
      if (identity() !== key || !enabled || !settings().inject) return;
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
  // STARTED also fires for prompt dry runs and slash commands which may never emit ENDED.
  // The host's live flag is authoritative, including when re-enabling during a reply.
  try{const host=await import('/script.js');if(typeof host.isGenerating==='function')hostIsGenerating=host.isGenerating;else if(typeof host.is_send_press==='boolean')hostIsGenerating=()=>host.is_send_press;}catch{ /* Support hosts exposing only getContext and generation events. */ }
  shell(); await loadChat(); const ctx = context(); const types = ctx.eventTypes || ctx.event_types;
  ctx.eventSource.on(types.CHAT_CHANGED, () => loadChat().catch(error => notice(error.message)));
  if (types.GENERATION_STARTED) ctx.eventSource.on(types.GENERATION_STARTED, (type,options,dryRun) => { if(dryRun||type==='quiet')return;generating = true; clearTimeout(autoTimer); });
  const generationFinished=async()=>{generating=false;const processor=context().streamingProcessor;if(processor&&typeof processor==='object')finishedProcessors.add(processor);renderStatus();try{await refreshDetection();}catch(error){notice(error.message);}finally{scheduleAuto();queueVectorIndex(false);}};
  for(const name of ['GENERATION_ENDED','GENERATION_STOPPED'])if(types[name])ctx.eventSource.on(types[name],generationFinished);
  for(const name of ['OPENAI_PRESET_CHANGED_AFTER','SETTINGS_UPDATED','PRESET_CHANGED'])if(types[name])ctx.eventSource.on(types[name],()=>refreshDetection().catch(error=>notice(error.message)));
  for (const name of ['MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED']) if (types[name]) ctx.eventSource.on(types[name], () => { renderStatus(); scheduleAuto(); });
}
export function onDisable() { enabled = false;generating=false;management?.setEnabled(false); generation++; jobCancelled = true;vectorEpoch++;vectorQueued=false;clearTimeout(vectorTimer); clearTimeout(autoTimer); controller?.pause(); clearInjection(); }
export function onEnable() { enabled = true;management?.setEnabled(true); return loadChat().catch(error => notice(error.message)); }
export function onDelete() { onDisable(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(error => console.error('[ConversationMemory]', error.message)), { once: true });
else init().catch(error => console.error('[ConversationMemory]', error.message));
