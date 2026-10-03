(function(root){
  'use strict';
  const summaryName = /summary|摘要|总结|小结|梗概|回顾|剧情概要/i;
  const excluded = /thinking|reasoning|analysis|思维|思考|推理|状态栏|status/i;
  function valid(value) { return Boolean(value) && !/^(?:(?:剧情|记忆|内容|历史)?(?:摘要|总结|小结|概要|回顾)|思考过程|思维链|状态栏|summary|thinking|reasoning)[:：…\.\s]*$/i.test(value.trim()); }
  function extract(body, pattern, path) {
    if (path) { try { const obj=JSON.parse(body.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')); const value=path.split('.').reduce((v,k)=>v && Object.prototype.hasOwnProperty.call(v,k)?v[k]:null,obj); return typeof value==='string'?value.trim():''; } catch { return ''; } }
    const parsed=pattern.match(/^\/(.*)\/([dgimsuvy]*)$/);
    try { const match=new RegExp(parsed?parsed[1]:pattern,parsed?parsed[2]:'i').exec(body); return match?String(match[1]??match[0]).trim():''; } catch { return ''; }
  }
  function detect({scripts=[],messages=[],preset={}}) {
    const candidates=[], bodies=messages.filter(m=>!m.is_user&&!m.is_system&&typeof m.mes==='string').slice(-40).map(m=>m.mes);
    function add(pattern,path,label) {
      if (candidates.some(c=>c.pattern===pattern&&c.path===path)) return;
      const hits=bodies.map(body=>extract(body,pattern,path)).filter(valid);
      candidates.push({pattern,path,label,matches:hits.length,preview:hits.at(-1)||''});
    }
    for (const rule of scripts) {
      if (!rule || rule.disabled || !rule.placement?.includes(2) || !summaryName.test((rule.scriptName||'')+' '+(rule.findRegex||'')) || excluded.test((rule.scriptName||'')+' '+(rule.findRegex||''))) continue;
      if (typeof rule.findRegex==='string' && rule.findRegex.length<=1000 && !rule.findRegex.includes('{{')) {
        const hits=bodies.map(body=>extract(body,rule.findRegex,'')).filter(valid);
        if (hits.length) add(rule.findRegex,'','已启用正则：'+(rule.scriptName||'摘要'));
      }
    }
    function visitJSON(obj,path,depth) {
      if (!obj || typeof obj!=='object' || Array.isArray(obj) || depth>4) return;
      for (const [key,value] of Object.entries(obj)) {
        if (excluded.test(key) || key.includes('.') || ['__proto__','constructor','prototype'].includes(key)) continue;
        const parts=path.concat(key);
        if (typeof value==='string' && value.trim() && summaryName.test(key)) add('',parts.join('.'),'聊天 JSON 字段：'+parts.join('.'));
        else visitJSON(value,parts,depth+1);
      }
    }
    for (const body of bodies) { try { visitJSON(JSON.parse(body.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'')),[],0); } catch {} }
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
    for (const hint of hints) for (const match of hint.matchAll(/<([a-zA-Z_\u4e00-\u9fff][\w\u4e00-\u9fff-]{0,48})>/g)) if (summaryName.test(match[1])&&!excluded.test(match[1])) tags.add(match[1]);
    // Actual stored tags can still be recognized when old versions expose no preset scripts.
    for (const body of bodies) for (const match of body.matchAll(/<([a-zA-Z_\u4e00-\u9fff][\w\u4e00-\u9fff-]{0,48})>/g)) if (summaryName.test(match[1])&&!excluded.test(match[1])) tags.add(match[1]);
    for (const tag of tags) add('<'+tag+'>([\\s\\S]*?)</'+tag+'>','','摘要标签：'+tag);
    // Merge equivalent patterns by their actual extraction evidence, preserving the real enabled rule.
    const unique=[];
    for (const row of candidates) {
      const values=bodies.map(body=>extract(body,row.pattern,row.path));
      if (row.matches && unique.some(c=>JSON.stringify(bodies.map(body=>extract(body,c.pattern,c.path)))===JSON.stringify(values))) continue;
      unique.push(row);
    }
    return unique.sort((a,b)=>b.matches-a.matches);
  }
  root.ConversationMemorySummary={detect,extract};
})(globalThis);
