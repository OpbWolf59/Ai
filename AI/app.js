(function(){
  // ---------------- state ----------------
  const $ = (id) => document.getElementById(id);
  const PROVIDERS = {
    openai:    { label:'OPENAI',    defaultModel:'gpt-5.6-luna' },
    anthropic: { label:'CLAUDE',    defaultModel:'claude-sonnet-5' },
    xai:       { label:'GROK',      defaultModel:'grok-4.6' },
    gemini:    { label:'GEMINI',    defaultModel:'gemini-3.5-flash-lite' }
  };
  const state = {
    power: false,        // whole system armed/disarmed
    mode: 'off',         // off | armed | listening | processing | speaking | manual
    provider: 'gemini',
    apiKeys: { openai:'', anthropic:'', xai:'', gemini:'' },
    models: {
      openai: 'gpt-5.6-luna',
      anthropic: 'claude-sonnet-5',
      xai: 'grok-4.6',
      gemini: 'gemini-3.5-flash-lite'
    },
    sysPrompt: '',
    wakeWords: ['jarvis'],
    autoRearm: true,
    preferGoogleVoice: true,
    voiceNames: { openai:'__auto__', anthropic:'__auto__', xai:'__auto__', gemini:'__auto__' },
  };


  // ---------------- API key file ----------------
  // api-keys.js is loaded before app.js. File-based keys become the baseline,
  // while Settings can still override them for the current browser tab/session.
  function loadFileApiKeys(){
    try{
      const fileKeys = window.ARC_API_KEYS;
      if(!fileKeys || typeof fileKeys !== 'object') return;
      Object.keys(state.apiKeys).forEach((provider) => {
        const value = fileKeys[provider];
        if(typeof value === 'string' && value.trim()) state.apiKeys[provider] = value.trim();
      });
    }catch(_){ }
  }
  loadFileApiKeys();

  // ---------------- tab-session settings ----------------
  // sessionStorage survives reloads in this tab but is cleared when the tab/session ends.
  // Session values intentionally override api-keys.js so a temporary Settings edit works.
  const SESSION_KEY = 'arc-static-session-v1';
  function loadSessionSettings(){
    try{
      const saved=JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if(!saved || typeof saved!=='object') return;
      if(saved.provider in PROVIDERS) state.provider=saved.provider;
      if(saved.apiKeys && typeof saved.apiKeys==='object') Object.keys(state.apiKeys).forEach(k=>{ if(typeof saved.apiKeys[k]==='string') state.apiKeys[k]=saved.apiKeys[k]; });
      if(saved.models && typeof saved.models==='object') Object.keys(state.models).forEach(k=>{ if(typeof saved.models[k]==='string' && saved.models[k]) state.models[k]=saved.models[k]; });
      if(typeof saved.sysPrompt==='string') state.sysPrompt=saved.sysPrompt;
      if(Array.isArray(saved.wakeWords) && saved.wakeWords.length) state.wakeWords=saved.wakeWords.map(String);
      if(typeof saved.autoRearm==='boolean') state.autoRearm=saved.autoRearm;
      if(typeof saved.preferGoogleVoice==='boolean') state.preferGoogleVoice=saved.preferGoogleVoice;
      if(saved.voiceNames && typeof saved.voiceNames==='object') Object.keys(state.voiceNames).forEach(k=>{ if(typeof saved.voiceNames[k]==='string') state.voiceNames[k]=saved.voiceNames[k]; });
    }catch(_){ }
  }
  function saveSessionSettings(){
    try{
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        provider:state.provider,
        apiKeys:state.apiKeys,
        models:state.models,
        sysPrompt:state.sysPrompt,
        wakeWords:state.wakeWords,
        autoRearm:state.autoRearm,
        preferGoogleVoice:state.preferGoogleVoice,
        voiceNames:state.voiceNames
      }));
    }catch(_){ }
  }
  loadSessionSettings();

  const statusWord = $('statusWord');
  const liveLine = $('liveLine');
  const hintLine = $('hintLine');
  const statusDot = $('statusDot');
  const powerBtn = $('powerBtn');
  const talkBtn = $('talkBtn');
  const logEl = $('log');
  const panel = $('panel');
  const providerBadge = $('providerBadge');
  const toolsBtn = $('toolsBtn');
  const toolsDrawer = $('toolsDrawer');
  const toolsOverlay = $('toolsOverlay');

  // Last full AI reply can be explicitly saved to an authorized workspace.
  let lastAssistantReply = '';

  function setMode(mode, hint){
    state.mode = mode;
    statusWord.className = 'status-word display ' + (mode === 'off' ? 'off' : mode === 'processing' ? 'processing' : mode === 'speaking' ? 'speaking' : mode === 'error' ? 'error' : '');
    const labels = { off:'OFFLINE', armed:'STANDBY — LISTENING FOR WAKE WORD', listening:'LISTENING', processing:'PROCESSING', speaking:'SPEAKING', manual:'STANDBY — MANUAL INPUT', error:'ERROR' };
    statusWord.textContent = labels[mode] || mode.toUpperCase();
    if (hint !== undefined) hintLine.textContent = hint;
    statusDot.style.background = mode === 'off' ? '#3c515a' : mode === 'processing' ? 'var(--violet)' : mode === 'speaking' ? 'var(--amber)' : mode === 'error' ? 'var(--red)' : 'var(--cyan)';
    statusDot.style.boxShadow = mode === 'off' ? 'none' : `0 0 8px currentColor`;
    statusDot.style.color = statusDot.style.background;
  }

  function logEntry(who, text){
    const div = document.createElement('div');
    div.className = 'entry ' + who;
    const whoLabel = who === 'user' ? 'YOU' : who === 'assistant' ? 'ARC' : 'SYSTEM';
    div.innerHTML = `<div class="who">${whoLabel}</div><div class="body"></div>`;
    div.querySelector('.body').textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ---------------- clock ----------------
  function tickClock(){
    const d = new Date();
    $('clock').textContent = d.toLocaleTimeString([], {hour12:false});
  }
  setInterval(tickClock, 1000); tickClock();

  // ---------------- machine-aware HUD / browser-safe local tools ----------------
  const systemInfo = {
    device:'PC', platform:'--', browser:'--', cpu:'--', memory:'--', screen:'--',
    network:'--', battery:'--', storage:'--', fps:'--', mic:'IDLE', workspace:'NONE'
  };

  function setText(id, value){ const el=$(id); if(el) el.textContent=String(value ?? '--'); }
  function fmtBytes(bytes){
    if(!Number.isFinite(bytes) || bytes < 0) return '--';
    const units=['B','KB','MB','GB','TB']; let i=0, n=bytes;
    while(n>=1024 && i<units.length-1){n/=1024;i++;}
    return `${n>=10 || i===0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
  }
  function browserLabel(){
    const ua=navigator.userAgent || '';
    const edge=ua.match(/Edg\/([\d.]+)/); if(edge) return 'EDGE '+edge[1].split('.')[0];
    const chrome=ua.match(/Chrome\/([\d.]+)/); if(chrome) return 'CHROME '+chrome[1].split('.')[0];
    const firefox=ua.match(/Firefox\/([\d.]+)/); if(firefox) return 'FIREFOX '+firefox[1].split('.')[0];
    const safari=ua.match(/Version\/([\d.]+).*Safari/); if(safari) return 'SAFARI '+safari[1].split('.')[0];
    return 'BROWSER';
  }
  function platformLabel(){
    const p=navigator.userAgentData?.platform || navigator.platform || 'UNKNOWN';
    if(/win/i.test(p)) return 'WINDOWS';
    if(/mac/i.test(p)) return 'MACOS';
    if(/linux/i.test(p)) return 'LINUX';
    if(/android/i.test(p)) return 'ANDROID';
    return String(p).toUpperCase().slice(0,18);
  }
  function refreshSystemHud(){
    const map={
      hudDevice:systemInfo.device,hudPlatform:systemInfo.platform,hudCpu:systemInfo.cpu,hudMem:systemInfo.memory,
      hudScreen:systemInfo.screen,hudBrowser:systemInfo.browser,hudNet:systemInfo.network,hudBattery:systemInfo.battery,
      hudStorage:systemInfo.storage,hudFps:systemInfo.fps,hudMic:systemInfo.mic,hudWorkspace:systemInfo.workspace,
      hudNodeCompact:systemInfo.device,hudCpuCompact:systemInfo.cpu,hudNetCompact:systemInfo.network,hudFpsCompact:systemInfo.fps,
      toolDevice:systemInfo.device,toolCpu:systemInfo.cpu,toolMem:systemInfo.memory,toolScreen:systemInfo.screen,
      toolNet:systemInfo.network,toolBattery:systemInfo.battery,toolStorage:systemInfo.storage,toolFps:systemInfo.fps
    };
    Object.entries(map).forEach(([id,v])=>setText(id,v));
  }
  function refreshNetworkInfo(){
    const c=navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if(!navigator.onLine){ systemInfo.network='OFFLINE'; }
    else if(c){
      const type=(c.effectiveType || c.type || 'ONLINE').toString().toUpperCase();
      const speed=Number.isFinite(c.downlink) ? ` ${c.downlink}M` : '';
      systemInfo.network=type+speed;
    }else systemInfo.network='ONLINE';
    refreshSystemHud();
  }
  async function refreshStorageInfo(){
    try{
      if(navigator.storage?.estimate){
        const e=await navigator.storage.estimate();
        systemInfo.storage=(Number.isFinite(e.usage)&&Number.isFinite(e.quota)) ? `${fmtBytes(e.usage)}/${fmtBytes(e.quota)}` : 'AVAILABLE';
      }else systemInfo.storage='N/A';
    }catch(_){systemInfo.storage='N/A'}
    refreshSystemHud();
  }
  let batteryManager=null;
  function updateBatteryInfo(){
    if(!batteryManager){systemInfo.battery='N/A';refreshSystemHud();return;}
    const pct=Math.round((batteryManager.level || 0)*100);
    systemInfo.battery=`${pct}%${batteryManager.charging?' ⚡':''}`;
    // Battery presence is only a heuristic; browsers do not expose a reliable laptop/desktop flag.
    if(!batteryManager.charging || pct<100) systemInfo.device='LAPTOP*';
    refreshSystemHud();
  }
  async function initBatteryInfo(){
    try{
      if(typeof navigator.getBattery==='function'){
        batteryManager=await navigator.getBattery();
        ['levelchange','chargingchange'].forEach(ev=>batteryManager.addEventListener(ev,updateBatteryInfo));
        updateBatteryInfo();
      }else systemInfo.battery='N/A';
    }catch(_){systemInfo.battery='N/A'}
  }
  function initSystemInfo(){
    systemInfo.platform=platformLabel();
    systemInfo.browser=browserLabel();
    systemInfo.cpu=navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency}T` : 'N/A';
    systemInfo.memory=navigator.deviceMemory ? `~${navigator.deviceMemory} GB` : 'N/A';
    systemInfo.screen=`${screen.width}×${screen.height} @${(window.devicePixelRatio||1).toFixed(1)}x`;
    if(/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent||'')) systemInfo.device='MOBILE';
    else systemInfo.device='PC';
    refreshNetworkInfo(); refreshStorageInfo(); initBatteryInfo(); refreshSystemHud();
  }
  window.addEventListener('online',refreshNetworkInfo);
  window.addEventListener('offline',refreshNetworkInfo);
  const netConn=navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if(netConn?.addEventListener) netConn.addEventListener('change',refreshNetworkInfo);
  window.addEventListener('resize',()=>{
    systemInfo.screen=`${screen.width}×${screen.height} @${(window.devicePixelRatio||1).toFixed(1)}x`;
    refreshSystemHud();
  });
  initSystemInfo();

  let fpsFrames=0,fpsLast=performance.now();
  function fpsProbe(now){
    fpsFrames++;
    if(now-fpsLast>=1000){
      systemInfo.fps=`${Math.round(fpsFrames*1000/(now-fpsLast))}`;
      fpsFrames=0;fpsLast=now;refreshSystemHud();
    }
    requestAnimationFrame(fpsProbe);
  }
  requestAnimationFrame(fpsProbe);

  // ----- authorized local workspace -----
  const WORKSPACE_DB='arc-local-tools-v1', WORKSPACE_STORE='handles', WORKSPACE_KEY='workspace';
  let workspaceHandle=null;
  function openWorkspaceDB(){
    return new Promise((resolve,reject)=>{
      if(!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const req=indexedDB.open(WORKSPACE_DB,1);
      req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains(WORKSPACE_STORE)) req.result.createObjectStore(WORKSPACE_STORE); };
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
  }
  async function dbPutHandle(handle){
    try{const db=await openWorkspaceDB();await new Promise((res,rej)=>{const tx=db.transaction(WORKSPACE_STORE,'readwrite');tx.objectStore(WORKSPACE_STORE).put(handle,WORKSPACE_KEY);tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});db.close();}catch(_){}
  }
  async function dbGetHandle(){
    try{const db=await openWorkspaceDB();const h=await new Promise((res,rej)=>{const tx=db.transaction(WORKSPACE_STORE,'readonly');const r=tx.objectStore(WORKSPACE_STORE).get(WORKSPACE_KEY);r.onsuccess=()=>res(r.result||null);r.onerror=()=>rej(r.error)});db.close();return h;}catch(_){return null}
  }
  async function workspacePermission(handle=workspaceHandle, request=false){
    if(!handle) return false;
    const opts={mode:'readwrite'};
    try{if(await handle.queryPermission?.(opts)==='granted') return true;}catch(_){}
    if(request){try{return (await handle.requestPermission?.(opts))==='granted';}catch(_){}}
    return false;
  }
  function updateWorkspaceStatus(permission='LOCKED'){
    const name=workspaceHandle?.name || 'NO FOLDER CONNECTED';
    systemInfo.workspace=workspaceHandle ? name.toUpperCase().slice(0,14) : 'NONE';
    setText('workspaceName',name);setText('workspacePermission',permission);refreshSystemHud();
  }
  async function restoreWorkspace(){
    workspaceHandle=await dbGetHandle();
    if(!workspaceHandle){updateWorkspaceStatus('LOCKED');return;}
    const granted=await workspacePermission(workspaceHandle,false);
    updateWorkspaceStatus(granted?'READY':'RECONNECT');
    if(granted) await refreshWorkspaceFiles();
  }
  async function connectWorkspace(){
    try{
      if(workspaceHandle && await workspacePermission(workspaceHandle,true)){
        updateWorkspaceStatus('READY');await refreshWorkspaceFiles();return true;
      }
      if(typeof window.showDirectoryPicker!=='function') throw new Error('Folder access requires a Chromium browser with the File System Access API.');
      const picked=await window.showDirectoryPicker({mode:'readwrite'});
      workspaceHandle=picked;await dbPutHandle(picked);updateWorkspaceStatus('READY');await refreshWorkspaceFiles();return true;
    }catch(err){
      if(err?.name!=='AbortError') logEntry('system','Workspace access: '+(err.message||err));
      updateWorkspaceStatus(workspaceHandle?'RECONNECT':'LOCKED');return false;
    }
  }
  function safeEntryName(value){
    const name=String(value||'').trim();
    if(!name || name==='.' || name==='..' || /[\\/]/.test(name)) throw new Error('Use a single file/folder name without / or \\.');
    return name;
  }
  async function requireWorkspace(){
    if(!workspaceHandle) throw new Error('No workspace folder is connected. Open System Tools and connect one first.');
    if(!await workspacePermission(workspaceHandle,false)) throw new Error('Workspace permission needs reconnecting. Open System Tools and click CONNECT / RECONNECT FOLDER.');
    return workspaceHandle;
  }
  async function listWorkspaceEntries(){
    const dir=await requireWorkspace();const rows=[];
    for await(const [name,handle] of dir.entries()){
      let size='';
      if(handle.kind==='file'){try{const f=await handle.getFile();size=fmtBytes(f.size)}catch(_){}}
      rows.push({name,kind:handle.kind,size});
      if(rows.length>=250) break;
    }
    rows.sort((a,b)=>(a.kind===b.kind?a.name.localeCompare(b.name):(a.kind==='directory'?-1:1)));
    return rows;
  }
  async function refreshWorkspaceFiles(){
    const box=$('workspaceFiles');if(!box)return;
    try{
      const rows=await listWorkspaceEntries();box.innerHTML='';
      if(!rows.length){box.innerHTML='<div class="empty-state">Folder is empty.</div>';return;}
      rows.forEach(row=>{
        const el=document.createElement('div');el.className='workspace-file-row';
        el.innerHTML='<span class="kind"></span><span class="name"></span><span class="size"></span>';
        el.querySelector('.kind').textContent=row.kind==='directory'?'DIR':'FILE';
        el.querySelector('.name').textContent=row.name;el.querySelector('.size').textContent=row.size;
        el.addEventListener('click',()=>{if(row.kind==='file')$('workspaceFileName').value=row.name;else $('workspaceFolderName').value=row.name;});
        box.appendChild(el);
      });
      updateWorkspaceStatus('READY');
    }catch(err){box.innerHTML='<div class="empty-state">'+String(err.message||err).replace(/[<>]/g,'')+'</div>';updateWorkspaceStatus('RECONNECT')}
  }
  async function readWorkspaceText(name){
    const dir=await requireWorkspace();name=safeEntryName(name);
    const h=await dir.getFileHandle(name);const f=await h.getFile();
    if(f.size>2*1024*1024) throw new Error('ARC text reader is limited to 2 MB per file.');
    return await f.text();
  }
  async function writeWorkspaceText(name,content){
    const dir=await requireWorkspace();name=safeEntryName(name);
    const h=await dir.getFileHandle(name,{create:true});const w=await h.createWritable();
    await w.write(String(content??''));await w.close();await refreshWorkspaceFiles();return name;
  }
  async function createWorkspaceFolder(name){const dir=await requireWorkspace();name=safeEntryName(name);await dir.getDirectoryHandle(name,{create:true});await refreshWorkspaceFiles();return name;}
  async function deleteWorkspaceEntry(name){const dir=await requireWorkspace();name=safeEntryName(name);await dir.removeEntry(name,{recursive:false});await refreshWorkspaceFiles();return name;}
  restoreWorkspace();

  // ----- app/URI launchpad -----
  const APP_SHORTCUTS={
    youtube:{url:'https://www.youtube.com/',label:'YouTube'}, gmail:{url:'https://mail.google.com/',label:'Gmail'},
    drive:{url:'https://drive.google.com/',label:'Google Drive'}, github:{url:'https://github.com/',label:'GitHub'},
    chatgpt:{url:'https://chatgpt.com/',label:'ChatGPT'}, gemini:{url:'https://gemini.google.com/',label:'Gemini'},
    claude:{url:'https://claude.ai/',label:'Claude'}, grok:{url:'https://grok.com/',label:'Grok'}, spotify:{url:'https://open.spotify.com/',label:'Spotify'},
    'windows-settings':{url:'ms-settings:',label:'Windows Settings',protocol:true},
    'mic-settings':{url:'ms-settings:privacy-microphone',label:'Microphone Settings',protocol:true},
    store:{url:'ms-windows-store://home/',label:'Microsoft Store',protocol:true}
  };
  function launchShortcut(key){
    const app=APP_SHORTCUTS[key];if(!app)return false;
    if(app.protocol){
      const a=document.createElement('a');a.href=app.url;a.style.display='none';document.body.appendChild(a);a.click();setTimeout(()=>a.remove(),1000);
    }else window.open(app.url,'_blank','noopener,noreferrer');
    logEntry('system','Launch requested: '+app.label+'.');return true;
  }
  function shortcutFromPhrase(raw){
    const s=String(raw||'').toLowerCase().trim();
    const aliases={
      'youtube':'youtube','gmail':'gmail','mail':'gmail','google drive':'drive','drive':'drive','github':'github',
      'chatgpt':'chatgpt','chat gpt':'chatgpt','gemini':'gemini','claude':'claude','grok':'grok','spotify':'spotify',
      'windows settings':'windows-settings','pc settings':'windows-settings','microphone settings':'mic-settings','mic settings':'mic-settings',
      'microsoft store':'store','ms store':'store'
    };
    return aliases[s] || null;
  }

  function systemSummary(){
    return `Local node ${systemInfo.device}; ${systemInfo.platform}; CPU ${systemInfo.cpu}; memory ${systemInfo.memory}; display ${systemInfo.screen}; network ${systemInfo.network}; battery ${systemInfo.battery}; workspace ${systemInfo.workspace}.`;
  }
  function localReply(text){
    const msg=String(text||'');lastAssistantReply=msg;logEntry('assistant','[LOCAL] '+msg);speak(msg);
  }
  function openToolsDrawer(){
    // Keep only one drawer open at a time.
    document.getElementById('overlay')?.classList.remove('open');document.getElementById('drawer')?.classList.remove('open');
    toolsOverlay?.classList.add('open');toolsDrawer?.classList.add('open');refreshSystemHud();refreshWorkspaceFiles().catch(()=>{});
  }
  function closeToolsDrawer(){toolsOverlay?.classList.remove('open');toolsDrawer?.classList.remove('open')}

  async function resolveLocalCommand(raw){
    const text=String(raw||'').trim();let m;
    if(/^(system|computer|pc|machine)\s+(status|info|information)$/i.test(text) || /^system status$/i.test(text)) return {handled:true,reply:systemSummary()};
    if(/^(open|show)\s+(system tools|tools|hud)$/i.test(text)){openToolsDrawer();return {handled:true,reply:'System tools opened.'};}
    if(/^(connect|grant|select)\s+(a\s+)?(folder|workspace)$/i.test(text)){
      openToolsDrawer();return {handled:true,reply:'Open System Tools and click Connect Folder. The browser requires a click before it can show the folder permission picker.'};
    }
    m=text.match(/^open\s+(.+)$/i);
    if(m){const key=shortcutFromPhrase(m[1]);if(key){launchShortcut(key);return {handled:true,reply:`Opening ${APP_SHORTCUTS[key].label}.`};}}
    if(/^(list|show)\s+(workspace\s+)?files$/i.test(text)){
      const rows=await listWorkspaceEntries();const names=rows.slice(0,24).map(r=>(r.kind==='directory'?'folder ':'')+r.name);
      return {handled:true,reply:names.length?`Workspace contains ${rows.length} item${rows.length===1?'':'s'}: ${names.join(', ')}${rows.length>24?', and more.':'.'}`:'The workspace folder is empty.'};
    }
    m=text.match(/^read\s+file\s+(.+)$/i);
    if(m){const name=safeEntryName(m[1]);const content=await readWorkspaceText(name);$('workspaceFileName').value=name;$('workspaceFileContent').value=content;return {handled:true,reply:`I read ${name} and placed its text in System Tools.`};}
    m=text.match(/^create\s+folder\s+(.+)$/i);
    if(m){const name=await createWorkspaceFolder(m[1]);return {handled:true,reply:`Created folder ${name}.`};}
    m=text.match(/^create\s+file\s+(.+?)\s+(?:saying|with|containing)\s+([\s\S]+)$/i);
    if(m){const name=await writeWorkspaceText(m[1],m[2]);return {handled:true,reply:`Created ${name}.`};}
    m=text.match(/^save\s+last\s+reply\s+as\s+(.+)$/i);
    if(m){if(!lastAssistantReply) throw new Error('There is no previous ARC reply to save yet.');const name=await writeWorkspaceText(m[1],lastAssistantReply);return {handled:true,reply:`Saved my last reply as ${name}.`};}
    m=text.match(/^summari[sz]e\s+file\s+(.+)$/i);
    if(m){const name=safeEntryName(m[1]);const content=await readWorkspaceText(name);return {handled:false,prompt:`The user explicitly asked you to summarize the local text file named "${name}". Summarize only the supplied file content accurately and concisely.\n\nFILE CONTENT:\n${content.slice(0,120000)}`,note:`Loaded ${name} from the authorized workspace for summarization.`};}
    return {handled:false};
  }

  // Tool drawer UI actions are intentionally user-gesture driven for permission/destructive actions.
  toolsBtn?.addEventListener('click',openToolsDrawer);$('toolsClose')?.addEventListener('click',closeToolsDrawer);toolsOverlay?.addEventListener('click',closeToolsDrawer);
  $('workspaceConnectBtn')?.addEventListener('click',connectWorkspace);$('workspaceRefreshBtn')?.addEventListener('click',refreshWorkspaceFiles);
  $('workspaceReadBtn')?.addEventListener('click',async()=>{try{const name=$('workspaceFileName').value;const text=await readWorkspaceText(name);$('workspaceFileContent').value=text;logEntry('system',`Read ${safeEntryName(name)} from workspace.`)}catch(err){logEntry('system','Read failed: '+(err.message||err))}});
  $('workspaceSaveBtn')?.addEventListener('click',async()=>{try{const name=await writeWorkspaceText($('workspaceFileName').value,$('workspaceFileContent').value);logEntry('system',`Saved ${name}.`)}catch(err){logEntry('system','Save failed: '+(err.message||err))}});
  $('workspaceDeleteBtn')?.addEventListener('click',async()=>{try{const name=safeEntryName($('workspaceFileName').value);if(!confirm(`Delete "${name}" from the authorized workspace? This cannot be undone by ARC.`))return;await deleteWorkspaceEntry(name);$('workspaceFileContent').value='';logEntry('system',`Deleted ${name}.`)}catch(err){logEntry('system','Delete failed: '+(err.message||err))}});
  $('workspaceCreateFolderBtn')?.addEventListener('click',async()=>{try{const name=await createWorkspaceFolder($('workspaceFolderName').value);logEntry('system',`Created folder ${name}.`)}catch(err){logEntry('system','Create folder failed: '+(err.message||err))}});
  document.querySelectorAll('.app-launch').forEach(btn=>btn.addEventListener('click',()=>launchShortcut(btn.dataset.app)));
  if(systemInfo.platform!=='WINDOWS') document.querySelectorAll('.windows-only').forEach(el=>el.hidden=true);

  // ---------------- cinematic neural-schema visualization ----------------
  const canvas = $('coreCanvas');
  const ctx = canvas.getContext('2d', { alpha:true, desynchronized:true });
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resizeCanvas(){
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }
  window.addEventListener('resize', resizeCanvas);
  requestAnimationFrame(resizeCanvas);

  let level = 0;
  let targetLevel = 0;
  let t = 0;
  let clickPulse = 0;
  const pointer = { x:0, y:0, tx:0, ty:0, inside:false };
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.tx = ((e.clientX-r.left)/r.width - 0.5) * 2;
    pointer.ty = ((e.clientY-r.top)/r.height - 0.5) * 2;
    pointer.inside = true;
  });
  canvas.addEventListener('pointerleave', () => { pointer.tx = 0; pointer.ty = 0; pointer.inside = false; });
  canvas.addEventListener('click', () => { clickPulse = 1; });

  function seededRand(seed){
    const x = Math.sin(seed*12.9898 + 78.233)*43758.5453123;
    return x - Math.floor(x);
  }
  function fibSphere(n){
    const pts = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for(let i=0;i<n;i++){
      const y = 1 - (i/(Math.max(1,n-1)))*2;
      const r = Math.sqrt(Math.max(0, 1-y*y));
      const a = golden*i;
      pts.push({x:Math.cos(a)*r, y, z:Math.sin(a)*r});
    }
    return pts;
  }
  function dist3(a,b){ return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z); }
  function rotate3(p, ry, rx, rz=0){
    let x = p.x*Math.cos(ry) + p.z*Math.sin(ry);
    let z = -p.x*Math.sin(ry) + p.z*Math.cos(ry);
    let y = p.y;
    const y2 = y*Math.cos(rx) - z*Math.sin(rx);
    const z2 = y*Math.sin(rx) + z*Math.cos(rx);
    const x2 = x*Math.cos(rz) - y2*Math.sin(rz);
    const y3 = x*Math.sin(rz) + y2*Math.cos(rz);
    return {x:x2,y:y3,z:z2};
  }

  const lite = matchMedia('(max-width:760px)').matches || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
  const NODE_COUNT = lite ? 430 : 1050;
  const DUST_COUNT = lite ? 280 : 820;
  const LINK_TARGET = lite ? 360 : 1250;
  const RADIAL_COUNT = lite ? 70 : 180;

  const neuralNodes = fibSphere(NODE_COUNT).map((p,i) => {
    const clusterBias = (p.x < -0.12 || p.y > 0.28 || (p.x > 0.2 && p.y < -0.1)) ? 1.0 : 0.58;
    const radius = 0.76 + seededRand(i*4.17)*0.37;
    return {
      x:p.x*radius, y:p.y*radius, z:p.z*radius,
      size:0.45 + seededRand(i*8.1)*1.8,
      glow:seededRand(i*13.7),
      phase:seededRand(i*2.71)*Math.PI*2,
      cluster:clusterBias
    };
  });

  const neuralLinks = [];
  for(let k=0, attempts=0; neuralLinks.length<LINK_TARGET && attempts<LINK_TARGET*32; attempts++){
    const a = Math.floor(seededRand(attempts*3.77+8)*NODE_COUNT);
    const offset = 1 + Math.floor(seededRand(attempts*7.19+4)*48);
    const b = (a + offset) % NODE_COUNT;
    const d = dist3(neuralNodes[a], neuralNodes[b]);
    if(d < 0.31 && seededRand(attempts*11.3) < Math.min(neuralNodes[a].cluster,neuralNodes[b].cluster)){
      neuralLinks.push({a,b,hot:seededRand(attempts*19.9)>0.91,phase:seededRand(attempts*5.31)*9});
    }
  }

  const dust = fibSphere(DUST_COUNT).map((p,i)=>{
    const r = 0.35 + seededRand(i*9.17)*1.10;
    return {x:p.x*r,y:p.y*r,z:p.z*r,size:0.35+seededRand(i*5.9)*1.35,phase:seededRand(i*3.1)*8};
  });

  const radials = Array.from({length:RADIAL_COUNT},(_,i)=>{
    const p = fibSphere(RADIAL_COUNT)[i];
    return {
      dir:p,
      inner:0.18+seededRand(i*3.2)*0.38,
      outer:0.55+seededRand(i*7.4)*0.76,
      alpha:0.08+seededRand(i*8.8)*0.20,
      phase:seededRand(i*5.1)*Math.PI*2
    };
  });

  function palette(mode){
    if(mode==='error') return {r:255,g:72,b:30};
    if(mode==='off') return {r:122,g:54,b:12};
    if(mode==='speaking') return {r:255,g:221,b:125};
    if(mode==='processing') return {r:255,g:113,b:0};
    return {r:255,g:157,b:0};
  }

  function drawArcRing(cx,cy,rx,ry,rot,start,span,color,width=1){
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(rot);
    ctx.beginPath(); ctx.ellipse(0,0,rx,ry,0,start,start+span);
    ctx.strokeStyle=color; ctx.lineWidth=Math.max(1.35,width*1.85)*dpr; ctx.stroke(); ctx.restore();
  }

  function drawCore(){
    const w=canvas.width,h=canvas.height;
    if(!w || !h){ requestAnimationFrame(drawCore); return; }
    ctx.clearRect(0,0,w,h);
    const cx=w/2, cy=h/2;
    const baseR=Math.min(w,h)*0.315;
    const c=palette(state.mode);
    const col=(a,r=c.r,g=c.g,b=c.b)=>`rgba(${r},${g},${b},${Math.max(0,Math.min(1,a))})`;
    // Stroke-only palette: same neural geometry, but deeper/darker amber and stronger opacity.
    const lineCol=(a,r=c.r,g=c.g,b=c.b)=>`rgba(${Math.round(r*0.62)},${Math.round(g*0.58)},${Math.round(b*0.52)},${Math.max(0,Math.min(1,a*1.55))})`;

    level += (targetLevel-level)*0.11;
    pointer.x += (pointer.tx-pointer.x)*0.035;
    pointer.y += (pointer.ty-pointer.y)*0.035;
    clickPulse *= 0.94;

    const active=state.mode!=='off';
    const randomBreath=0.55+0.22*Math.sin(t*0.71)+0.12*Math.sin(t*0.29+1.9);
    let stateBoost=0.28;
    if(state.mode==='listening') stateBoost=0.48+level*0.65;
    if(state.mode==='armed') stateBoost=0.36+level*0.30;
    if(state.mode==='processing') stateBoost=0.88+0.12*Math.sin(t*5.7);
    if(state.mode==='speaking') stateBoost=0.70+0.30*Math.abs(Math.sin(t*5.3))*Math.max(0.25,level);
    if(state.mode==='off') stateBoost=0.12;
    const energy=Math.min(1.25,(active?randomBreath:0.22)*stateBoost + clickPulse*0.65);

    // Deep black containment volume; not a solid sphere.
    const shell=ctx.createRadialGradient(cx,cy,0,cx,cy,baseR*1.55);
    shell.addColorStop(0,'rgba(42,16,0,0.13)');
    shell.addColorStop(0.55,'rgba(19,8,0,0.08)');
    shell.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=shell; ctx.fillRect(cx-baseR*1.6,cy-baseR*1.6,baseR*3.2,baseR*3.2);

    const ry=t*0.052 + pointer.x*0.18;
    const rx=0.18 + Math.sin(t*0.13)*0.07 - pointer.y*0.13;
    const rz=Math.sin(t*0.09)*0.025;
    const focal=3.15;
    function project(p,scaleR=1){
      const q=rotate3(p,ry,rx,rz);
      const perspective=focal/(focal+q.z);
      return {x:cx+q.x*baseR*scaleR*perspective,y:cy+q.y*baseR*scaleR*perspective,z:q.z,s:perspective};
    }

    // Subtle outer containment arcs and scanning segments.
    for(let i=0;i<9;i++){
      const a0=seededRand(i*7.1)*Math.PI*2 + t*(i%2?0.020:-0.014);
      const span=0.25+seededRand(i*4.3)*0.85;
      drawArcRing(cx,cy,baseR*(1.34+i*0.018),baseR*(1.30+i*0.012),pointer.x*0.025,a0,span,lineCol(0.035+energy*0.07),0.7);
    }

    // Asymmetric thin radial data structures / neural dendrites.
    radials.forEach((r,i)=>{
      const flick=0.35+0.65*Math.max(0,Math.sin(t*(0.7+seededRand(i)*1.7)+r.phase));
      if(flick<0.19) return;
      const p1=project({x:r.dir.x*r.inner,y:r.dir.y*r.inner,z:r.dir.z*r.inner});
      const wob=1+0.035*Math.sin(t*1.1+r.phase);
      const p2=project({x:r.dir.x*r.outer*wob,y:r.dir.y*r.outer*wob,z:r.dir.z*r.outer*wob});
      const depth=(p2.z+1.4)/2.8;
      ctx.beginPath(); ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y);
      ctx.strokeStyle=lineCol(r.alpha*flick*(0.38+depth)*(0.55+energy));
      ctx.lineWidth=1.05*dpr; ctx.stroke();
      if(i%13===0){
        ctx.fillStyle=col(0.22*flick*(0.5+energy));
        ctx.fillRect(p2.x-0.6*dpr,p2.y-0.6*dpr,1.2*dpr,1.2*dpr);
      }
    });

    // Network connections, depth-sorted by endpoint midpoint.
    const projected=neuralNodes.map(project);
    neuralLinks.forEach((ln,i)=>{
      const a=projected[ln.a], b=projected[ln.b];
      const depth=((a.z+b.z)*0.5+1.4)/2.8;
      const pulse=Math.max(0,Math.sin(t*(state.mode==='processing'?5.5:1.6)+ln.phase+i*0.011));
      const baseA=(0.025+0.095*depth)*(0.45+energy*0.95);
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
      ctx.strokeStyle=lineCol(baseA*(ln.hot?1.7:1));
      ctx.lineWidth=(ln.hot?1.55:0.95)*dpr; ctx.stroke();

      // Bright information packet travelling through selected synapses.
      if((i%23===0 || (state.mode==='processing' && i%11===0)) && pulse>0.68){
        const u=(t*(0.16+(i%7)*0.008)+ln.phase)%1;
        const px=a.x+(b.x-a.x)*u, py=a.y+(b.y-a.y)*u;
        ctx.beginPath(); ctx.arc(px,py,(0.7+1.3*pulse)*dpr,0,Math.PI*2);
        ctx.fillStyle=col(0.22+0.62*pulse,255,210,92); ctx.fill();
      }
    });

    // Tiny drifting micro-particles create the computational dust field.
    dust.forEach((p,i)=>{
      const drift=1+0.018*Math.sin(t*(0.25+seededRand(i)*0.55)+p.phase);
      const q=project({x:p.x*drift,y:p.y*drift,z:p.z*drift});
      const depth=(q.z+1.5)/3;
      const tw=0.22+0.78*(0.5+0.5*Math.sin(t*(0.7+seededRand(i)*2.1)+p.phase));
      ctx.beginPath(); ctx.arc(q.x,q.y,p.size*dpr*(0.55+0.65*depth),0,Math.PI*2);
      ctx.fillStyle=col((0.035+0.19*depth)*tw*(0.55+energy)); ctx.fill();
    });

    // Neural nodes. Near nodes are brighter and slightly larger.
    const order=projected.map((p,i)=>({p,i})).sort((A,B)=>A.p.z-B.p.z);
    order.forEach(({p,i})=>{
      const n=neuralNodes[i];
      const depth=(p.z+1.35)/2.7;
      const activity=0.55+0.45*Math.sin(t*(0.45+n.glow*2.1)+n.phase);
      const hot=n.glow>0.91 || (state.mode==='processing' && n.glow>0.80);
      const radius=(n.size*(0.62+depth*0.92)+(hot?0.45:0))*dpr;
      if(hot && depth>0.42){
        const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,radius*4.2);
        g.addColorStop(0,col(0.20+0.22*energy,255,211,102));
        g.addColorStop(1,col(0));
        ctx.fillStyle=g; ctx.fillRect(p.x-radius*4.2,p.y-radius*4.2,radius*8.4,radius*8.4);
      }
      ctx.beginPath(); ctx.arc(p.x,p.y,Math.max(0.35*dpr,radius),0,Math.PI*2);
      ctx.fillStyle=col((0.055+0.42*depth)*activity*(0.58+energy*0.72),hot?255:c.r,hot?194:c.g,hot?71:c.b);
      ctx.fill();
    });

    // Several independent broken inner rings, some clockwise and some counter-clockwise.
    const ringDefs=[
      [0.78,0.62, 0.083, 0.06], [0.68,0.54,-0.112,-0.13], [0.56,0.47,0.157,0.21],
      [0.45,0.37,-0.205,0.29], [0.88,0.72,-0.044,-0.06]
    ];
    ringDefs.forEach((r,ri)=>{
      const rot=t*r[2] + r[3] + pointer.x*0.035;
      for(let seg=0;seg<4;seg++){
        const start=seg*1.51 + seededRand(ri*17+seg)*0.38 + t*(ri%2?0.012:-0.009);
        const span=0.42+seededRand(ri*9+seg)*0.62;
        drawArcRing(cx,cy,baseR*r[0],baseR*r[1],rot,start,span,lineCol(0.09+energy*0.18),ri===2?1.0:0.65);
      }
    });

    // Micro ticks around one ring: technical divisions, not a loading spinner.
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(-t*0.071);
    for(let i=0;i<72;i++){
      if(i%5===0 || seededRand(i*2.1)>0.62){
        const a=i/72*Math.PI*2;
        const r1=baseR*0.94, r2=r1+baseR*(i%9===0?0.055:0.027);
        ctx.beginPath(); ctx.moveTo(Math.cos(a)*r1,Math.sin(a)*r1); ctx.lineTo(Math.cos(a)*r2,Math.sin(a)*r2);
        ctx.strokeStyle=lineCol(0.06+energy*0.12); ctx.lineWidth=1.15*dpr; ctx.stroke();
      }
    }
    ctx.restore();

    // White-hot computational nucleus made from filaments, points, and short streaks.
    const coreReact = 1 + energy*0.18 + (state.mode==='speaking'?level*0.12:0) - clickPulse*0.08;
    ctx.save(); ctx.translate(cx,cy);
    ctx.globalCompositeOperation='lighter';
    for(let i=0;i<86;i++){
      const a=seededRand(i*4.33)*Math.PI*2 + t*(0.16+seededRand(i)*0.42)*(i%2?1:-1);
      const rr=baseR*(0.055+seededRand(i*7.7)*0.29)*coreReact;
      const bend=Math.sin(t*1.2+i)*baseR*0.018;
      const x=Math.cos(a)*rr, y=Math.sin(a)*rr*0.72;
      ctx.beginPath(); ctx.moveTo(Math.cos(a+0.25)*rr*0.42,Math.sin(a+0.25)*rr*0.30);
      ctx.quadraticCurveTo(x*0.55+bend,y*0.55-bend,x,y);
      ctx.strokeStyle=lineCol(0.08+0.30*seededRand(i*3.4)+energy*0.16,255,190+Math.floor(seededRand(i)*55),80);
      ctx.lineWidth=(0.85+seededRand(i)*1.25)*dpr; ctx.stroke();
    }
    for(let i=0;i<58;i++){
      const a=seededRand(i*6.2+2)*Math.PI*2 + t*(0.7+seededRand(i)*1.8);
      const rr=baseR*(0.018+seededRand(i*8.2)*0.18)*coreReact;
      const x=Math.cos(a)*rr,y=Math.sin(a)*rr;
      const rad=(0.5+seededRand(i)*1.6+energy*0.8)*dpr;
      ctx.beginPath();ctx.arc(x,y,rad,0,Math.PI*2);
      ctx.fillStyle=col(0.22+seededRand(i)*0.58,255,225,150);ctx.fill();
    }
    const nucleusGlow=ctx.createRadialGradient(0,0,0,0,0,baseR*(0.16+energy*0.055));
    nucleusGlow.addColorStop(0,col(0.88,255,246,213));
    nucleusGlow.addColorStop(0.16,col(0.42,255,210,92));
    nucleusGlow.addColorStop(0.55,col(0.10,255,106,0));
    nucleusGlow.addColorStop(1,col(0));
    ctx.fillStyle=nucleusGlow; ctx.fillRect(-baseR*.28,-baseR*.28,baseR*.56,baseR*.56);
    ctx.globalCompositeOperation='source-over';
    ctx.restore();

    // Listening / click expansion waves; deliberately incomplete.
    if(state.mode==='listening' || clickPulse>0.04){
      for(let i=0;i<3;i++){
        const phase=((t*0.34+i/3)%1);
        const rr=baseR*(0.28+phase*1.08);
        const alpha=(1-phase)*(0.05+0.14*Math.max(level,clickPulse));
        drawArcRing(cx,cy,rr,rr*0.94,pointer.x*0.02,t*0.05+i*2.1,Math.PI*(0.8+0.5*seededRand(i+2)),lineCol(alpha),0.8);
      }
    }

    // Fine outer activity bars react to listening/processing/speaking state.
    ctx.save(); ctx.translate(cx,cy);
    const bars=96;
    for(let i=0;i<bars;i++){
      if(i%3===1 && state.mode==='off') continue;
      const a=i/bars*Math.PI*2;
      let mag=0.018+0.018*Math.sin(i*1.7+t);
      if(state.mode==='listening'||state.mode==='armed') mag+=level*0.11*Math.abs(Math.sin(i*0.93+t*1.9));
      if(state.mode==='processing') mag+=0.055*Math.abs(Math.sin(i*2.2-t*4.1));
      if(state.mode==='speaking') mag+=0.08*Math.abs(Math.sin(i*0.81+t*6.2))*Math.max(0.3,level);
      const r1=baseR*1.48, r2=r1+baseR*mag;
      ctx.beginPath();ctx.moveTo(Math.cos(a)*r1,Math.sin(a)*r1);ctx.lineTo(Math.cos(a)*r2,Math.sin(a)*r2);
      ctx.strokeStyle=lineCol(0.07+Math.min(0.24,mag*1.7));ctx.lineWidth=(i%8===0?1.65:1.0)*dpr;ctx.stroke();
    }
    ctx.restore();

    t += 0.016;
    requestAnimationFrame(drawCore);
  }
  requestAnimationFrame(drawCore);

  // ---------------- microphone session / level analyser ----------------
  // One MediaStream is acquired when ARC powers on and is reused by both the
  // visual analyser and SpeechRecognition. We mute the live track during
  // processing/TTS instead of destroying/re-requesting microphone access.
  let audioCtx, analyser, micSource, micStream, micTrack, freqData;
  let micPermissionState = 'unknown';
  let micOriginWarningShown = false;

  function isSecureMicOrigin(){
    return location.protocol === 'https:' ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1' ||
      location.hostname === '[::1]';
  }

  async function queryMicPermission(){
    try{
      if(navigator.permissions && navigator.permissions.query){
        const status = await navigator.permissions.query({name:'microphone'});
        micPermissionState = status.state || 'unknown';
        status.onchange = () => { micPermissionState = status.state || 'unknown'; };
      }
    }catch(_){
      // Some browsers do not expose "microphone" through Permissions API.
      micPermissionState = 'unknown';
    }
    return micPermissionState;
  }

  function getLiveMicTrack(){
    if(micTrack && micTrack.readyState === 'live') return micTrack;
    if(micStream){
      const t = micStream.getAudioTracks().find(tr => tr.readyState === 'live');
      if(t){ micTrack = t; return t; }
    }
    return null;
  }

  function setMicCaptureEnabled(enabled){
    const track = getLiveMicTrack();
    if(track) track.enabled = !!enabled;
    systemInfo.mic = track ? (enabled ? 'LIVE' : 'MUTED') : 'IDLE';
    refreshSystemHud();
  }

  async function startAnalyser(){
    // Reuse the already-authorized stream for the entire powered-on session.
    const existingTrack = getLiveMicTrack();
    if(existingTrack){
      existingTrack.enabled = true;
      try{
        if(audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
      }catch(_){}
      return true;
    }

    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      logEntry('system', 'Microphone capture is unavailable in this browser/context.');
      setMode('error', 'Microphone capture requires Chrome/Edge on HTTPS or localhost.');
      return false;
    }

    if(!isSecureMicOrigin() && !micOriginWarningShown){
      micOriginWarningShown = true;
      logEntry('system', 'Microphone note: this page is not running on HTTPS/localhost. Browser permission may not persist reliably between recognition sessions.');
    }

    await queryMicPermission();
    try{
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      micTrack = micStream.getAudioTracks()[0] || null;
      if(!micTrack) throw new Error('No live microphone audio track was returned.');

      micTrack.enabled = true;
      micTrack.onended = () => {
        if(!state.power) return;
        recognitionAcceptResults = false;
        recognitionShouldRun = false;
        setMode('error', 'Microphone disconnected. Reconnect it, then power ARC off and on once.');
        logEntry('system', 'Microphone track ended or the input device was disconnected.');
      };

      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      try{
        if(audioCtx.state === 'suspended') await audioCtx.resume();
      }catch(_){}
      micSource = audioCtx.createMediaStreamSource(micStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      freqData = new Uint8Array(analyser.frequencyBinCount);
      micSource.connect(analyser);
      pollLevel();
      micPermissionState = 'granted';
      return true;
    }catch(err){
      micStream = null;
      micTrack = null;
      const name = err && err.name ? err.name : '';
      const detail = err && err.message ? err.message : String(err);
      logEntry('system', 'Microphone access denied or unavailable: ' + detail);
      if(name === 'NotAllowedError' || name === 'SecurityError'){
        setMode('error', 'Microphone permission is blocked. Allow it once in the browser site controls, then try again.');
      }else if(name === 'NotFoundError'){
        setMode('error', 'No microphone was found. Connect/select a microphone and try again.');
      }else{
        setMode('error', 'Microphone is unavailable. Check browser/site settings and the selected input device.');
      }
      return false;
    }
  }

  function stopAnalyser(){
    // Power-off deliberately releases the physical mic. While ARC stays powered
    // on, the stream remains alive and permission is not re-requested per command.
    if(micStream){ micStream.getTracks().forEach(tr=>tr.stop()); }
    if(audioCtx){ try{ audioCtx.close(); }catch(_){} }
    audioCtx = null;
    analyser = null;
    micSource = null;
    micStream = null;
    micTrack = null;
    freqData = null;
    targetLevel = 0;
    systemInfo.mic = 'IDLE';
    refreshSystemHud();
  }

  function pollLevel(){
    if(!analyser || !freqData) return;
    analyser.getByteFrequencyData(freqData);
    let sum = 0;
    for(let i=0;i<freqData.length;i++) sum += freqData[i];
    const avg = sum / freqData.length / 255;
    targetLevel = Math.min(1, avg*2.2);
    requestAnimationFrame(pollLevel);
  }

  // ---------------- speech recognition ----------------
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let recognitionRunning = false;
  let recognitionShouldRun = false;
  let recognitionAcceptResults = false;
  let recognitionIgnoreUntil = 0;
  let recognitionRestartTimer = null;
  let silenceTimer = null;
  let commandBuffer = '';
  let commandCommitted = '';
  let listeningPurpose = 'armed'; // 'armed' | 'command'

  function containsWakeWord(text){
    const lower = String(text || '').toLowerCase();
    for(const w of state.wakeWords){
      if(w && lower.includes(w)) return w;
    }
    return null;
  }

  function stripAfterWakeWord(text, wake){
    const raw = String(text || '');
    const idx = raw.toLowerCase().indexOf(wake);
    if(idx === -1) return '';
    return raw.slice(idx + wake.length).replace(/^[,.\s]+/, '');
  }

  function safeStartRecognizer(){
    clearTimeout(recognitionRestartTimer);
    if(!recognizer || recognitionRunning || !recognitionShouldRun || !state.power) return;
    if(state.mode !== 'armed' && state.mode !== 'listening') return;

    try{
      const track = getLiveMicTrack();
      if(track){
        // Chrome 135+ accepts a MediaStreamTrack. Reusing our already-authorized
        // track avoids a second microphone acquisition path.
        try{
          recognizer.start(track);
        }catch(trackErr){
          // Older Web Speech implementations ignore/deny the track argument.
          // Fall back to the default microphone without crashing.
          if(trackErr && (trackErr.name === 'TypeError' || trackErr.name === 'NotSupportedError')){
            recognizer.start();
          }else{
            throw trackErr;
          }
        }
      }else{
        recognizer.start();
      }
    }catch(err){
      // InvalidStateError simply means Chrome still considers the recognizer active.
      if(err && err.name !== 'InvalidStateError'){
        logEntry('system', 'Could not start speech recognition: ' + (err.message || err));
      }
    }
  }

  function scheduleRecognizerStart(delay=180){
    clearTimeout(recognitionRestartTimer);
    recognitionRestartTimer = setTimeout(safeStartRecognizer, delay);
  }

  function pauseRecognition(){
    // Do NOT abort SpeechRecognition for every sentence. Keep the authorized
    // session alive, mute the shared audio track, and ignore recognition events.
    recognitionAcceptResults = false;
    recognitionIgnoreUntil = Number.POSITIVE_INFINITY;
    clearTimeout(silenceTimer);
    setMicCaptureEnabled(false);
  }

  function resumeRecognition(cooldownMs=500){
    if(!SpeechRecognitionImpl || !state.power) return;
    recognitionShouldRun = true;
    recognitionAcceptResults = false;
    setMicCaptureEnabled(true);
    recognitionIgnoreUntil = Date.now() + Math.max(0, cooldownMs);
    setTimeout(() => {
      if(!state.power) return;
      if(state.mode === 'armed' || state.mode === 'listening'){
        recognitionAcceptResults = true;
      }
    }, Math.max(0, cooldownMs));
    if(!recognitionRunning) scheduleRecognizerStart(80);
  }

  function createRecognizer(){
    const r = new SpeechRecognitionImpl();
    r.continuous = true;
    r.interimResults = true;
    r.lang = 'en-US';

    r.onstart = () => {
      recognitionRunning = true;
      if((state.mode === 'armed' || state.mode === 'listening') && Date.now() >= recognitionIgnoreUntil){
        recognitionAcceptResults = true;
      }
    };

    r.onresult = (e) => {
      // Never accept stale/self-audio while a model request/TTS is active or
      // during the short post-TTS cooldown.
      if(!recognitionAcceptResults || Date.now() < recognitionIgnoreUntil) return;
      if(state.mode === 'processing' || state.mode === 'speaking' || state.mode === 'manual' || state.mode === 'off') return;

      let interim = '', final = '';
      for(let i=e.resultIndex; i<e.results.length; i++){
        const transcript = e.results[i][0].transcript;
        if(e.results[i].isFinal) final += (final ? ' ' : '') + transcript;
        else interim += (interim ? ' ' : '') + transcript;
      }
      const combined = (final + ' ' + interim).trim();
      if(!combined) return;

      if(listeningPurpose === 'armed'){
        const wake = containsWakeWord(combined);
        if(wake){
          const remainder = stripAfterWakeWord(combined, wake);
          logEntry('system', `Wake word "${wake}" detected.`);
          switchToCommandMode(remainder);
        }
      } else if (listeningPurpose === 'command'){
        // Keep finalized speech instead of overwriting it each recognition event.
        let finalSegment = final.trim();
        let interimSegment = interim.trim();
        const repeatedWake = containsWakeWord(finalSegment || interimSegment);
        if(repeatedWake){
          if(finalSegment) finalSegment = stripAfterWakeWord(finalSegment, repeatedWake);
          else interimSegment = stripAfterWakeWord(interimSegment, repeatedWake);
        }
        if(finalSegment){
          commandCommitted = (commandCommitted + ' ' + finalSegment).trim();
        }
        commandBuffer = (commandCommitted + ' ' + interimSegment).trim();
        liveLine.textContent = commandBuffer;
        if(commandBuffer) resetSilenceTimer();
      }
    };

    r.onerror = (e) => {
      recognitionRunning = false;
      if(e.error === 'no-speech' || e.error === 'aborted') return;
      logEntry('system', 'Recognition error: ' + e.error);
      if(e.error === 'not-allowed' || e.error === 'service-not-allowed'){
        recognitionShouldRun = false;
        recognitionAcceptResults = false;
        const localHint = !isSecureMicOrigin()
          ? ' Open this page from HTTPS or localhost so Chrome can retain microphone permission.'
          : '';
        if(state.power) setMode('error', 'Speech recognition permission is unavailable.' + localHint);
      }else if(e.error === 'audio-capture'){
        recognitionShouldRun = false;
        recognitionAcceptResults = false;
        if(state.power) setMode('error', 'Speech recognition lost the microphone input.');
      }
    };

    r.onend = () => {
      recognitionRunning = false;
      if(recognitionShouldRun && state.power && (state.mode === 'armed' || state.mode === 'listening')){
        scheduleRecognizerStart(220);
      }
    };

    return r;
  }

  function switchToCommandMode(initialText){
    listeningPurpose = 'command';
    commandCommitted = (initialText || '').trim();
    commandBuffer = commandCommitted;
    liveLine.textContent = commandBuffer;
    setMode('listening', 'Listening for your command…');
    resumeRecognition(0);
    resetSilenceTimer();
  }

  function resetSilenceTimer(){
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if(state.mode !== 'listening') return;
      if(commandBuffer.trim().length > 0){
        finalizeCommand(commandBuffer.trim());
      } else {
        rearmListening();
      }
    }, 1400);
  }

  function rearmListening(cooldownMs=700){
    clearTimeout(silenceTimer);
    listeningPurpose = 'armed';
    commandBuffer = '';
    commandCommitted = '';
    liveLine.textContent = '';
    if(state.power){
      setMode('armed', `Say "${state.wakeWords[0]}" to give a command.`);
      resumeRecognition(cooldownMs);
    }
  }

  function startListening(){
    if(!SpeechRecognitionImpl){
      setMode('error', 'This browser has no speech recognition. Use Chrome or Edge.');
      logEntry('system', 'SpeechRecognition API not found in this browser.');
      return;
    }
    if(!recognizer) recognizer = createRecognizer();
    listeningPurpose = 'armed';
    commandBuffer = '';
    commandCommitted = '';
    recognitionShouldRun = true;
    recognitionAcceptResults = false;
    recognitionIgnoreUntil = Date.now() + 250;
    setMicCaptureEnabled(true);
    setMode('armed', `Say "${state.wakeWords[0]}" to give a command.`);
    safeStartRecognizer();
    setTimeout(() => {
      if(state.power && (state.mode === 'armed' || state.mode === 'listening')){
        recognitionAcceptResults = true;
      }
    }, 250);
  }

  function stopListening(){
    clearTimeout(silenceTimer);
    clearTimeout(recognitionRestartTimer);
    recognitionShouldRun = false;
    if(recognizer){
      recognizer.onend = null;
      recognizer.onerror = null;
      try{ recognizer.abort(); }catch(_){}
      recognizer = null;
    }
    recognitionRunning = false;
    recognitionAcceptResults = false;
    recognitionIgnoreUntil = 0;
    commandBuffer = '';
    commandCommitted = '';
  }

  // ---------------- push to talk (manual fallback) ----------------
  let ptt = false;
  talkBtn.addEventListener('mousedown', () => beginPTT());
  talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); beginPTT(); });
  talkBtn.addEventListener('mouseup', () => endPTT());
  talkBtn.addEventListener('mouseleave', () => { if(ptt) endPTT(); });
  talkBtn.addEventListener('touchend', () => endPTT());
  talkBtn.addEventListener('touchcancel', () => endPTT());

  function beginPTT(){
    if(ptt || !state.power || state.mode === 'processing' || state.mode === 'speaking') return;
    ptt = true;
    talkBtn.classList.add('active');
    setMicCaptureEnabled(true);
    switchToCommandMode('');
    resumeRecognition(0);
    clearTimeout(silenceTimer); // manual mode: no auto-timeout while held
  }
  function endPTT(){
    if(!ptt) return;
    ptt = false;
    talkBtn.classList.remove('active');
    if(commandBuffer.trim().length > 0){
      finalizeCommand(commandBuffer.trim());
    } else {
      rearmListening();
    }
  }

  // ---------------- multi-provider model gateway ----------------
  function activeProvider(){ return PROVIDERS[state.provider] || PROVIDERS.gemini; }
  function activeKey(){ return state.apiKeys[state.provider] || ''; }
  function activeModel(){ return state.models[state.provider] || activeProvider().defaultModel; }

  let activeRequestController = null;
  let activeRequestTimeout = null;
  let requestSerial = 0;
  let requestAbortReason = '';

  function abortActiveRequest(reason='cancelled'){
    requestAbortReason = reason;
    clearTimeout(activeRequestTimeout);
    activeRequestTimeout = null;
    if(activeRequestController){
      try{ activeRequestController.abort(); }catch(_){}
      activeRequestController = null;
    }
  }

  function beginRequest(){
    abortActiveRequest('replaced');
    requestAbortReason = '';
    activeRequestController = new AbortController();
    const controller = activeRequestController;
    activeRequestTimeout = setTimeout(() => {
      if(activeRequestController === controller){
        requestAbortReason = 'timeout';
        try{ controller.abort(); }catch(_){}
      }
    }, 60000);
    return controller;
  }

  function requestSignal(){ return activeRequestController ? activeRequestController.signal : undefined; }

  function finishRequest(controller){
    if(activeRequestController === controller){
      clearTimeout(activeRequestTimeout);
      activeRequestTimeout = null;
      activeRequestController = null;
    }
  }

  function extractResponsesText(data){
    if(data && typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
    const chunks=[];
    if(data && Array.isArray(data.output)){
      data.output.forEach(item => {
        if(Array.isArray(item.content)) item.content.forEach(part => {
          if(part && typeof part.text === 'string') chunks.push(part.text);
          else if(part && part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
        });
      });
    }
    return chunks.join('\n').trim();
  }

  async function parseFailure(res, providerLabel){
    const body=await res.text();
    let msg=`${providerLabel} HTTP ${res.status}`;
    try{
      const p=JSON.parse(body);
      msg=(p.error && (p.error.message || p.error.type)) || p.message || msg;
    }catch(_){ if(body) msg += ': ' + body.slice(0,240); }
    if(res.status===401 || res.status===403) msg += ' — check this provider API key and its permissions.';
    if(res.status===429) msg += ' — quota/rate limit reached or billing is not enabled.';
    throw new Error(msg);
  }

  async function requestOpenAI(text){
    const res=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      signal:requestSignal(),
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.apiKeys.openai},
      body:JSON.stringify({
        model:state.models.openai || 'gpt-5.6-luna',
        input:[
          {role:'system',content:state.sysPrompt || 'You are a concise, helpful voice assistant.'},
          {role:'user',content:text}
        ]
      })
    });
    if(!res.ok) await parseFailure(res,'OpenAI');
    return extractResponsesText(await res.json());
  }

  async function requestAnthropic(text){
    const res=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      signal:requestSignal(),
      headers:{
        'Content-Type':'application/json',
        'x-api-key':state.apiKeys.anthropic,
        'anthropic-version':'2023-06-01',
        'anthropic-dangerous-direct-browser-access':'true'
      },
      body:JSON.stringify({
        model:state.models.anthropic || 'claude-sonnet-5',
        max_tokens:2048,
        system:state.sysPrompt || 'You are a concise, helpful voice assistant.',
        messages:[{role:'user',content:text}]
      })
    });
    if(!res.ok) await parseFailure(res,'Anthropic');
    const data=await res.json();
    return (data.content || []).filter(x=>x.type==='text').map(x=>x.text).join('\n').trim();
  }

  async function requestXAI(text){
    const res=await fetch('https://api.x.ai/v1/responses',{
      method:'POST',
      signal:requestSignal(),
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.apiKeys.xai},
      body:JSON.stringify({
        model:state.models.xai || 'grok-4.6',
        input:[
          {role:'system',content:state.sysPrompt || 'You are a concise, helpful voice assistant.'},
          {role:'user',content:text}
        ]
      })
    });
    if(!res.ok) await parseFailure(res,'xAI');
    return extractResponsesText(await res.json());
  }

  function validateGeminiCredential(rawKey){
    const key=String(rawKey || '').trim().replace(/^['"]|['"]$/g,'');
    if(!key) throw new Error('No Gemini API key is configured. Create one in Google AI Studio and place it in api-keys.js.');
    if(/\.apps\.googleusercontent\.com$/i.test(key)){
      throw new Error('The Gemini credential is an OAuth Client ID, not a Gemini API key. Create/copy an API key from Google AI Studio.');
    }
    if(/^ya29\./i.test(key) || /^Bearer\s+/i.test(key)){
      throw new Error('The Gemini credential looks like an OAuth access token. ARC expects a Gemini API key from Google AI Studio.');
    }
    if(/^GEMINI_API_KEY\s*=/.test(key)){
      throw new Error('Paste only the Gemini API key value, not the GEMINI_API_KEY= prefix.');
    }
    return key;
  }

  function extractGeminiInteractionText(data){
    if(data && typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
    const chunks=[];
    if(data && Array.isArray(data.steps)){
      data.steps.forEach(step=>{
        if(step?.type!=='model_output' || !Array.isArray(step.content)) return;
        step.content.forEach(part=>{
          if(part?.type==='text' && typeof part.text==='string') chunks.push(part.text);
        });
      });
    }
    return chunks.join('\n').trim();
  }

  async function requestGemini(text){
    const model=state.models.gemini || 'gemini-3.5-flash-lite';
    const geminiKey=validateGeminiCredential(state.apiKeys.gemini);
    // Current Gemini REST path recommended by Google for Gemini 3.x models.
    const res=await fetch('https://generativelanguage.googleapis.com/v1beta/interactions',{
      method:'POST',
      signal:requestSignal(),
      headers:{
        'Content-Type':'application/json',
        'x-goog-api-key':geminiKey
      },
      body:JSON.stringify({
        model,
        input:text,
        system_instruction:state.sysPrompt || 'You are a concise, helpful voice assistant.'
      })
    });
    if(!res.ok){
      try{
        await parseFailure(res,'Gemini');
      }catch(err){
        const detail=err?.message || String(err);
        if(/invalid authentication credentials|UNAUTHENTICATED|API key not valid|API_KEY_INVALID|permission/i.test(detail)){
          throw new Error(detail + ' Use a Gemini API key created in Google AI Studio (not an OAuth Client ID, client secret, login token, or unrelated Google API key). If this is an old Standard key, create a new AI Studio auth key.');
        }
        throw err;
      }
    }
    const data=await res.json();
    const outputText=extractGeminiInteractionText(data);
    if(outputText) return outputText;
    if(data?.status && data.status!=='completed') throw new Error('Gemini interaction ended with status: '+data.status+'.');
    return '';
  }

  async function callSelectedProvider(text){
    if(state.provider==='anthropic') return requestAnthropic(text);
    if(state.provider==='xai') return requestXAI(text);
    if(state.provider==='gemini') return requestGemini(text);
    return requestOpenAI(text);
  }

  async function finalizeCommand(text){
    text=String(text || '').trim();
    if(!text || !state.power || state.mode === 'processing' || state.mode === 'speaking') return;

    clearTimeout(silenceTimer);
    pauseRecognition(); // prevents ARC from hearing its own processing/TTS cycle
    liveLine.textContent='';
    commandBuffer='';
    commandCommitted='';
    logEntry('user',text);

    let providerPrompt=text;
    try{
      const local=await resolveLocalCommand(text);
      if(local?.handled){
        if(local.reply) localReply(local.reply);
        else if(state.power) rearmListening();
        return;
      }
      if(local?.prompt) providerPrompt=local.prompt;
      if(local?.note) logEntry('system',local.note);
    }catch(err){
      const detail=err?.message || String(err);
      logEntry('system','Local tool failed: '+detail);
      localReply('I could not complete that local task. '+detail);
      return;
    }

    const p=activeProvider();
    setMode('processing',`Sending to ${p.label} / ${activeModel()}…`);

    if(!activeKey()){
      logEntry('system',`No ${p.label} API key set. Open settings and add the key for the selected provider.`);
      setMode('error',`Missing ${p.label} API key.`);
      setTimeout(()=>{ if(state.power) rearmListening(); },1800);
      return;
    }

    const mySerial=++requestSerial;
    const controller=beginRequest();
    try{
      const reply=(await callSelectedProvider(providerPrompt)) || '(no response content)';
      if(mySerial !== requestSerial || !state.power) return; // stale/power-off response
      lastAssistantReply=reply;
      logEntry('assistant',`[${p.label}] ${reply}`);
      speak(reply);
    }catch(err){
      if(mySerial !== requestSerial || !state.power) return;
      if(err && err.name === 'AbortError'){
        const why=requestAbortReason === 'timeout' ? 'The request timed out after 60 seconds.' : 'The request was cancelled.';
        logEntry('system',why);
        setMode('error',why);
      }else{
        const detail=(err && err.message) ? err.message : String(err);
        logEntry('system','Request failed: '+detail);
        const networkHint=/Failed to fetch|NetworkError|Load failed/i.test(detail)
          ? ' Browser/network/CORS access may be blocking the provider.' : '';
        setMode('error',`Could not reach ${p.label}. Check its key, model, quota, and connection.${networkHint}`);
      }
      setTimeout(()=>{ if(state.power) rearmListening(); },2400);
    }finally{
      finishRequest(controller);
    }
  }

  // ---------------- speech synthesis / per-AI voice profiles ----------------
  let voices=[];
  const VOICE_SELECT_IDS = {
    openai: 'voiceOpenAI',
    anthropic: 'voiceAnthropic',
    xai: 'voiceXAI',
    gemini: 'voiceGemini'
  };
  function googleVoice(v){ return /Google/i.test(v.name) && /en/i.test(v.lang || ''); }
  function sortedVoices(){
    return voices.slice().sort((a,b)=>(googleVoice(b)?1:0)-(googleVoice(a)?1:0) || a.name.localeCompare(b.name));
  }
  function populateVoiceSelect(provider){
    const sel=$(VOICE_SELECT_IDS[provider]);
    if(!sel) return;
    const wanted=state.voiceNames[provider] || '__auto__';
    sel.innerHTML='';

    const autoOpt=document.createElement('option');
    autoOpt.value='__auto__';
    autoOpt.textContent=state.preferGoogleVoice
      ? 'AUTO · Prefer Google voice'
      : 'AUTO · Browser default voice';
    sel.appendChild(autoOpt);

    sortedVoices().forEach(v=>{
      const opt=document.createElement('option');
      opt.value=v.name;
      opt.textContent=`${googleVoice(v)?'★ GOOGLE · ':''}${v.name} (${v.lang})`;
      sel.appendChild(opt);
    });

    sel.value = (wanted==='__auto__' || voices.some(v=>v.name===wanted)) ? wanted : '__auto__';
  }
  function populateAllVoiceSelects(){
    Object.keys(VOICE_SELECT_IDS).forEach(populateVoiceSelect);
  }
  function loadVoices(){
    voices=window.speechSynthesis.getVoices();
    populateAllVoiceSelects();
    const note=$('voiceNote');
    if(note){
      note.textContent=voices.some(googleVoice)
        ? 'Each AI remembers its own voice. Google voices are starred. AUTO uses a Google English voice when “Prefer Google Voice” is enabled.'
        : 'Each AI remembers its own voice. No Google speech-synthesis voice is exposed by this browser/OS right now; AUTO will use the browser default.';
    }
  }
  window.speechSynthesis.onvoiceschanged=loadVoices;
  loadVoices();

  function voiceForProvider(provider){
    const voiceName=state.voiceNames[provider] || '__auto__';
    if(voiceName!=='__auto__'){
      const explicit=voices.find(v=>v.name===voiceName);
      if(explicit) return explicit;
    }
    if(state.preferGoogleVoice){
      const gv=voices.find(googleVoice);
      if(gv) return gv;
    }
    return null; // null lets the browser use its default voice
  }

  function speak(text){
    if(!state.power) return;
    pauseRecognition();
    setMode('speaking','Speaking…');
    window.speechSynthesis.cancel();
    const utter=new SpeechSynthesisUtterance(text);
    const v=voiceForProvider(state.provider);
    if(v) utter.voice=v;
    utter.rate=1.02;
    utter.pitch=1.0;
    utter.onstart=()=>{ targetLevel=Math.max(targetLevel,0.22); };
    utter.onend=()=>{
      targetLevel=0;
      if(state.power && state.autoRearm) rearmListening(900);
      else if(state.power){
        recognitionAcceptResults = false;
        setMicCaptureEnabled(false);
        setMode('manual','Speech finished. Hold-to-talk or re-enable auto re-arm in settings.');
      }
    };
    utter.onerror=()=>{
      targetLevel=0;
      if(state.power && state.autoRearm) rearmListening(500);
      else if(state.power){
        recognitionAcceptResults = false;
        setMicCaptureEnabled(false);
        setMode('manual','Voice output failed. Hold-to-talk to continue.');
      }
    };
    window.speechSynthesis.speak(utter);
  }

  // ---------------- power control ----------------
  powerBtn.addEventListener('click', async () => {
    if(!state.power){
      const ok = await startAnalyser();
      if(ok === false) return;
      state.power = true;
      powerBtn.classList.add('on');
      talkBtn.disabled = false;
      logEntry('system', 'Console online.');
      startListening();
    } else {
      state.power = false;
      requestSerial++;
      abortActiveRequest('poweroff');
      powerBtn.classList.remove('on');
      talkBtn.disabled = true;
      stopListening();
      stopAnalyser();
      window.speechSynthesis.cancel();
      logEntry('system', 'Console offline.');
      setMode('off', 'Press the power ring to bring the link online.');
      liveLine.textContent = '';
    }
  });

  // ---------------- settings drawer ----------------
  const overlay = $('overlay'), drawer = $('drawer');
  function syncSettingsUI(){
    $('providerSelect').value = state.provider;
    $('openaiKey').value = state.apiKeys.openai;
    $('anthropicKey').value = state.apiKeys.anthropic;
    $('xaiKey').value = state.apiKeys.xai;
    $('geminiKey').value = state.apiKeys.gemini;
    $('openaiModel').value = state.models.openai;
    $('anthropicModel').value = state.models.anthropic;
    $('xaiModel').value = state.models.xai;
    $('geminiModel').value = state.models.gemini;
    $('sysPrompt').value = state.sysPrompt || 'You are a concise, helpful voice assistant. Keep replies short and speakable.';
    $('wakeWords').value = state.wakeWords.join(', ');
    autoRearmSwitch.classList.toggle('on', state.autoRearm);
    preferGoogleVoiceSwitch.classList.toggle('on', state.preferGoogleVoice);
    populateAllVoiceSelects();
  }
  function openDrawer(){ closeToolsDrawer(); syncSettingsUI(); overlay.classList.add('open'); drawer.classList.add('open'); }
  function closeDrawer(){ overlay.classList.remove('open'); drawer.classList.remove('open'); }
  $('settingsBtn').addEventListener('click', openDrawer);
  $('drawerClose').addEventListener('click', closeDrawer);
  overlay.addEventListener('click', closeDrawer);

  const autoRearmSwitch = $('autoRearm');
  const preferGoogleVoiceSwitch = $('preferGoogleVoice');
  autoRearmSwitch.addEventListener('click', () => autoRearmSwitch.classList.toggle('on'));
  preferGoogleVoiceSwitch.addEventListener('click', () => {
    preferGoogleVoiceSwitch.classList.toggle('on');
    // Preview only. The setting is committed by SAVE & CLOSE, preserving transactional settings behavior.
    const previewPreferGoogle=preferGoogleVoiceSwitch.classList.contains('on');
    Object.values(VOICE_SELECT_IDS).forEach(id=>{
      const sel=$(id);
      if(sel && sel.options.length){
        sel.options[0].textContent=previewPreferGoogle ? 'AUTO · Prefer Google voice' : 'AUTO · Browser default voice';
      }
    });
  });

  $('saveSettings').addEventListener('click', () => {
    state.provider = $('providerSelect').value in PROVIDERS ? $('providerSelect').value : 'gemini';
    state.apiKeys.openai = $('openaiKey').value.trim();
    state.apiKeys.anthropic = $('anthropicKey').value.trim();
    state.apiKeys.xai = $('xaiKey').value.trim();
    state.apiKeys.gemini = $('geminiKey').value.trim();
    state.models.openai = $('openaiModel').value.trim() || PROVIDERS.openai.defaultModel;
    state.models.anthropic = $('anthropicModel').value.trim() || PROVIDERS.anthropic.defaultModel;
    state.models.xai = $('xaiModel').value.trim() || PROVIDERS.xai.defaultModel;
    state.models.gemini = $('geminiModel').value.trim() || PROVIDERS.gemini.defaultModel;
    state.sysPrompt = $('sysPrompt').value.trim();
    state.wakeWords = $('wakeWords').value.split(',').map(w=>w.trim().toLowerCase()).filter(Boolean);
    if(state.wakeWords.length===0) state.wakeWords=['jarvis'];
    state.voiceNames.openai = $('voiceOpenAI').value || '__auto__';
    state.voiceNames.anthropic = $('voiceAnthropic').value || '__auto__';
    state.voiceNames.xai = $('voiceXAI').value || '__auto__';
    state.voiceNames.gemini = $('voiceGemini').value || '__auto__';
    state.autoRearm = autoRearmSwitch.classList.contains('on');
    state.preferGoogleVoice = preferGoogleVoiceSwitch.classList.contains('on');
    saveSessionSettings();
    providerBadge.textContent=`v2 // ${PROVIDERS[state.provider].label} LINK`;
    closeDrawer();
    const voiceSetting=state.voiceNames[state.provider]==='__auto__' ? 'AUTO' : state.voiceNames[state.provider];
    logEntry('system',`Settings saved. Active AI: ${PROVIDERS[state.provider].label} / ${activeModel()} · Voice: ${voiceSetting}.`);
    if(state.power && state.mode==='armed') setMode('armed',`Say "${state.wakeWords[0]}" to give a command.`);
  });

  // ---------------- transcript panel mobile toggle ----------------
  $('logToggleMobile').addEventListener('click', () => {
    panel.classList.toggle('mobile-open');
  });
  $('clearLog').addEventListener('click', () => { logEl.innerHTML = ''; });

  // ---------------- keyboard shortcut: space = push to talk when focus not in input ----------------
  window.addEventListener('keydown', (e) => {
    const el=document.activeElement;
    const typing=!!el && (el.matches?.('input, textarea, select, button') || el.isContentEditable);
    if(e.code === 'Space' && !typing && !e.repeat){
      e.preventDefault();
      beginPTT();
    }
    if(e.key === 'Escape'){
      window.speechSynthesis.cancel();
      if(state.mode === 'processing'){
        requestSerial++;
        abortActiveRequest('user');
      }
      if(state.power) rearmListening();
    }
  });
  window.addEventListener('keyup', (e) => {
    if(e.code === 'Space') endPTT();
  });

  // ---------------- lifecycle / init ----------------
  window.addEventListener('beforeunload', () => {
    try{ stopListening(); }catch(_){}
    try{ stopAnalyser(); }catch(_){}
    try{ window.speechSynthesis.cancel(); }catch(_){}
  });

  logEntry('system', 'Console initialized in STATIC MODE. Gemini / Google is the default AI provider. Add your Gemini API key (or select another provider in settings), then power on.');
  logEntry('system', 'System HUD online. Local file tools remain locked until you explicitly grant a workspace folder.');
  if(location.protocol === 'file:'){
    logEntry('system', 'For persistent microphone permission, run this HTML from HTTPS or http://localhost instead of opening it directly as file://.');
  }
  providerBadge.textContent=`v2 // ${PROVIDERS[state.provider].label} LINK`;
  setMode('off');
})();
