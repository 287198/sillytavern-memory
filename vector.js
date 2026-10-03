(function(root){
  'use strict';
  function hash(text) { let a=2166136261,b=5381;for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b,33)^text.charCodeAt(i);}return (a>>>0).toString(16)+'_'+(b>>>0).toString(16); }
  function text(candidate) {
    const row=candidate.raw||candidate;
    if (row.kind==='digested_block' && root.ConversationMemoryRules) return root.ConversationMemoryRules.MemoryLibraryModel.corePromptText(row);
    return [row.eventSummary,row.summary,...(row.facts||[]).map(f=>f.text)].filter(Boolean).join('\n').trim();
  }
  function cacheKey(charId,candidate,settings) { return hash(JSON.stringify([charId,settings.apiUrl,settings.model,candidate.id,text(candidate)])); }
  function cosine(a,b) { if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length||!a.length)return 0;let ab=0,aa=0,bb=0;for(let i=0;i<a.length;i++){if(!Number.isFinite(a[i])||!Number.isFinite(b[i]))return 0;ab+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}return aa&&bb?ab/Math.sqrt(aa*bb):0; }
  function defaultCache() {
    let promise;
    function db() { return promise ||= new Promise((resolve,reject)=>{const req=root.indexedDB.open('ConversationMemoryVectors',1);req.onupgradeneeded=()=>req.result.createObjectStore('cache');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(Error('向量缓存不可用'));}); }
    return {
      get:async key=>{const database=await db();return new Promise((resolve,reject)=>{const req=database.transaction('cache').objectStore('cache').get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(Error('向量缓存读取失败'));});},
      put:async(key,value)=>{const database=await db();return new Promise((resolve,reject)=>{const tx=database.transaction('cache','readwrite');tx.objectStore('cache').put(value,key);tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(Error('向量缓存保存失败'));});}
    };
  }
  function create({api,cache=defaultCache()}) {
    async function index({charId,candidates,settings,isCurrent=()=>true,progress=()=>{},force=false}) {
      let cached=0,created=0;const pending=[];
      for(const candidate of candidates) { if(!isCurrent())throw Error('索引已暂停或来源已变化');const body=text(candidate);if(!body)continue;const key=cacheKey(charId,candidate,settings);if(!force&&await cache.get(key))cached++;else pending.push({key,body:body.slice(0,6000)}); }
      for(let start=0;start<pending.length;start+=16) {
        if(!isCurrent())throw Error('索引已暂停或来源已变化');const batch=pending.slice(start,start+16);
        progress({cached,created,total:cached+pending.length});
        const vectors=await api.embed(settings,batch.map(row=>row.body));
        if(!isCurrent())throw Error('索引已暂停或来源已变化');
        for(let i=0;i<batch.length;i++){await cache.put(batch[i].key,{vector:vectors[i],at:Date.now()});created++;}
      }
      return {cached,created,total:cached+created};
    }
    async function search({charId,query,candidates,settings}) {
      try {
        const rows=[];
        for(const candidate of candidates) { const cached=await cache.get(cacheKey(charId,candidate,settings));if(cached?.vector)rows.push({id:candidate.id,vector:cached.vector}); }
        if(!rows.length)return {route:'local',reason:'尚无匹配当前模型和来源的向量索引，请先建立/更新索引',scores:{}};
        const [vector]=await api.embed({...settings,timeout:Math.min(Number(settings.timeout)||90,12)},[query]);
        const minimum=Number.isFinite(Number(settings.vectorMinScore))?Number(settings.vectorMinScore):0.45;
        const scores={};for(const row of rows){const score=cosine(vector,row.vector);if(score>=Math.max(0,Math.min(1,minimum)))scores[row.id]=score;}
        if(rows.some(row=>row.vector.length!==vector.length))throw Error('向量维度变化，请更换模型或重新建立索引');
        return {route:'vector',reason:rows.length<candidates.length?'部分记忆尚未建立向量，请更新索引':'',scores};
      } catch(error) { let reason=String(error.message||error);if(settings.apiKey)reason=reason.split(settings.apiKey).join('[已隐藏]');return {route:'local',reason:reason.replace(/Bearer\s+[^\s,;]+/gi,'Bearer [已隐藏]').slice(0,600),scores:{}}; }
    }
    return {index,search};
  }
  root.ConversationMemoryVector={create,text,cosine,cacheKey};
})(globalThis);
