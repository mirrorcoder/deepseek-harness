// The "bots" panel: a self-contained overlay contributed through the page's
// structured injection rows, talking to this extension's own authenticated
// routes. Pure string building, so the markup is testable.

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const CSS = `
.dsh-tg-btn{position:fixed;right:14px;bottom:52px;z-index:2147483000;width:30px;height:30px;border-radius:50%;
border:1px solid rgba(255,255,255,.18);background:rgba(28,28,30,.72);color:#d8d8dc;font:600 13px/28px ui-sans-serif,system-ui,sans-serif;
text-align:center;cursor:pointer;opacity:.45;transition:opacity .15s ease,transform .15s ease;backdrop-filter:blur(6px)}
.dsh-tg-btn:hover{opacity:1;transform:translateY(-1px)}
.dsh-tg-wrap{position:fixed;inset:0;z-index:2147483001;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
.dsh-tg-wrap[data-open="1"]{display:flex}
.dsh-tg-card{width:min(680px,92vw);max-height:84vh;overflow:auto;background:#1c1c1e;color:#e6e6ea;border:1px solid rgba(255,255,255,.12);
border-radius:14px;padding:22px 26px;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;box-shadow:0 18px 60px rgba(0,0,0,.5)}
.dsh-tg-card h2{margin:0 0 4px;font-size:18px}
.dsh-tg-card h3{margin:16px 0 6px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#a0a0a8}
.dsh-tg-card label{display:block;margin:8px 0 3px;font-size:12px;color:#a0a0a8}
.dsh-tg-card input,.dsh-tg-card select{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.14);
background:#141416;color:#e6e6ea;font:13px ui-sans-serif,system-ui,sans-serif}
.dsh-tg-row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:9px 0;border-top:1px solid rgba(255,255,255,.07)}
.dsh-tg-row b{font-weight:600}
.dsh-tg-dim{color:#8e8e96;font-size:12px}
.dsh-tg-act button{margin-left:6px}
.dsh-tg-card button{padding:6px 11px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#2a2a2e;color:#e6e6ea;cursor:pointer;font:13px ui-sans-serif,system-ui,sans-serif}
.dsh-tg-card button.primary{background:#2f6fd0;border-color:#2f6fd0}
.dsh-tg-card button:disabled{opacity:.5;cursor:default}
.dsh-tg-msg{margin:10px 0;padding:8px 10px;border-radius:8px;font-size:13px;display:none}
.dsh-tg-msg[data-kind="err"]{display:block;background:rgba(220,70,70,.15);color:#ff9d9d}
.dsh-tg-msg[data-kind="ok"]{display:block;background:rgba(70,180,110,.15);color:#8ce0ad}
.dsh-tg-close{float:right;border:0;background:transparent;color:#8e8e96;font-size:20px;cursor:pointer;line-height:1}
.dsh-tg-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
`.trim()

const HTML = `<button class="dsh-tg-btn" id="dsh-tg-open" type="button" aria-label="Telegram bots" title="Telegram bots">✈</button>
<div class="dsh-tg-wrap" id="dsh-tg-wrap" role="dialog" aria-modal="true" aria-label="Telegram bots">
<div class="dsh-tg-card">
<button class="dsh-tg-close" id="dsh-tg-close" type="button" aria-label="Close">&times;</button>
<h2>Трансляция в Telegram</h2>
<div class="dsh-tg-dim">Каждая сессия становится отдельным тредом в чате с ботом.</div>
<div class="dsh-tg-msg" id="dsh-tg-msg"></div>
<h3>Боты</h3>
<div id="dsh-tg-list"></div>
<h3>Добавить бота</h3>
<label for="dsh-tg-label">Название</label>
<input id="dsh-tg-label" placeholder="Мой бот" autocomplete="off">
<label for="dsh-tg-token">Токен от @BotFather</label>
<input id="dsh-tg-token" type="password" placeholder="123456:AA…" autocomplete="off">
<div class="dsh-tg-grid">
<div><label for="dsh-tg-chat">Куда слать</label>
<div style="display:flex;gap:6px"><input id="dsh-tg-chat" placeholder="chat id" autocomplete="off"><button id="dsh-tg-find" type="button" style="white-space:nowrap">Найти чаты</button></div></div>
<div><label for="dsh-tg-mode">Что слать</label><select id="dsh-tg-mode"><option value="stream">всё: вопрос, ответ, инструменты</option><option value="summary">только итоги и вопросы</option></select></div>
</div>
<div class="dsh-tg-dim" style="margin-top:6px">Бот не может написать первым: сначала напиши ему <b>/start</b> в Telegram, потом жми «Найти чаты».</div>
<div id="dsh-tg-chats" style="margin-top:8px"></div>
<div style="margin-top:12px"><button class="primary" id="dsh-tg-add" type="button">Добавить</button>
<span class="dsh-tg-dim" id="dsh-tg-hint"></span></div>
</div></div>`

