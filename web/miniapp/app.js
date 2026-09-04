const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();
const initData = tg?.initData || "";
const $ = (id) => document.getElementById(id);
const headers = () => ({ Authorization: `tma ${initData}`, "content-type": "application/json" });
const esc = (value) => String(value || "").replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago = (ms) => { if (!ms) return "—"; const s=Math.max(0,Math.round((Date.now()-ms)/1000)); return s<60?`${s} с`:s<3600?`${Math.round(s/60)} хв`:`${Math.round(s/3600)} год`; };
function stateLabel(p) {
  const s=p.state; if(s.control.paused) return ["Пауза","warn"];
  const st=s.runtime.status||"unknown";
  if(["working","assistant"].includes(st)) return ["Працює",""];
  if(st.includes("error")||st.includes("failed")) return [st,"bad"];
  return [st,"warn"];
}
async function api(path, options={}) {
  const r=await fetch(path,{...options,headers:{...headers(),...(options.headers||{})}});
  const j=await r.json(); if(!r.ok) throw new Error(j.error||`HTTP ${r.status}`); return j;
}
function checkpointBlock(p) {
  if (!p.checkpointLedger?.enabled) return "";
  const c=p.state.checkpoint||{};
  if(!c.fingerprint) return `<div class="checkpoint"><b>Project checkpoint:</b> ще не отримано.</div>`;
  const ev=c.evidenceHealth||{};
  const evidenceLabel=!ev.configured?'не налаштовано':(ev.ok?'✅ verified':`⚠ ${esc((ev.reasons||[]).join(', ')||'pending')}`);
  const blockers=(c.blockers||[]).length?`<br><small><b>Blockers:</b> ${esc(c.blockers.join(' • '))}</small>`:"";
  return `<div class="checkpoint"><b>Checkpoint #${Number(c.revision||0)} • ${esc(c.completionStatus||c.stage||'active')}</b><br><b>Ціль:</b> ${esc(c.goal||'—')}<br><b>Поточна задача:</b> ${esc(c.currentTask||'—')}<br><b>Далі:</b> ${esc(c.nextAction||'—')}<br><small>Evidence: ${evidenceLabel} • оновлено ${ago(c.updatedAt)}</small>${blockers}</div>`;
}
function recoveryBlock(p) {
  if (!p.browserRecovery?.enabled) return "";
  const r=p.state.recovery||{}; const stage=r.stage||"idle";
  if(stage==="idle") return `<div class="checkpoint"><b>Self-healing:</b> готовий • останнє відновлення ${ago(r.lastRecoveredAt)}</div>`;
  const cooldown=r.cooldownUntil>Date.now()?` • cooldown ${ago(Date.now()-(r.cooldownUntil-Date.now()))}`:"";
  return `<div class="checkpoint"><b>Self-healing:</b> ${esc(stage)}<br><small>${esc(r.reason||'')} • спроби ${Number(r.attempts||0)}${cooldown}${r.lastError?` • ${esc(r.lastError)}`:""}</small></div>`;
}
function discoveryBlock(p) {
  if (!p.chatDiscovery?.enabled) return "";
  const d=p.state.discovery||{};
  const candidate=d.candidateUrl ? `<div class="checkpoint"><b>Новий чат:</b> ${esc(d.candidateTitle||d.candidateUrl)}<br><small>${d.candidateEligible?'auto-eligible':'manual review'} • знайдено ${ago(d.candidateSeenAt)}</small></div>` : `<div class="checkpoint">Нові чати ще не знайдені.</div>`;
  return `${candidate}<div class="actions"><button data-id="${p.id}" data-action="scan_chats">⌕ Перевірити чати</button>${d.candidateUrl?`<button data-id="${p.id}" data-action="adopt_candidate" class="primary">↪ Переприв’язати</button>`:""}</div>`;
}
function card(p) {
  const [label,kind]=stateLabel(p); const paused=p.state.control.paused;
  const excerpt=p.state.runtime.latestAssistantExcerpt||"Ще немає checkpoint від активної вкладки.";
  return `<article class="card ${paused?'paused':''}"><div class="row"><div><div class="title">${esc(p.name)}</div><div class="state"><i class="dot ${kind}"></i>${esc(label)}</div></div><a href="${esc(p.chatUrl)}">Відкрити чат ↗</a></div><div class="meta"><div>Останній heartbeat<b>${ago(p.state.runtime.lastSeenAt)}</b></div><div>Останній прогрес<b>${ago(p.state.runtime.lastProgressAt)}</b></div><div>Plan anchor<b>${esc(p.planVersion||'v1')}</b></div><div>Watchdog<b>${p.watchdog?.alerted?'⚠ alert':'OK'}</b></div></div><div class="checkpoint">${esc(excerpt)}</div><div class="actions"><button data-id="${p.id}" data-action="${paused?'resume':'pause'}" class="${paused?'primary':''}">${paused?'▶ Відновити':'Ⅱ Пауза'}</button><button data-id="${p.id}" data-action="restart">↻ Вкладка</button><button data-id="${p.id}" data-action="rollover">＋ Новий чат</button></div>${checkpointBlock(p)}${recoveryBlock(p)}${discoveryBlock(p)}</article>`;
}
async function load() {
  try {
    const data=await api('./api/status');
    $('summary').textContent=`${data.projects.length} проєкти • ${new Date(data.generatedAt).toLocaleTimeString()}`;
    $('projects').innerHTML=data.projects.map(card).join(''); $('message').textContent='';
  } catch(e) { $('message').textContent=`Помилка: ${e.message}`; }
}
$('projects').addEventListener('click',async e=>{ const b=e.target.closest('button[data-action]'); if(!b)return; b.disabled=true; try{ await api(`./api/projects/${b.dataset.id}/action`,{method:'POST',body:JSON.stringify({action:b.dataset.action})}); tg?.HapticFeedback?.impactOccurred('medium'); await load(); }catch(err){$('message').textContent=`Помилка: ${err.message}`;}finally{b.disabled=false;} });
$('refresh').onclick=load;
$('restartService').onclick=async()=>{ if(!confirm('Перезапустити весь Autopilot supervisor?'))return; try{await api('./api/service/restart',{method:'POST',body:'{}'});$('message').textContent='Restart запущено…';}catch(e){$('message').textContent=e.message;} };
load(); setInterval(load,15000);
