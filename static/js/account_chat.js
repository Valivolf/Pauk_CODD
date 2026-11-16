// Переписка между учётными записями панели.
(() => {
  let people = [], peer = null, rows = [], reply = null, box;
  const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const request = async (url, opts = {}) => {
    const res = await fetch(url, { credentials: 'same-origin', ...opts });
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data?.detail || 'Не удалось выполнить действие');
    return data;
  };
  function render() {
    if (!box) return;
    box.innerHTML = `<div style="position:fixed;inset:0;background:#020617b8;z-index:59" data-x></div>
      <div class="glass rounded-3xl" style="position:fixed;inset:3vh 3vw;z-index:60;display:flex;flex-direction:column;overflow:hidden">
        <header class="px-5 py-3 border-b border-slate-700/60 flex justify-between items-center"><b>💬 Сообщения между учётками</b><div class="flex gap-3 items-center"><span class="text-xs text-slate-400">История хранится без срока, файлы — 14 дней</span><button data-x class="px-3 py-1 rounded-lg">✕</button></div></header>
        <div style="display:grid;grid-template-columns:minmax(190px,260px) 1fr;flex:1;min-height:0">
          <aside class="overflow-auto p-2 border-r border-slate-700/50">${people.map(p=>`<button data-peer="${p.id}" class="block w-full text-left rounded-xl px-3 py-2 mb-1 ${peer===p.id?'bg-indigo-500/25':'hover:bg-slate-700/40'}"><b>${h(p.username)}</b>${p.last_id?`<small class="block text-slate-400">Есть сообщения</small>`:''}</button>`).join('') || '<p class="p-3 text-sm text-slate-400">Нет других учётных записей</p>'}</aside>
          <section style="display:flex;flex-direction:column;min-width:0;min-height:0"><div id="acMsgs" style="overflow:auto;flex:1;padding:16px;display:flex;flex-direction:column;gap:8px">${peer?rows.map(m=>message(m)).join(''):'<div class="m-auto text-slate-400">Выберите учётную запись</div>'}</div>
            ${peer?`<div class="px-4 py-3 border-t border-slate-700/60"><div id="acReply" class="text-xs text-indigo-300 mb-1">${reply?`Ответ на сообщение №${reply} <button data-clearreply>×</button>`:''}</div><div class="flex gap-2 items-end"><input id="acFiles" type="file" multiple class="text-xs" style="max-width:180px"><textarea id="acText" rows="2" class="rounded-xl bg-slate-900/70 border border-slate-600 p-2 flex-1" placeholder="Сообщение… (Enter — отправить)"></textarea><button id="acSend" class="rounded-xl bg-indigo-600 px-4 py-2">Отправить</button></div><div id="acErr" class="text-xs text-rose-300 mt-1"></div></div>`:''}
          </section></div></div>`;
    box.querySelectorAll('[data-x]').forEach(b=>b.onclick=close);
    box.querySelectorAll('[data-peer]').forEach(b=>b.onclick=()=>select(+b.dataset.peer));
    box.querySelector('[data-clearreply]')?.addEventListener('click',()=>{reply=null;render();});
    box.querySelector('#acSend')?.addEventListener('click',send);
    box.querySelector('#acText')?.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
    box.querySelectorAll('[data-reply]').forEach(b=>b.onclick=()=>{reply=+b.dataset.reply;render();box.querySelector('#acText')?.focus();});
    box.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>edit(+b.dataset.edit));
    box.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>remove(+b.dataset.del));
    const msgs=box.querySelector('#acMsgs'); if(msgs) msgs.scrollTop=msgs.scrollHeight;
  }
  function message(m) {
    const mine=m.sender_id===window.AccountChatMe;
    const files=(m.files||[]).map(f=>f.expired?`<div class="text-xs text-slate-400">📎 ${h(f.name)} · срок хранения истёк</div>`:`<a class="block text-xs underline text-sky-300" href="/api/account-chat/files/${f.id}">📎 ${h(f.name)} (${Math.ceil(f.size/1024)} КБ)</a>`).join('');
    return `<div style="align-self:${mine?'flex-end':'flex-start'};max-width:85%" class="rounded-2xl border border-slate-600/50 bg-slate-800/70 px-3 py-2"><div class="text-[10px] text-slate-400">${h(m.sender)} · ${h(new Date(m.created_at).toLocaleString())}${m.edited_at?' · изменено':''}</div>${m.deleted_at?'<i class="text-slate-400">Сообщение удалено</i>':`${m.reply_to?`<div class="text-xs text-indigo-300">↪ ответ на №${m.reply_to}</div>`:''}<div style="white-space:pre-wrap;overflow-wrap:anywhere">${h(m.text)}</div>${files}`}
      <div class="mt-1 flex gap-2 text-[10px]"><button data-reply="${m.id}" class="text-indigo-300">Ответить</button>${mine&&!m.deleted_at?`<button data-edit="${m.id}" class="text-sky-300">Изменить</button><button data-del="${m.id}" class="text-rose-300">Удалить</button>`:''}</div></div>`;
  }
  async function select(id) { peer=id; reply=null; try { rows=await request(`/api/account-chat/${id}/messages?limit=1000`); } catch(e){rows=[];} render(); }
  async function send() {
    const text=box.querySelector('#acText').value.trim(), files=[...box.querySelector('#acFiles').files];
    if(!text&&!files.length)return;
    try {
      let msg;
      if(files.length){const fd=new FormData();fd.append('text',text);if(reply)fd.append('reply_to',reply);files.forEach(f=>fd.append('files',f));msg=await request(`/api/account-chat/${peer}/files`,{method:'POST',body:fd});}
      else msg=await request(`/api/account-chat/${peer}/send`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,reply_to:reply})});
      rows.push(msg);reply=null;render();
    } catch(e){box.querySelector('#acErr').textContent=e.message;}
  }
  async function edit(id){const m=rows.find(x=>x.id===id);const text=prompt('Изменить сообщение',m?.text||'');if(text===null||!text.trim())return;try{const updated=await request(`/api/account-chat/messages/${id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});rows=rows.map(x=>x.id===id?updated:x);render();}catch(e){alert(e.message);}}
  async function remove(id){if(!confirm('Удалить сообщение?'))return;try{await request(`/api/account-chat/messages/${id}`,{method:'DELETE'});rows=rows.map(x=>x.id===id?{...x,text:'',deleted_at:new Date().toISOString(),files:[]}:x);render();}catch(e){alert(e.message);}}
  async function open(){box=document.createElement('div');document.body.append(box);try{const me=await request('/api/auth/me');window.AccountChatMe=me.id;people=await request('/api/account-chat/users');rows=[];peer=null;render();}catch(e){box.innerHTML=`<div class="fixed inset-0 z-[60] grid place-items-center bg-slate-950/80"><div class="p-6">${h(e.message)} <button onclick="this.closest('div.fixed').remove()">Закрыть</button></div></div>`;}}
  function close(){box?.remove();box=null;}
  document.addEventListener('DOMContentLoaded',()=>{request('/api/auth/me').then(me=>{if(!(me.permissions||[]).some(x=>x==='*'||x==='chat.view'))return;const b=document.createElement('button');b.type='button';b.title='Сообщения между учётками';b.textContent='👥';b.style.cssText='position:fixed;left:7.25rem;bottom:1rem;z-index:41;width:2.5rem;height:2.5rem;border-radius:9999px;border:1px solid #64748b80;background:#0f172ae0;color:#e2e8f0;box-shadow:0 6px 20px #0006;cursor:pointer';b.onclick=open;document.body.append(b);}).catch(()=>{});});
})();
