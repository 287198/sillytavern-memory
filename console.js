(function(root){
  'use strict';
  function element(tag,text,cls){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;}
  function control(text,label){const el=element('button',text,'menu_button cm-button');el.type='button';if(label)el.setAttribute('aria-label',label);return el;}
  function create({host,name,showLauncher=true,onLauncherChange=()=>{}}){
    let disabled=false,returnFocus=null,current='memories';const scrollPositions={};
    const entry=element('section',null,'cm-entry');entry.id='conversation-memory-entry';
    entry.append(element('h3',name));const entryStats=element('p','正在加载当前聊天…','cm-muted');entryStats.dataset.cmEntryStats='';entryStats.setAttribute('role','status');entry.append(entryStats);
    const openButton=control('打开记忆管理台'),visibility=element('label','显示悬浮入口','cm-entry-visibility'),checkbox=element('input');checkbox.type='checkbox';checkbox.checked=showLauncher;visibility.prepend(checkbox);entry.append(openButton,visibility);host.append(entry);
    const launcher=control('记忆','打开眠眠机记忆管理台');launcher.classList.add('cm-launcher');launcher.title=name;document.body.append(launcher);
    const dialog=element('dialog',null,'cm-panel cm-console');dialog.id='conversation-memory';dialog.setAttribute('aria-labelledby','cm-console-title');
    const header=element('header',null,'cm-console-header'),heading=element('h2',name);heading.id='cm-console-title';const closeButton=control('关闭','关闭记忆管理台');header.append(heading,closeButton);dialog.append(header);
    const toolbar=element('div',null,'cm-console-toolbar'),headerStats=element('p','正在加载当前聊天…');headerStats.dataset.cmHeaderStats='';toolbar.append(headerStats);dialog.append(toolbar);
    const navigation=element('div',null,'cm-console-tabs');navigation.setAttribute('role','tablist');navigation.setAttribute('aria-label','记忆管理台页面');dialog.append(navigation);
    const body=element('div',null,'cm-console-content'),panels={};dialog.append(body);
    const sections=[['memories','记忆'],['summary','总结设置'],['connections','API与向量'],['exchange','导入导出'],['failures','失败记录']];
    for(const [id,title] of sections){
      const tab=control(title);tab.dataset.cmTab=id;tab.id='cm-tab-'+id;tab.setAttribute('role','tab');tab.setAttribute('aria-controls','cm-page-'+id);navigation.append(tab);
      const panel=element('section',null,'cm-console-page');panel.id='cm-page-'+id;panel.dataset.cmPage=id;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);body.append(panel);panels[id]=panel;
    }
    const failureBadge=element('span',null,'cm-count');failureBadge.setAttribute('aria-hidden','true');failureBadge.hidden=true;navigation.querySelector('[data-cm-tab="failures"]').append(failureBadge);
    const footer=element('p','关闭管理台后，正在进行的总结和索引任务会继续。','cm-console-footer');dialog.append(footer);document.body.append(dialog);
    function select(id,focus=false){
      if(!panels[id])return;scrollPositions[current]=body.scrollTop;current=id;
      for(const tab of navigation.children){const selected=tab.dataset.cmTab===id;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;panels[tab.dataset.cmTab].hidden=!selected;}
      body.scrollTop=scrollPositions[id]||0;
      if(focus){const tab=navigation.querySelector(`[data-cm-tab="${id}"]`);tab.focus({preventScroll:true});tab.scrollIntoView({block:'nearest',inline:'nearest'});}
    }
    function refreshLauncher(){launcher.hidden=disabled||!showLauncher||dialog.open;}
    function open(){if(disabled||dialog.open)return;returnFocus=document.activeElement;dialog.showModal();body.scrollTop=scrollPositions[current]||0;refreshLauncher();navigation.querySelector(`[data-cm-tab="${current}"]`).focus({preventScroll:true});}
    function close(){if(dialog.open){scrollPositions[current]=body.scrollTop;dialog.close();}}
    openButton.addEventListener('click',open);launcher.addEventListener('click',open);closeButton.addEventListener('click',close);
    dialog.addEventListener('close',()=>{refreshLauncher();if(!disabled&&returnFocus?.isConnected&&!returnFocus.disabled)returnFocus.focus({preventScroll:true});});
    dialog.addEventListener('cancel',()=>{scrollPositions[current]=body.scrollTop;});
    dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();});
    dialog.addEventListener('keydown',event=>{
      if(event.key!=='Tab')return;
      const controls=[...dialog.querySelectorAll('button,input,select,textarea,summary,a[href],[tabindex]')].filter(el=>{const closed=el.closest('details:not([open])');return !el.disabled&&el.tabIndex>=0&&el.getClientRects().length&&(!closed||closed.firstElementChild.contains(el));});
      const first=controls[0],last=controls.at(-1);if(!first)return;
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    });
    navigation.addEventListener('click',event=>{const tab=event.target.closest('[data-cm-tab]');if(tab)select(tab.dataset.cmTab,true);});
    navigation.addEventListener('keydown',event=>{const index=sections.findIndex(([id])=>id===event.target.dataset.cmTab);if(index<0)return;let next;
      if(event.key==='ArrowRight')next=(index+1)%sections.length;else if(event.key==='ArrowLeft')next=(index+sections.length-1)%sections.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=sections.length-1;else return;
      event.preventDefault();select(sections[next][0],true);
    });
    checkbox.addEventListener('change',()=>{showLauncher=checkbox.checked;refreshLauncher();onLauncherChange(showLauncher);});
    select(current);refreshLauncher();
    return {dialog,toolbar,panels,open,close,select,
      status(text,pending=0){entryStats.textContent=headerStats.textContent=text;failureBadge.hidden=!pending;failureBadge.textContent=String(pending);},
      setEnabled(value){disabled=!value;openButton.disabled=checkbox.disabled=disabled;if(disabled)close();refreshLauncher();}
    };
  }
  root.ConversationMemoryConsole={create};
})(globalThis);
