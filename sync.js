// Conta a Dois: sincronização dos dados com o Supabase.
// Só dados: os arquivos do cofre de documentos, o PIN e o tema ficam no aparelho.
// Cada item vira uma linha; itens individuais levam o dono e só ele os enxerga (regra no servidor).
(function(){
const CFG=window.SYNC_CONFIG||{};
const ON=!!(CFG.url&&CFG.key&&window.supabase&&window.supabase.createClient);
const SKEY='contaadois.sync';
const ARR={expense:'expenses',settlement:'settlements',bill:'bills',saving:'savings',inventory:'inventory',list:'lists',doc:'docs',card:'cards'};
let st=loadSt(),sb=null,session=null,busy=false,again=false,timer=null,needRender=false;
let info={state:ON?'saindo':'desligada',msg:''}; // desligada | saindo (sem login) | sem-casal | ok | sincronizando | erro

function loadSt(){try{const s=JSON.parse(localStorage.getItem(SKEY));if(s&&s.snap) return s}catch(e){}return {snap:{}}}
function saveSt(){try{localStorage.setItem(SKEY,JSON.stringify(st))}catch(e){}}
const connected=()=>!!(session&&st.hid&&st.uid===session.user.id);
// texto estável de um objeto (chaves ordenadas), para comparar o que mudou
function canon(v){
  if(v===null||typeof v!=='object') return JSON.stringify(v===undefined?null:v);
  if(Array.isArray(v)) return '['+v.map(canon).join(',')+']';
  return '{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
}
const priv=k=>'p:'+st.uid+':'+k;
// linha em que um item local é guardado; null = fica só neste aparelho
function ridOf(kind,x){
  const me=st.person;
  if(x.demo) return null;
  if(kind==='expense'){
    if(x.scope!=='casal'&&x.scope===x.payer) return x.scope===me?priv('expense:'+x.id):null; // gasto individual: só do dono
    return 'expense:'+x.id;
  }
  if(kind==='saving'){
    if(x.owner==='casal') return 'saving:'+x.id;
    return x.owner===me?priv('saving:'+x.id):null;
  }
  if(kind==='bill'&&x.scope&&x.scope!=='casal') return x.scope===me?priv('bill:'+x.id):null; // conta fixa individual: só do dono
  if(kind==='doc'&&x.priv) return null;                    // comprovante de gasto individual: só no aparelho
  return kind+':'+x.id;
}
function localRows(){
  const out={},put=(id,kind,data)=>{out[id]={id,kind,owner:id.startsWith('p:')?st.uid:null,data}};
  for(const kind in ARR) for(const x of S[ARR[kind]]||[]){const id=ridOf(kind,x);if(id) put(id,kind,x)}
  put('config:names','config',{names:S.names});
  put('config:prefs','config',{defaultShareA:S.defaultShareA,remindDays:S.remindDays});
  if(S.deco) put('config:deco:'+st.person,'config',{v:S.deco[st.person]});
  if(S.cats) put('config:cats','config',{cats:S.cats});
  put('budget:casal','budget',S.budgets.casal||{});
  put(priv('budget'),'budget',S.budgets[st.person]||{});
  if(S.vault) put('config:vault','config',S.vault);
  return out;
}
function parseRid(rid){const base=rid.startsWith('p:')?rid.split(':').slice(2).join(':'):rid;const i=base.indexOf(':');return {base,kind:i<0?base:base.slice(0,i),iid:i<0?'':base.slice(i+1)}}
function applyRow(r){
  const {base,kind,iid}=parseRid(r.id),arr=ARR[kind];
  if(arr){
    const list=S[arr]||(S[arr]=[]),i=list.findIndex(x=>x.id===iid);
    if(r.deleted){if(i>=0&&ridOf(kind,list[i])===r.id) list.splice(i,1)}
    else if(i>=0) list[i]=r.data; else list.push(r.data);
    return;
  }
  if(r.deleted) return;
  if(base==='config:names'&&r.data.names) S.names=r.data.names;
  else if(base==='config:prefs'){if(typeof r.data.defaultShareA==='number') S.defaultShareA=r.data.defaultShareA;if(r.data.remindDays) S.remindDays=r.data.remindDays}
  else if(base==='config:cats'){if(Array.isArray(r.data.cats)&&r.data.cats.length) S.cats=r.data.cats}
  else if(base==='config:deco:a'||base==='config:deco:b'){if(r.data.v){if(!S.deco) S.deco={};S.deco[base.slice(-1)]=r.data.v}}
  else if(base==='config:vault'){if(r.data&&r.data.salt){S.vault=r.data;vkey=null}}
  else if(base==='budget:casal') S.budgets.casal=r.data||{};
  else if(base==='budget') S.budgets[st.person]=r.data||{};
}

async function pull(){
  const hid=st.hid;let since=st.cursor?new Date(Date.parse(st.cursor)-10000).toISOString():'1970-01-01T00:00:00Z',changed=false,max=st.cursor||'';
  for(let page=0;page<40;page++){
    const {data,error}=await sb.from('items').select('id,kind,owner,data,deleted,updated_at').eq('household_id',hid).gte('updated_at',since).order('updated_at',{ascending:true}).limit(500);
    if(error) throw error;
    const cur=localRows();
    for(const r of data){
      if(r.updated_at>max) max=r.updated_at;
      const rc=r.deleted?undefined:canon(r.data),lc=cur[r.id]?canon(cur[r.id].data):undefined,sn=st.snap[r.id];
      if(rc===lc){if(rc===undefined) delete st.snap[r.id];else st.snap[r.id]=rc;continue}
      const dirty=lc!==sn;
      if(dirty&&sn!==undefined) continue;                    // mudei aqui depois da última sincronização: o meu vale e será enviado
      if(dirty&&sn===undefined){                              // existe nos dois lados e nunca foi sincronizado
        if(r.deleted) continue;
        if(r.kind==='list'){                                  // listas: junta os itens dos dois
          const mine=cur[r.id].data,ids=new Set((r.data.items||[]).map(i=>i.id));
          applyRow({...r,data:{...r.data,items:[...(r.data.items||[]),...(mine.items||[]).filter(i=>!ids.has(i.id))]}});
          st.snap[r.id]=rc;changed=true;continue;
        }
      }
      applyRow(r);changed=true;
      if(rc===undefined) delete st.snap[r.id];else st.snap[r.id]=rc;
    }
    if(data.length<500) break;
    const last=data[data.length-1].updated_at;if(last===since) break;since=last;
  }
  if(max) st.cursor=max;
  return changed;
}
async function push(){
  const hid=st.hid,cur=localRows(),ups=[];
  for(const id in cur){const c=canon(cur[id].data);if(st.snap[id]!==c) ups.push({row:{household_id:hid,id,kind:cur[id].kind,owner:cur[id].owner,data:cur[id].data,deleted:false},c})}
  for(const id in st.snap) if(!(id in cur)) ups.push({row:{household_id:hid,id,kind:parseRid(id).kind,owner:id.startsWith('p:')?st.uid:null,data:{},deleted:true},c:undefined});
  for(let i=0;i<ups.length;i+=200){
    const part=ups.slice(i,i+200);
    const {error}=await sb.from('items').upsert(part.map(u=>u.row),{onConflict:'household_id,id'});
    if(error) throw error;
    for(const u of part){if(u.c===undefined) delete st.snap[u.row.id];else st.snap[u.row.id]=u.c}
    saveSt();
  }
  return ups.length;
}
const SIC={
  ok:'<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 10.4 3.8 3.8 0 0 1 17.4 18z"/><path d="M9.3 13.4l2 2 3.4-4"/>',
  sincronizando:'<path d="M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2M20 5v4h-4M4 19v-4h4"/>',
  erro:'<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 10.4 3.8 3.8 0 0 1 17.4 18z"/><path d="M12 11v3M12 16.3v.1"/>'};
function badge(){
  if(!connected()) return '';
  const k=info.state==='sincronizando'?'sincronizando':info.state==='erro'?'erro':'ok';
  const label=k==='ok'?'Sincronizado. Toque para sincronizar agora.':k==='erro'?'A sincronização falhou. Toque para tentar de novo.':'Sincronizando.';
  return `<button class="sync-btn ${k}" data-act="sync-now" aria-label="${label}" title="${label}"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${SIC[k]}</svg></button>`;
}
function paint(){const el=document.getElementById('sync-slot');if(el) el.innerHTML=badge()}
function rawSave(){try{localStorage.setItem(KEY,JSON.stringify(S))}catch(e){}}
function refresh(){
  const typing=document.activeElement&&/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if(dlg.open||typing){needRender=true;return}
  needRender=false;render();
}
async function syncNow(manual){
  if(!connected()) return;
  if(busy){again=true;return}
  busy=true;info={state:'sincronizando',msg:''};paint();
  try{
    if(manual||!st.members||st.members<2){const m=await sb.rpc('my_membership');if(m.error) throw m.error;if(m.data) setMember(m.data)}
    const changed=await pull();
    if(changed) rawSave();
    if(!vkey) await loadKey();
    await push();
    st.last=Date.now();saveSt();
    uploadPending();
    info={state:'ok',msg:''};
    if(changed||manual||needRender) refresh();
  }catch(e){
    info={state:'erro',msg:navigator.onLine===false?'Sem internet. Os lançamentos ficam guardados e sobem quando a conexão voltar.':'Não consegui sincronizar agora ('+String(e&&e.message||e).slice(0,120)+').'};
    saveSt();if(manual) refresh();
  }
  busy=false;paint();
  if(again){again=false;schedule(400)}
}
function schedule(ms){clearTimeout(timer);timer=setTimeout(()=>syncNow(false),ms)}
function setMember(d){
  st.hid=d.household_id;st.person=d.person;st.code=d.invite_code;st.members=Number(d.members)||1;
  if(S.me!==d.person){S.me=d.person;rawSave()}
  saveSt();
}
async function afterLogin(){
  if(!session) return;
  if(st.uid&&st.uid!==session.user.id) st={snap:{}};       // outra conta neste aparelho: recomeça o controle, sem apagar dados locais
  st.uid=session.user.id;st.email=session.user.email||'';saveSt();
  try{
    const m=await sb.rpc('my_membership');
    if(m.error) throw m.error;
    if(m.data){setMember(m.data);info={state:'ok',msg:''};refresh();syncNow(false)}
    else{st.hid=null;saveSt();info={state:'sem-casal',msg:''};refresh()}
  }catch(e){info={state:connected()?'erro':'sem-casal',msg:'Não consegui falar com o servidor ('+String(e&&e.message||e).slice(0,120)+').'};refresh();if(connected()) schedule(5000)}
}
function forget(){vkey=null;st={snap:{}};saveSt();if(sb) sb.auth.signOut().catch(()=>{});session=null;info={state:ON?'saindo':'desligada',msg:''}}

/* ---------- cofre: arquivos criptografados no aparelho antes de subir ---------- */
// A chave sai da senha do cofre (PBKDF2) e fica guardada neste aparelho sem poder ser exportada.
// O servidor só recebe o arquivo já cifrado (AES-GCM). Sem a senha, ninguém abre os arquivos.
const BUCKET='docs',MARK='conta-a-dois';
let vkey=null,vbusy=false,vmsg='';
const te=new TextEncoder(),td=new TextDecoder();
const b64=u8=>btoa(String.fromCharCode(...u8)),unb64=t=>Uint8Array.from(atob(t),c=>c.charCodeAt(0));
async function derive(pass,salt,iter){
  const km=await crypto.subtle.importKey('raw',te.encode(pass),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:iter,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function encBytes(key,buf){const iv=crypto.getRandomValues(new Uint8Array(12)),ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,buf));const out=new Uint8Array(12+ct.length);out.set(iv);out.set(ct,12);return out}
async function decBytes(key,u8){return crypto.subtle.decrypt({name:'AES-GCM',iv:u8.slice(0,12)},key,u8.slice(12))}
async function checkKey(k){try{return td.decode(await decBytes(k,unb64(S.vault.check)))===MARK}catch(e){return false}}
const keySlot=()=>'__vaultkey:'+st.hid;
async function loadKey(){
  vkey=null;if(!connected()||!S.vault) return;
  try{const k=await fileGet(keySlot());if(k&&await checkKey(k)) vkey=k}catch(e){}
}
async function vaultCreate(pass){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iter=310000,k=await derive(pass,salt,iter);
  const vault={salt:b64(salt),iter,check:b64(await encBytes(k,te.encode(MARK)))};
  await filePut(keySlot(),k);S.vault=vault;vkey=k;save();
}
async function vaultOpen(pass){
  const k=await derive(pass,unb64(S.vault.salt),S.vault.iter);
  if(!await checkKey(k)) throw new Error('senha_errada');
  await filePut(keySlot(),k);vkey=k;
}
const sendable=d=>!d.demo&&d.hasFile&&!d.priv;
async function uploadPending(){
  if(!vkey||vbusy||!connected()) return;
  vbusy=true;let n=0;
  try{
    for(const d of S.docs){
      if(n>=2) break;
      if(!sendable(d)||d.remote) continue;
      let blob=null;try{blob=await fileGet(d.id)}catch(e){}
      if(!blob) continue;
      const ct=await encBytes(vkey,await blob.arrayBuffer());
      const {error}=await sb.storage.from(BUCKET).upload(st.hid+'/'+d.id,new Blob([ct],{type:'application/octet-stream'}),{upsert:true,contentType:'application/octet-stream'});
      if(error) throw error;
      d.remote=true;n++;
    }
    vmsg='';
    if(n){rawSave();schedule(300)}
  }catch(e){vmsg='Não consegui enviar um arquivo do cofre ('+String(e&&e.message||e).slice(0,120)+').'}
  vbusy=false;
}
window.vaultOn=()=>connected()&&!!S.vault;
window.vaultFetch=async d=>{
  if(!connected()) throw new Error('O arquivo não está neste aparelho.');
  if(d.priv||!d.remote) throw new Error('O arquivo está guardado só no aparelho em que foi adicionado. Ele sobe quando o cofre for aberto lá.');
  if(!vkey) throw new Error('Para abrir, digite a senha do cofre em Mais, Ajustes, Sincronização.');
  const {data,error}=await sb.storage.from(BUCKET).download(st.hid+'/'+d.id);
  if(error) throw new Error('Não consegui baixar o arquivo ('+String(error.message||error).slice(0,100)+').');
  let plain;try{plain=await decBytes(vkey,new Uint8Array(await data.arrayBuffer()))}catch(e){throw new Error('Não consegui abrir o arquivo com a senha do cofre deste aparelho.')}
  const blob=new Blob([plain],{type:d.type||'application/octet-stream'});
  try{await filePut(d.id,blob)}catch(e){}
  return blob;
};
window.vaultRemove=id=>{if(connected()) sb.storage.from(BUCKET).remove([st.hid+'/'+id]).catch(()=>{})};
function vaultBlock(){
  if(!window.crypto||!crypto.subtle) return '<h3>Cofre de documentos</h3><p class="sub">Este navegador não tem a criptografia necessária para o cofre.</p>';
  const all=S.docs.filter(sendable),sent=all.filter(d=>d.remote).length;
  if(!S.vault) return `<h3>Cofre de documentos</h3><p class="sub">Crie uma senha para os arquivos do cofre sincronizarem. Eles são criptografados neste aparelho antes de subir, e só abrem com essa senha. Se vocês perderem a senha, os arquivos na nuvem não podem ser recuperados.</p>
    <div class="two"><div class="field"><label class="label" for="vault-p1">Senha do cofre (8 caracteres ou mais)</label><input type="password" id="vault-p1" autocomplete="new-password"></div>
    <div class="field"><label class="label" for="vault-p2">Repita a senha</label><input type="password" id="vault-p2" autocomplete="new-password"></div></div>
    <div><button class="btn" data-act="sync-vault-create">Criar senha do cofre</button></div>`;
  if(!vkey) return `<h3>Cofre de documentos</h3><p class="sub">O cofre já tem senha. Digite-a uma vez para este aparelho abrir e enviar os arquivos.</p>
    <div class="toolbar"><input type="password" class="grow" id="vault-p1" autocomplete="current-password" aria-label="Senha do cofre"><button class="btn" data-act="sync-vault-open">Abrir o cofre</button></div>`;
  return `<h3>Cofre de documentos</h3><p class="sub">Cofre aberto neste aparelho. Arquivos enviados: ${sent} de ${all.length}.</p>${vmsg?`<p class="err">${esc(vmsg)}</p>`:''}`;
}

/* ---------- tela (cartão em Ajustes) ---------- */
function card(){
  if(!STANDALONE) return '';
  let body;
  if(!ON) body='<p class="sub">A sincronização ainda não foi ligada neste app.</p>';
  else if(!session) body=`<p class="sub">Entre com a sua conta Google para os lançamentos aparecerem em todos os seus aparelhos e nos da outra pessoa. Os arquivos do cofre de documentos continuam só neste aparelho.</p>${hasDemo()?'<p class="sub">Antes de entrar, apague os dados de exemplo.</p><div><button class="btn small" data-act="clear-demo">Apagar exemplos</button></div>':'<div><button class="btn primary" data-act="sync-login">Entrar com Google</button></div>'}`;
  else if(!connected()) body=`<p class="sub">Conectado como ${esc(st.email||'sua conta')}. Falta ligar esta conta ao espaço do casal.</p>
    <div class="field"><span class="label">Se você é a primeira pessoa a entrar: quem é você?</span>${seg('sync-person',[['a',N('a')],['b',N('b')]],S.me)}</div>
    <div><button class="btn primary" data-act="sync-create">Criar o espaço do casal</button></div>
    <div class="field"><label class="label" for="sync-code">Se a outra pessoa já criou: digite o código que ela recebeu</label><div class="toolbar"><input type="text" class="grow" id="sync-code" maxlength="12" autocomplete="off" autocapitalize="characters"><button class="btn" data-act="sync-join">Entrar com o código</button></div></div>
    <div><button class="btn small ghost" data-act="sync-logout">Sair desta conta</button></div>`;
  else body=`<div class="kv"><span>Conta</span><b>${esc(st.email||'')}</b><span>Você neste casal</span><b>${esc(N(st.person))}</b><span>Última sincronização</span><b>${st.last?new Date(st.last).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'ainda não'}</b></div>
    ${st.members<2?`<p>Código para a outra pessoa entrar: <strong style="letter-spacing:.12em">${esc(st.code||'')}</strong></p><p class="sub">Ela entra com a conta Google dela neste mesmo app e digita esse código.</p>`:''}
    <div class="toolbar"><button class="btn" data-act="sync-now">Sincronizar agora</button><button class="btn ghost" data-act="sync-logout">Sair</button></div>
    ${vaultBlock()}`;
  const pill=info.state==='ok'?'<span class="pill ok">Em dia</span>':info.state==='sincronizando'?'<span class="pill">Sincronizando</span>':info.state==='erro'?'<span class="pill crit">Com erro</span>':'';
  return `<section class="card"><div class="head"><h2>Sincronização</h2>${connected()?pill:''}</div>${body}${info.msg?`<p class="err">${esc(info.msg)}</p>`:''}</section>`;
}
const errText=e=>{const m=String(e&&e.message||e);return /codigo_invalido/.test(m)?'Código não encontrado. Confira as letras e os números.':/casal_completo/.test(m)?'Esse espaço já tem duas pessoas.':'Não deu certo ('+m.slice(0,120)+').'};
document.addEventListener('click',async ev=>{
  const t=ev.target.closest('[data-act^="sync-"]');if(!t||!ON) return;
  const a=t.dataset.act;
  try{
    if(a==='sync-login'||a==='sync-switch'){if(a==='sync-switch'){await sb.auth.signOut();session=null}const {error}=await sb.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+location.pathname,queryParams:{prompt:'select_account'}}});if(error) throw error}
    if(a==='sync-create'){const p=(document.querySelector('input[name="sync-person"]:checked')||{}).value||S.me;const r=await sb.rpc('create_household',{p_person:p});if(r.error) throw r.error;setMember(r.data);info={state:'ok',msg:''};render();syncNow(true)}
    if(a==='sync-join'){const code=(document.getElementById('sync-code').value||'').trim();if(!code){toast('Digite o código.');return}const r=await sb.rpc('join_household',{p_code:code});if(r.error) throw r.error;setMember(r.data);info={state:'ok',msg:''};render();syncNow(true)}
    if(a==='sync-now'){if(busy){toast('Já está sincronizando.');return}await syncNow(true);toast(info.state==='ok'?'Tudo sincronizado.':info.msg||'Não deu para sincronizar agora.')}
    if(a==='sync-vault-create'){const p1=document.getElementById('vault-p1').value,p2=document.getElementById('vault-p2').value;if(p1.length<8){toast('A senha do cofre precisa de pelo menos 8 caracteres.');return}if(p1!==p2){toast('As duas senhas digitadas são diferentes.');return}if(S.vault){toast('O cofre já tem senha.');render();return}await vaultCreate(p1);info={...info,msg:''};render();toast('Cofre criado. Os arquivos começam a subir.');syncNow(false)}
    if(a==='sync-vault-open'){const p1=document.getElementById('vault-p1').value;try{await vaultOpen(p1)}catch(e){if(/senha_errada/.test(String(e&&e.message))){toast('Senha do cofre incorreta.');return}throw e}render();toast('Cofre aberto neste aparelho.');syncNow(false)}
    if(a==='sync-logout'){vkey=null;await sb.auth.signOut();session=null;info={state:'saindo',msg:''};render()}
  }catch(e){info={...info,msg:errText(e)};render()}
});

/* ---------- ligação com o app ---------- */
window.syncCard=card;
window.syncBadge=badge;
window.syncConnected=connected;
window.syncPerson=()=>connected()?st.person:null;
window.syncForget=forget;
window.onLocalSave=()=>{if(connected()) schedule(1200)};
if(ON){
  sb=window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'pkce'}});
  sb.auth.onAuthStateChange((ev,s)=>{
    const was=session&&session.user.id;session=s;
    if(s&&s.user.id!==was) setTimeout(afterLogin,0);        // nunca chamar o Supabase de dentro deste aviso
    if(!s&&was){info={state:'saindo',msg:''};setTimeout(refresh,0)}
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden) schedule(300)});
  window.addEventListener('online',()=>schedule(300));
  window.addEventListener('focus',()=>schedule(600));
  setInterval(()=>{if(!document.hidden) syncNow(false)},25000);
  // depois do login o Google devolve o endereço com um código: limpa o endereço
  setTimeout(()=>{try{if(/[?&](code|error)=/.test(location.search)) history.replaceState(null,'',location.pathname+location.hash)}catch(e){}},4000);
}
if(typeof render==='function') render();
})();
