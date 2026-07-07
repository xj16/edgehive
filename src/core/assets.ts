/**
 * Bundled, self-contained HTML assets served straight from the app so a running
 * EdgeHive instance is its own front door — no separate static host, no CDN, no
 * build step. Both pages are pure inline HTML/CSS/JS (nothing external), so they
 * work offline and satisfy strict Content-Security-Policy sandboxes.
 *
 *   /docs  -> `DOCS_HTML`   — a dependency-free OpenAPI explorer that reads
 *                             `/openapi.json` and lets you try endpoints live.
 *   /app   -> `CLIENT_HTML` — the rich realtime client: a live collection table
 *                             driven by the initial SSE snapshot + change events,
 *                             with create / edit / delete wired to the API.
 */

export const DOCS_HTML = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>EdgeHive · API docs</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0e14;color:#cdd6f4}
header{padding:1.5rem 1.25rem;border-bottom:1px solid #1c2333;background:#0d1119}
h1{margin:0;font-size:1.35rem;color:#f5c542}
header p{margin:.35rem 0 0;color:#7f849c}
main{max-width:960px;margin:0 auto;padding:1.5rem 1.25rem}
.op{border:1px solid #1c2333;border-radius:10px;margin-bottom:.9rem;overflow:hidden;background:#0d1119}
.op summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:.6rem;padding:.7rem .9rem}
.op summary::-webkit-details-marker{display:none}
.m{font-weight:700;font-size:.72rem;padding:.15rem .5rem;border-radius:5px;min-width:54px;text-align:center}
.get{background:#1e66f533;color:#89b4fa}.post{background:#40a02b33;color:#a6e3a1}
.put{background:#df8e1d33;color:#f9e2af}.delete{background:#d20f3933;color:#f38ba8}
.path{font-family:ui-monospace,Menlo,Consolas,monospace}
.sum{color:#7f849c;margin-left:auto;font-size:.85rem}
.body{padding:0 .9rem .9rem;border-top:1px solid #1c2333}
table{width:100%;border-collapse:collapse;margin:.6rem 0;font-size:.85rem}
td,th{text-align:left;padding:.3rem .5rem;border-bottom:1px solid #161d2b;vertical-align:top}
th{color:#7f849c;font-weight:600}
code{background:#161d2b;padding:.1rem .35rem;border-radius:4px;font-family:ui-monospace,Menlo,Consolas,monospace}
.badge{display:inline-block;background:#161d2b;color:#89b4fa;padding:.1rem .45rem;border-radius:4px;font-size:.75rem;margin-left:.4rem}
a{color:#89b4fa}
.lead a{margin-right:1rem}
</style></head><body>
<header>
  <h1>EdgeHive API</h1>
  <p class="lead">Interactive reference generated from
    <a href="/openapi.json">/openapi.json</a> ·
    <a href="/app">Realtime client</a> ·
    <a href="https://github.com/xj16/edgehive">GitHub</a></p>
</header>
<main id="app">Loading the OpenAPI spec…</main>
<script>
const mc={get:'get',post:'post',put:'put',delete:'delete'};
fetch('/openapi.json').then(r=>r.json()).then(spec=>{
  const app=document.getElementById('app');app.innerHTML='';
  const info=document.createElement('p');info.className='sum';
  info.textContent=spec.info.title+' v'+spec.info.version;app.appendChild(info);
  const paths=spec.paths||{};
  for(const p of Object.keys(paths)){
    for(const method of Object.keys(paths[p])){
      if(method==='parameters')continue;
      const op=paths[p][method];
      const d=document.createElement('details');d.className='op';
      const s=document.createElement('summary');
      s.innerHTML='<span class="m '+(mc[method]||'get')+'">'+method.toUpperCase()+'</span>'+
        '<span class="path">'+p+'</span>'+
        (op.security?'<span class="badge">auth</span>':'')+
        '<span class="sum">'+(op.summary||'')+'</span>';
      d.appendChild(s);
      const b=document.createElement('div');b.className='body';
      const params=[...(paths[p].parameters||[]),...(op.parameters||[])];
      if(params.length){
        let t='<table><tr><th>Parameter</th><th>In</th><th>Type</th></tr>';
        for(const pr of params){t+='<tr><td><code>'+pr.name+'</code></td><td>'+pr.in+
          '</td><td>'+((pr.schema&&pr.schema.type)||'string')+
          (pr.schema&&pr.schema.enum?' ('+pr.schema.enum.join(' | ')+')':'')+'</td></tr>';}
        b.innerHTML+=t+'</table>';
      }
      if(op.requestBody){b.innerHTML+='<p><strong>Request body:</strong> <code>application/json</code></p>';}
      let rt='<table><tr><th>Status</th><th>Meaning</th></tr>';
      for(const code of Object.keys(op.responses||{})){
        rt+='<tr><td><code>'+code+'</code></td><td>'+(op.responses[code].description||'')+'</td></tr>';}
      b.innerHTML+=rt+'</table>';
      d.appendChild(b);app.appendChild(d);
    }
  }
}).catch(e=>{document.getElementById('app').textContent='Failed to load spec: '+e;});
</script>
</body></html>`;

export const CLIENT_HTML = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>EdgeHive · realtime client</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0e14;color:#cdd6f4;padding:1.5rem 1rem}
main{max-width:880px;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 .2rem;color:#f5c542}
.sub{margin:0 0 1.2rem;color:#7f849c;font-size:.9rem}
.bar{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}
input,button,select{font:inherit;padding:.5rem .7rem;border-radius:6px;border:1px solid #313244;background:#181825;color:#cdd6f4}
input{min-width:120px}
button{cursor:pointer;background:#f5c542;color:#11111b;border:none;font-weight:600}
button.ghost{background:#181825;color:#cdd6f4;border:1px solid #313244}
button.mini{padding:.25rem .5rem;font-size:.78rem}
.pill{margin-left:auto;font-size:.8rem;color:#7f849c;display:flex;gap:.4rem;align-items:center}
.dot{width:9px;height:9px;border-radius:50%;background:#6c7086}
.dot.live{background:#a6e3a1;box-shadow:0 0 8px #a6e3a1}
.dot.err{background:#f38ba8}
.hint{background:#11162080;border:1px solid #1c2333;border-radius:8px;padding:.6rem .8rem;font-size:.85rem;color:#9399b2;margin-bottom:1rem}
.hint b{color:#89b4fa}
table{width:100%;border-collapse:collapse;background:#0d1119;border:1px solid #1c2333;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid #161d2b;font-size:.88rem;vertical-align:top}
th{color:#7f849c;font-weight:600;background:#0d1119}
td.id{font-family:ui-monospace,Menlo,Consolas,monospace;color:#89b4fa;font-size:.8rem}
td.data{font-family:ui-monospace,Menlo,Consolas,monospace;color:#cdd6f4;word-break:break-word}
tr.flash{animation:flash 1s ease}
@keyframes flash{from{background:#f5c54222}to{background:transparent}}
.empty{color:#6c7086;text-align:center;padding:2rem}
.count{color:#7f849c;font-size:.82rem;margin:.6rem 0}
.actions{white-space:nowrap}
</style></head><body>
<main>
  <h1>EdgeHive · live collection</h1>
  <p class="sub">A live-updating CRUD board over Server-Sent Events. The same server runs on Bun, Deno &amp; Node.</p>

  <div class="bar">
    <input id="base" value="" aria-label="Base URL" placeholder="http://localhost:8787"/>
    <input id="col" value="messages" aria-label="Collection"/>
    <button id="reconnect" class="ghost">Reconnect</button>
    <span class="pill"><span id="dot" class="dot"></span><span id="status">connecting…</span></span>
  </div>

  <div class="hint">Open <b>this page in a second tab</b> and watch rows you create, edit or delete
    appear instantly in both — that is the realtime SSE layer fanning out to every subscriber.</div>

  <div class="bar">
    <input id="field" value="text" aria-label="Field name" style="max-width:130px"/>
    <input id="value" placeholder="value…" aria-label="Value"/>
    <button id="create">Create</button>
    <button id="clear" class="ghost">Clear view</button>
  </div>

  <div class="count" id="count"></div>
  <table>
    <thead><tr><th style="width:24%">id</th><th>data</th><th style="width:150px">actions</th></tr></thead>
    <tbody id="rows"><tr><td class="empty" colspan="3">No documents yet — create one above.</td></tr></tbody>
  </table>
</main>
<script>
const $=id=>document.getElementById(id);
const state=new Map(); // id -> doc
let token=null,es=null;
const baseUrl=()=>($('base').value||location.origin).replace(/\\/$/,'');
const col=()=>($('col').value.trim()||'messages');

function setStatus(s,cls){$('status').textContent=s;$('dot').className='dot'+(cls?' '+cls:'');}

async function ensureToken(){
  if(token)return token;
  const r=await fetch(baseUrl()+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({email:'browser@edgehive.dev'})});
  token=(await r.json()).token;return token;
}

function render(flashId){
  const rows=$('rows');const docs=[...state.values()]
    .sort((a,b)=>(a.createTime||'').localeCompare(b.createTime||''));
  $('count').textContent=docs.length+' document'+(docs.length===1?'':'s')+' · '+col();
  if(!docs.length){rows.innerHTML='<tr><td class="empty" colspan="3">No documents yet — create one above.</td></tr>';return;}
  rows.innerHTML='';
  for(const d of docs){
    const tr=document.createElement('tr');if(d.id===flashId)tr.className='flash';
    const data=document.createElement('td');data.className='data';data.textContent=JSON.stringify(d.data);
    const idc=document.createElement('td');idc.className='id';idc.textContent=d.id;
    const act=document.createElement('td');act.className='actions';
    const edit=document.createElement('button');edit.className='mini ghost';edit.textContent='edit';
    edit.onclick=()=>editDoc(d);
    const del=document.createElement('button');del.className='mini ghost';del.textContent='delete';
    del.style.marginLeft='.4rem';del.onclick=()=>deleteDoc(d.id);
    act.appendChild(edit);act.appendChild(del);
    tr.appendChild(idc);tr.appendChild(data);tr.appendChild(act);rows.appendChild(tr);
  }
}

function connect(){
  if(es)es.close();state.clear();render();
  setStatus('connecting…');
  es=new EventSource(baseUrl()+'/v1/'+col()+'/stream');
  es.addEventListener('ready',()=>setStatus('live','live'));
  es.addEventListener('heartbeat',()=>setStatus('live','live'));
  es.addEventListener('snapshot',e=>{
    const snap=JSON.parse(e.data);state.clear();
    for(const d of snap.documents)state.set(d.id,d);render();setStatus('live','live');
  });
  es.addEventListener('created',e=>{const d=JSON.parse(e.data);state.set(d.id,{id:d.id,data:d.data,createTime:new Date(d.ts).toISOString()});render(d.id);});
  es.addEventListener('updated',e=>{const d=JSON.parse(e.data);const p=state.get(d.id)||{};state.set(d.id,{id:d.id,data:d.data,createTime:p.createTime});render(d.id);});
  es.addEventListener('deleted',e=>{const d=JSON.parse(e.data);state.delete(d.id);render();});
  es.onerror=()=>setStatus('reconnecting…','err');
}

async function createDoc(){
  const f=$('field').value.trim()||'text';const v=$('value').value;
  if(!v)return;
  await ensureToken();
  let parsed=v;try{parsed=JSON.parse(v);}catch{}
  await fetch(baseUrl()+'/v1/'+col(),{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+token},
    body:JSON.stringify({[f]:parsed,at:Date.now()})});
  $('value').value='';
}
async function editDoc(d){
  const next=prompt('Edit JSON for '+d.id,JSON.stringify(d.data));
  if(next===null)return;
  let body;try{body=JSON.parse(next);}catch{alert('Invalid JSON');return;}
  await ensureToken();
  await fetch(baseUrl()+'/v1/'+col()+'/'+d.id,{method:'PUT',
    headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
}
async function deleteDoc(id){
  await ensureToken();
  await fetch(baseUrl()+'/v1/'+col()+'/'+id,{method:'DELETE',headers:{authorization:'Bearer '+token}});
}

$('create').onclick=createDoc;
$('value').addEventListener('keydown',e=>{if(e.key==='Enter')createDoc();});
$('clear').onclick=()=>{state.clear();render();};
$('reconnect').onclick=connect;
$('col').addEventListener('change',connect);
$('base').addEventListener('change',()=>{token=null;connect();});
if(!$('base').value)$('base').value=location.origin;
connect();
</script>
</body></html>`;
