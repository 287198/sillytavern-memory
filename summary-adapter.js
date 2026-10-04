(function(root){
  'use strict';
  const summaryName = /summary|摘要|总结|小结|梗概|回顾|剧情概要/i;
  const excluded = /thinking|reasoning|analysis|思维|思考|推理|状态栏|status/i;
  const timeName = /(?:^|[_\s-])(?:time|date|datetime)(?:$|[_\s-])|日期|时间|年月日|story_date|story_time|occurredAt/i;
  const thinking = /thinking|reasoning|analysis|思维|思考|推理/i;
  function valid(value) { return Boolean(value) && !/^(?:(?:剧情|记忆|内容|历史)?(?:摘要|总结|小结|概要|回顾)|思考过程|思维链|状态栏|summary|thinking|reasoning)[:：…\.\s]*$/i.test(value.trim()); }
  function validTime(value) {
    if(!value)return false;if(/^(?:次日|第二天|翌日|[一二三四五六七八九十\d]+天后)$/.test(value.trim()))return true;
    const matches=[...value.matchAll(/(\d{4})[-年\/.](\d{1,2})[-月\/.](\d{1,2})(?:日)?/g)];if(matches.length!==1)return false;
    const clock=value.match(/[ T]+(\d{1,2})[:：](\d{2})/);if(clock&&(+clock[1]>23||+clock[2]>59))return false;
    const [,year,month,day]=matches[0],d=new Date(Date.UTC(+year,+month-1,+day));return d.getUTCFullYear()===+year&&d.getUTCMonth()===+month-1&&d.getUTCDate()===+day;
  }
  function jsonObjects(body) {
    const values=[];let start=-1,depth=0,quoted=false,escaped=false;
    body=body.slice(0,200000);
    for(let i=0;i<body.length&&values.length<8;i++) {
      const char=body[i];if(start<0){if(char==='{'){start=i;depth=1;}continue;}
      if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
      if(char==='"')quoted=true;else if(char==='{')depth++;else if(char==='}'&&!--depth){try{values.push(JSON.parse(body.slice(start,i+1)));}catch{}start=-1;}
    }
    return values;
  }
  function extract(body, pattern, path) {
    if (path) { for(const obj of jsonObjects(body)){const value=path.split('.').reduce((v,k)=>v && Object.prototype.hasOwnProperty.call(v,k)?v[k]:null,obj);if(typeof value==='string'&&value.trim())return value.trim();}return ''; }
    if(!pattern)return '';
    const parsed=pattern.match(/^\/(.*)\/([dgimsuvy]*)$/);
    try { const match=new RegExp(parsed?parsed[1]:pattern,parsed?parsed[2]:'i').exec(body); return match?String(match[1]??match[0]).trim():''; } catch { return ''; }
  }
  function detect({scripts=[],messages=[],preset={},kind='summary'}) {
    const name=kind==='time'?timeName:summaryName,omit=kind==='time'?thinking:excluded,usable=kind==='time'?validTime:valid;
    const candidates=[], bodies=messages.filter(m=>!m.is_user&&!m.is_system&&typeof m.mes==='string').slice(-40).map(m=>m.mes);
    function add(pattern,path,label) {
      if (candidates.some(c=>c.pattern===pattern&&c.path===path)) return;
      const hits=bodies.map(body=>extract(body,pattern,path)).filter(usable);
      candidates.push({pattern,path,label,matches:hits.length,preview:hits.at(-1)||''});
    }
    for (const rule of scripts) {
      if (!rule || rule.disabled || !rule.placement?.includes(2) || !name.test((rule.scriptName||'')+' '+(rule.findRegex||'')) || omit.test((rule.scriptName||'')+' '+(rule.findRegex||''))) continue;
      if (typeof rule.findRegex==='string' && rule.findRegex.length<=1000 && !rule.findRegex.includes('{{')) {
        const hits=bodies.map(body=>extract(body,rule.findRegex,'')).filter(usable);
        if (hits.length) add(rule.findRegex,'','已启用正则：'+(rule.scriptName||'摘要'));
      }
    }
    function visitJSON(obj,path,depth) {
      if (!obj || typeof obj!=='object' || Array.isArray(obj) || depth>4) return;
      for (const [key,value] of Object.entries(obj)) {
        if (omit.test(key) || key.includes('.') || ['__proto__','constructor','prototype'].includes(key)) continue;
        const parts=path.concat(key);
        if (typeof value==='string' && usable(value) && name.test(key)) add('',parts.join('.'),'聊天 JSON 字段：'+parts.join('.'));
        else visitJSON(value,parts,depth+1);
      }
    }
    for (const body of bodies) for(const obj of jsonObjects(body))visitJSON(obj,[],0);
    const hints=[];
    function visitPreset(obj,depth) {
      if (!obj || typeof obj!=='object'||depth>5) return;
      if (obj.enabled===false) return;
      for (const [key,value] of Object.entries(obj)) {
        if (typeof value==='string' && ['content','system_prompt','story_string','prompt','text'].includes(key)) hints.push(value);
        else if (value && typeof value==='object') visitPreset(value,depth+1);
      }
    }
    visitPreset(preset,0);
    const tags=new Set();
    for (const hint of hints) for (const match of hint.matchAll(/<([a-zA-Z_\u4e00-\u9fff][\w\u4e00-\u9fff-]{0,48})>/g)) if (name.test(match[1])&&!omit.test(match[1])) tags.add(match[1]);
    // Actual stored tags can still be recognized when old versions expose no preset scripts.
    for (const body of bodies) for (const match of body.matchAll(/<([a-zA-Z_\u4e00-\u9fff][\w\u4e00-\u9fff-]{0,48})>/g)) if (name.test(match[1])&&!omit.test(match[1])) tags.add(match[1]);
    for (const tag of tags) add('<'+tag+'>([\\s\\S]*?)</'+tag+'>','',(kind==='time'?'剧情时间标签：':'摘要标签：')+tag);
    if(kind==='time') {
      const pattern='/(?:^|[\\n>|])\\s*(?:剧情日期|剧情时间|日期|时间|date|time)\\s*[:：=]\\s*(\\d{4}[-年\\/.]\\d{1,2}[-月\\/.]\\d{1,2}日?(?:[ T]+\\d{1,2}[:：]\\d{2})?)/im';
      if(bodies.some(body=>validTime(extract(body,pattern,''))))add(pattern,'','状态栏日期/时间文本');
    }
    if(kind==='summary'&&bodies.some(body=>/<details\b/i.test(body)))add('/<details\\b[^>]*>\\s*<summary\\b[^>]*>\\s*(?:剧情|记忆|内容|历史)?(?:摘要|总结|小结|梗概|回顾)[^<]*<\\/summary>([\\s\\S]*?)<\\/details>/i','','摘要折叠栏正文');
    // Merge equivalent patterns by their actual extraction evidence, preserving the real enabled rule.
    const unique=[];
    for (const row of candidates) {
      const values=bodies.map(body=>extract(body,row.pattern,row.path));
      if (row.matches && unique.some(c=>JSON.stringify(bodies.map(body=>extract(body,c.pattern,c.path)))===JSON.stringify(values))) continue;
      unique.push(row);
    }
    return unique.sort((a,b)=>b.matches-a.matches);
  }
  root.ConversationMemorySummary={detect,detectTime:input=>detect({...input,kind:'time'}),extract};
})(globalThis);