const SCRIPT = `(function(){
var $=function(id){return document.getElementById(id)}
var wrap=$('dsh-tg-wrap'),list=$('dsh-tg-list'),msg=$('dsh-tg-msg')
if(!wrap)return
function say(kind,text){msg.setAttribute('data-kind',kind);msg.textContent=text}
function clear(){msg.removeAttribute('data-kind');msg.textContent=''}
function call(action,body){
  return fetch('/api/telegram/'+action,{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json'},body:JSON.stringify(body||{})})
    .then(function(r){return r.json()})
    .then(function(j){if(!j.ok)throw new Error(j.error||'не получилось');return j})
}
function row(d){
  var el=document.createElement('div')
  el.className='dsh-tg-row'
  var mode=d.mode==='summary'?'итоги':'всё'
  var listen={listening:'отвечает на команды',conflict:'команды заняты другим процессом','no-token':'нет токена',starting:'запускается',off:'команды выключены'}[d.listening]||''
  el.innerHTML='<div><b>'+esc(d.label)+'</b> <span class="dsh-tg-dim">chat '+esc(d.chatId)+' · '+mode+(d.enabled?'':' · выключен')+(d.readOnly?' · из .env':'')+(listen?' · '+listen:'')+'</span></div>'
  var act=document.createElement('div');act.className='dsh-tg-act'
  act.appendChild(btn('Тест',function(){call('test',{id:d.id}).then(function(){say('ok','Отправлено в '+d.label)}).catch(function(e){say('err',e.message)})}))
  if(!d.readOnly){
    act.appendChild(btn('Чаты',function(){
      call('discover',{id:d.id}).then(function(j){
        if(j.chats.length===0){say('err',j.hint||'Чатов нет');return}
        say('ok',j.chats.map(function(c){return c.title+' → '+c.id}).join('   |   '))
      }).catch(function(e){say('err',e.message)})
    }))
    act.appendChild(btn(d.enabled?'Выключить':'Включить',function(){
      call('save',{id:d.id,enabled:!d.enabled}).then(load).catch(function(e){say('err',e.message)})
    }))
    act.appendChild(btn('Удалить',function(){
      if(!confirm('Удалить '+d.label+'?'))return
      call('remove',{id:d.id}).then(load).catch(function(e){say('err',e.message)})
    }))
  }
  el.appendChild(act)
  return el
}
function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML}
function btn(text,onClick){var b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',onClick);return b}
function load(){
  return call('state').then(function(j){
    list.textContent=''
    if(j.destinations.length===0){list.innerHTML='<div class="dsh-tg-dim">Пока ни одного бота.</div>';return}
    j.destinations.forEach(function(d){list.appendChild(row(d))})
  }).catch(function(e){say('err',e.message)})
}
$('dsh-tg-open').addEventListener('click',function(){wrap.setAttribute('data-open','1');clear();load()})
$('dsh-tg-close').addEventListener('click',function(){wrap.setAttribute('data-open','0')})
wrap.addEventListener('click',function(e){if(e.target===wrap)wrap.setAttribute('data-open','0')})
document.addEventListener('keydown',function(e){if(e.key==='Escape')wrap.setAttribute('data-open','0')})
$('dsh-tg-token').addEventListener('change',function(){
  var t=$('dsh-tg-token').value.trim()
  if(t.length===0)return
  call('validate',{token:t}).then(function(j){$('dsh-tg-hint').textContent='бот @'+j.username}).catch(function(e){say('err',e.message)})
})
$('dsh-tg-find').addEventListener('click',function(){
  clear()
  var picks=$('dsh-tg-chats')
  picks.textContent=''
  var token=$('dsh-tg-token').value.trim()
  if(token.length===0){say('err','Сначала вставь токен бота');return}
  call('discover',{token:token}).then(function(j){
    if(j.chats.length===0){say('err',j.hint||'Чатов нет');return}
    j.chats.forEach(function(c){
      picks.appendChild(btn(c.title+' · '+c.id,function(){
        $('dsh-tg-chat').value=c.id
        say('ok','Выбран чат: '+c.title)
      }))
    })
  }).catch(function(e){say('err',e.message)})
})
$('dsh-tg-add').addEventListener('click',function(){
  clear()
  var body={label:$('dsh-tg-label').value,token:$('dsh-tg-token').value.trim(),chatId:$('dsh-tg-chat').value.trim(),mode:$('dsh-tg-mode').value}
  if(body.token.length===0){say('err','Нужен токен бота от @BotFather');return}
  if(body.chatId.length===0){say('err','Нужен чат: нажми «Найти чаты» и выбери');return}
  call('save',body).then(function(){
    $('dsh-tg-token').value='';$('dsh-tg-label').value='';$('dsh-tg-chat').value='';$('dsh-tg-hint').textContent='';$('dsh-tg-chats').textContent=''
    say('ok','Бот добавлен')
    return load()
  }).catch(function(e){say('err',e.message)})
})
})()`

/** The three index rows this panel needs. */
export function panelRows() {
  return [
    { kind: 'style', text: CSS },
    { kind: 'html', placement: 'body', html: HTML },
    { kind: 'script', placement: 'body', text: SCRIPT },
  ]
}
