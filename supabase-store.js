/* JD Supabase Store
   Přihlášení e-mailem a heslem + data z vaší databáze.
   Stránkám podstrčí stejné rozhraní jako databáze v Claude (claude.use('db')),
   takže kód aplikací zůstává beze změny.
   Volá REST API Supabase přímo, bez knihovny. */
(function(){
  const URL_  = 'https://ofrrwtdhpnmlhcbslojn.supabase.co';
  const KEY   = 'sb_publishable_3VCKenro9aQJYUsA5SIiww_s-JVWy2U';
  const POLL  = 20000;                       // jak často se ptát na nová data
  const LS    = 'jd.sb.session';
  const TABLE = {invoices:'invoices', suppliers:'suppliers', people:'people', shifts:'shifts',
                 prefs:'prefs', requests:'requests', decisions:'decisions', documents:'documents',
                 contacts:'contacts', modules:'modules', analyses:'analyses',
                 positions:'positions', staff:'staff', staff_private:'staff_private'};
  const ROLE_NAME = {majitel:'Majitel', gm:'Generální manažer', manazer:'Manažer', zamestnanec:'Zaměstnanec'};

  const ls={get(k){try{return JSON.parse(localStorage.getItem(k))}catch(_){return null}},
            set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(_){}},
            del(k){try{localStorage.removeItem(k)}catch(_){}}};
  let ses = ls.get(LS);                       // {access_token, refresh_token, expires_at, user}
  let ready = null, resolveReady;
  const waitReady = new Promise(r=>{resolveReady=r});

  const role = () => (ses && ses.user && ses.user.app_metadata && ses.user.app_metadata.jd_role) || 'none';
  const email = () => (ses && ses.user && ses.user.email) || '';

  async function api(path, opt){
    opt = opt || {};
    const h = {apikey:KEY, 'Content-Type':'application/json', ...(opt.headers||{})};
    if (ses && ses.access_token) h.Authorization = 'Bearer ' + ses.access_token;
    const res = await fetch(URL_ + path, {...opt, headers:h});
    if (res.status === 401 && ses && ses.refresh_token && !opt._retried){
      if (await refresh()) return api(path, {...opt, _retried:true});
    }
    if (!res.ok){
      let msg = res.status + '';
      try{const j = await res.json(); msg = j.message || j.error_description || j.hint || msg}catch(_){}
      const e = new Error(msg); e.status = res.status; throw e;
    }
    if (res.status === 204) return null;
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }
  async function login(mail, pass){
    const r = await fetch(URL_ + '/auth/v1/token?grant_type=password', {
      method:'POST', headers:{apikey:KEY,'Content-Type':'application/json'},
      body: JSON.stringify({email:mail, password:pass})});
    const j = await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(j.error_description || j.msg || j.message || 'Přihlášení se nepovedlo');
    ses = {...j, expires_at: Date.now() + (j.expires_in||3600)*1000};
    ls.set(LS, ses); return true;
  }
  async function refresh(){
    if (!ses || !ses.refresh_token) return false;
    try{
      const r = await fetch(URL_ + '/auth/v1/token?grant_type=refresh_token', {
        method:'POST', headers:{apikey:KEY,'Content-Type':'application/json'},
        body: JSON.stringify({refresh_token: ses.refresh_token})});
      if (!r.ok) throw 0;
      const j = await r.json();
      ses = {...j, expires_at: Date.now() + (j.expires_in||3600)*1000};
      ls.set(LS, ses); return true;
    }catch(_){ ses=null; ls.del(LS); paint(); return false }
  }
  function logout(){ ses=null; ls.del(LS); location.reload() }

  // ---------- rozhraní stejné jako claude.use('db') ----------
  const subs = [];   // {table, filter, cb, last}
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
          const r=Math.random()*16|0; return (c==='x'?r:(r&3|8)).toString(16)}));
  const tbl = n => TABLE[n] || n;
  const q = v => encodeURIComponent(v);

  async function readAll(table, filter){
    let path = '/rest/v1/' + table + '?select=*';
    if (filter) path += '&' + filter.col + '=eq.' + q(filter.val);
    const data = await api(path);
    return (data||[]).map(d => ({id:String(d.id), exists:true, data:()=>{const {id,...r}=d; return r}}));
  }
  async function pump(s){
    try{
      const docs = await readAll(s.table, s.filter);
      const sig = JSON.stringify(docs.map(d=>[d.id, d.data()]));
      if (sig !== s.last){ s.last = sig; s.cb({docs, size:docs.length, empty:!docs.length}) }
      s.err = 0;
    }catch(e){ if (s.onErr) s.onErr(e) }
  }
  function watch(table, filter, cb, onErr){
    const s = {table, filter, cb, onErr, last:null};
    subs.push(s);
    waitReady.then(()=>pump(s));
    return ()=>{const i=subs.indexOf(s); if(i>=0) subs.splice(i,1)};
  }
  setInterval(()=>{ if (ses && document.visibilityState==='visible') subs.forEach(pump) }, POLL);
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') subs.forEach(pump) });

  // Aplikace posílá prázdné políčko jako prázdný text. Postgres ho do sloupce
  // s datem nepřijme a celý zápis odmítne, proto ho tady měníme na null.
  // Nový modul si sem dopíše svoje sloupce s datem.
  const DATE_COLS = ['issued','due','paid_at','created_at','updated_at','date','datum',
                     'work_date','start_at','end_at','date_from','date_to','decided_at'];
  const forDb = v => { const o = {...v}; for (const k of DATE_COLS) if (o[k] === '') o[k] = null; return o };

  function docRef(table, id){
    return {
      id,
      async set(v){
        const body = {...forDb(v), id};
        await api('/rest/v1/' + table + '?on_conflict=id', {method:'POST',
          headers:{Prefer:'resolution=merge-duplicates,return=minimal'}, body: JSON.stringify(body)});
        subs.filter(s=>s.table===table).forEach(pump);
      },
      async update(v){
        await api('/rest/v1/' + table + '?id=eq.' + q(id), {method:'PATCH',
          headers:{Prefer:'return=minimal'}, body: JSON.stringify(forDb(v))});
        subs.filter(s=>s.table===table).forEach(pump);
      },
      async delete(){
        await api('/rest/v1/' + table + '?id=eq.' + q(id), {method:'DELETE',
          headers:{Prefer:'return=minimal'}});
        subs.filter(s=>s.table===table).forEach(pump);
      }
    };
  }
  function collection(name){
    const table = tbl(name);
    return {
      doc: id => docRef(table, id || uuid()),
      async add(v){ const r = docRef(table, uuid()); await r.set(v); return r },
      onSnapshot: (cb, onErr) => watch(table, null, cb, onErr),
      where(col, op, val){
        return {onSnapshot:(cb,onErr)=>watch(table, {col, val}, cb, onErr)};
      }
    };
  }
  // db.doc('config/faktury') → řádek v tabulce settings s key = 'faktury'
  function doc(path){
    const parts = String(path).split('/');
    if (parts[0] === 'config'){
      const key = parts[1];
      return {
        async set(v){ await api('/rest/v1/settings?on_conflict=key', {method:'POST',
            headers:{Prefer:'resolution=merge-duplicates,return=minimal'},
            body: JSON.stringify({key, value:v})});
          subs.filter(s=>s.table==='settings').forEach(pump) },
        onSnapshot(cb){ return watch('settings', {col:'key', val:key},
            s=>{const d=s.docs[0]; cb({exists:!!d, data:()=> d ? d.data().value : null})}) }
      };
    }
    const id = parts.pop(), table = tbl(parts.join('_')||'settings');
    return docRef(table, id);
  }

  const db = {collection, doc};
  const user = {
    async me(){ return {id: ses && ses.user && ses.user.id, name: email().split('@')[0], email: email()} },
    async id(){ return ses && ses.user && ses.user.id },
    isOwner(){ return role()==='majitel' },
    canEdit(){ return role()==='majitel' || role()==='gm' },
    can(what){ return what==='data.write' ? role()!=='none' : null }
  };
  window.claude = {use: async n => !ses ? null : n==='db' ? db : n==='user' ? user : null};
  // Přílohy leží v neveřejném prostoru, takže se k nim nedá dostat pouhou adresou.
  // Tahle funkce si vyžádá dočasný odkaz, který za hodinu přestane platit.
  async function odkazNaSoubor(bucket, cesta, vteriny){
    if (!cesta) return '';
    if (/^https?:\/\//i.test(cesta)) return cesta;        // starší záznamy s plnou adresou
    const o = await api('/storage/v1/object/sign/' + bucket + '/' + encodeURI(cesta),
                        {method:'POST', body: JSON.stringify({expiresIn: vteriny || 3600})});
    return o && o.signedURL ? URL_ + '/storage/v1' + o.signedURL : '';
  }

  window.JD = {get role(){return role()}, get roleName(){return ROLE_NAME[role()]||'bez role'},
               get email(){return email()}, get uid(){return (ses&&ses.user&&ses.user.id)||''},
               odkazNaSoubor, logout, refresh: ()=>subs.forEach(pump)};

  // ---------- přihlašovací obrazovka ----------
  const css = document.createElement('style');
  css.textContent = `
  #jdLogin{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
    padding:24px;background:#17120f;color:#e9e3dd;font:400 15px/1.5 system-ui,sans-serif}
  #jdLogin .box{width:100%;max-width:360px}
  #jdLogin h1{font-size:19px;margin:0 0 4px;display:flex;align-items:center;gap:9px}
  #jdLogin h1 i{width:9px;height:9px;border-radius:50%;background:#c8102e}
  #jdLogin p{color:#9b918a;font-size:13px;margin:0 0 20px}
  #jdLogin label{display:block;font-size:12px;color:#9b918a;margin:0 0 3px}
  #jdLogin input{width:100%;min-height:42px;padding:8px 11px;margin-bottom:12px;border:1px solid #352b26;
    border-radius:8px;background:#221b17;color:#fff;font:400 15px system-ui,sans-serif}
  #jdLogin button{width:100%;min-height:44px;border:0;border-radius:8px;background:#c8102e;color:#fff;
    font:600 15px system-ui,sans-serif;cursor:pointer}
  #jdLogin button:disabled{opacity:.6;cursor:not-allowed}
  #jdLogin .e{color:#ff8a97;font-size:13px;min-height:18px;margin-top:10px}
  #jdBar{position:fixed;right:12px;bottom:12px;z-index:9999;display:flex;gap:8px;align-items:center;
    padding:7px 10px;border-radius:999px;background:rgba(23,18,15,.92);color:#e9e3dd;
    font:500 12px system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.25)}
  #jdBar button{border:0;background:none;color:#ff8a97;font:600 12px system-ui,sans-serif;cursor:pointer;padding:0}
  `;
  document.head.appendChild(css);

  function paint(){
    const old = document.getElementById('jdLogin'); if (old) old.remove();
    const bar = document.getElementById('jdBar'); if (bar) bar.remove();
    if (!ses){
      const w = document.createElement('div'); w.id='jdLogin';
      w.innerHTML = `<div class="box">
        <h1><i></i>James Dean</h1>
        <p>Přihlaste se firemním e-mailem.</p>
        <label for="jdE">E-mail</label><input id="jdE" type="email" autocomplete="username">
        <label for="jdP">Heslo</label><input id="jdP" type="password" autocomplete="current-password">
        <button id="jdGo" type="button">Přihlásit</button>
        <div class="e" id="jdErr"></div></div>`;
      document.body.appendChild(w);
      const go = async () => {
        const b = w.querySelector('#jdGo'), e = w.querySelector('#jdErr');
        b.disabled = true; e.textContent = '';
        try{ await login(w.querySelector('#jdE').value.trim(), w.querySelector('#jdP').value);
          if (role() === 'none'){ e.textContent = 'Účet nemá přidělenou roli. Ozvěte se správci.'; ses=null; ls.del(LS); b.disabled=false; return }
          // Stránka se načte znovu, aby se aplikace rozběhla už s přihlášením.
          location.reload();
        }catch(err){ e.textContent = err.message === 'Invalid login credentials' ? 'Špatný e-mail nebo heslo.' : err.message; b.disabled = false }
      };
      w.querySelector('#jdGo').onclick = go;
      w.querySelector('#jdP').onkeydown = ev => { if (ev.key === 'Enter') go() };
      w.querySelector('#jdE').focus();
    } else {
      const b = document.createElement('div'); b.id='jdBar';
      b.innerHTML = `<span>${email()} · ${ROLE_NAME[role()]||'bez role'}</span>`;
      const out = document.createElement('button'); out.type='button'; out.textContent='Odhlásit'; out.onclick=logout;
      b.appendChild(out); document.body.appendChild(b);
    }
  }
  function start(){
    paint();
    if (ses){
      if (ses.expires_at && ses.expires_at < Date.now() + 60000) refresh().then(()=>{resolveReady(); subs.forEach(pump)});
      else { resolveReady(); subs.forEach(pump) }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
