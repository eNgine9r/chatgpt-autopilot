const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
const initData = tg?.initData || "";
const $ = (id) => document.getElementById(id);
const headers = () => ({ Authorization: `tma ${initData}`, "content-type": "application/json" });
const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const ago = (ms) => {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} с`;
  if (s < 3600) return `${Math.round(s / 60)} хв`;
  return `${Math.round(s / 3600)} год`;
};
const oneLine = (value, fallback="—") => String(value || fallback).replace(/\s+/g, " ").trim();
let currentFilter = "all";
let lastData = null;
const expandedProjects = new Set();

async function api(path, options={}) {
  const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}function projectStatus(p) {
  const runtime = p.state?.runtime || {};
  const paused = Boolean(p.state?.control?.paused);
  const online = p.worker?.online !== false;
  const status = String(runtime.status || "unknown");
  const generating = String(runtime.progressKey || "").includes("|generating|");
  const recoveryStage = p.state?.recovery?.stage || "idle";
  const attention = !online || /error|failed/i.test(status) || Boolean(p.watchdog?.alerted) || recoveryStage !== "idle";
  if (!online) return { label:"Offline", tone:"bad", paused, attention:true, active:false };
  if (attention) return { label:"Потрібна увага", tone:"bad", paused, attention:true, active:false };
  if (paused) return { label:"На паузі", tone:"warn", paused:true, attention:false, active:false };
  if (generating || ["working","assistant"].includes(status)) return { label:"Працює", tone:"info", paused:false, attention:false, active:true };
  return { label:"Готовий", tone:"ok", paused:false, attention:false, active:false };
}

function mirrorSummary(p) {
  const m = p.state?.mirrorSync || {};
  const labels = { never:"ще не було", started:"перевірка", same:"синхронно", blocked:"blocked", refresh:"refresh", timeout:"timeout", error:"помилка" };
  const tone = ["same","refresh"].includes(m.lastResult) ? "ok" : ["error","timeout","blocked"].includes(m.lastResult) ? "bad" : "warn";
  return { label: labels[m.lastResult || "never"] || m.lastResult, tone, state:m };
}

function checkpointSummary(p) {
  const c = p.state?.checkpoint || {};
  const verified = c.completionStatus === "complete_verified" || c.evidenceHealth?.ok;
  return { label:c.fingerprint ? `#${Number(c.revision || 0)}` : "—", tone:verified ? "ok" : c.fingerprint ? "warn" : "", state:c };
}function chip(label, value, tone="") {
  return `<span class="chip ${tone}">${esc(label)}<strong>${esc(value)}</strong></span>`;
}

function checkpointBlock(p) {
  if (!p.checkpointLedger?.enabled) return "";
  const c = p.state?.checkpoint || {};
  if (!c.fingerprint) return `<section class="detail-panel"><div class="detail-title">Checkpoint <span class="detail-meta">ще не отримано</span></div></section>`;
  const ev = c.evidenceHealth || {};
  const evidence = !ev.configured ? ["не налаштовано",""] : ev.ok ? ["verified","evidence-ok"] : [oneLine((ev.reasons || []).join(" • "), "pending"),"evidence-warn"];
  const blockers = (c.blockers || []).length ? esc(c.blockers.join(" • ")) : "Немає";
  return `<section class="detail-panel"><div class="detail-title">Checkpoint #${Number(c.revision || 0)} <span class="detail-meta">${esc(c.completionStatus || c.stage || "active")}</span></div><div class="kv-list"><div class="kv-row"><span>Ціль</span><b>${esc(c.goal || "—")}</b></div><div class="kv-row"><span>Поточна</span><b>${esc(c.currentTask || "—")}</b></div><div class="kv-row"><span>Далі</span><b>${esc(c.nextAction || "—")}</b></div><div class="kv-row"><span>Evidence</span><b class="${evidence[1]}">${esc(evidence[0])}</b></div><div class="kv-row"><span>Blockers</span><b>${blockers}</b></div></div></section>`;
}

function recoveryBlock(p) {
  if (!p.browserRecovery?.enabled) return "";
  const r = p.state?.recovery || {};
  const stage = r.stage || "idle";
  const tone = stage === "idle" ? "evidence-ok" : "evidence-warn";
  return `<section class="detail-panel"><div class="detail-title">Self-healing <span class="detail-meta ${tone}">${stage === "idle" ? "готовий" : esc(stage)}</span></div><div class="kv-list"><div class="kv-row"><span>Відновлення</span><b>${ago(r.lastRecoveredAt)}</b></div><div class="kv-row"><span>Спроби</span><b>${Number(r.attempts || 0)}</b></div>${r.lastError ? `<div class="kv-row"><span>Помилка</span><b class="evidence-bad">${esc(r.lastError)}</b></div>` : ""}</div></section>`;
}function mirrorBlock(p) {
  if (!p.browserRecovery?.enabled) return "";
  const m = p.state?.mirrorSync || {};
  const info = mirrorSummary(p);
  const tone = info.tone === "ok" ? "evidence-ok" : info.tone === "bad" ? "evidence-bad" : "evidence-warn";
  return `<section class="detail-panel"><div class="detail-title">Mirror sync: <span class="detail-meta ${tone}">${esc(info.label)}</span></div><div class="kv-list"><div class="kv-row"><span>Перевірка</span><b>${ago(m.lastProbeAt)}</b></div><div class="kv-row"><span>Refresh</span><b>${ago(m.lastRefreshAt)}</b></div>${m.lastError ? `<div class="kv-row"><span>Помилка</span><b class="evidence-bad">${esc(m.lastError)}</b></div>` : ""}</div></section>`;
}

function discoveryBlock(p) {
  if (!p.chatDiscovery?.enabled) return "";
  const d = p.state?.discovery || {};
  const candidate = d.candidateUrl
    ? `<div class="kv-list"><div class="kv-row"><span>Кандидат</span><b>${esc(d.candidateTitle || d.candidateUrl)}</b></div><div class="kv-row"><span>Режим</span><b>${d.candidateEligible ? "auto-eligible" : "manual review"}</b></div><div class="kv-row"><span>Знайдено</span><b>${ago(d.candidateSeenAt)}</b></div></div>`
    : `<p class="detail-text">Новіші чати цього Project не знайдені.</p>`;
  const adopt = d.candidateUrl ? `<button data-id="${esc(p.id)}" data-action="adopt_candidate" class="primary">Переприв’язати</button>` : "";
  return `<section class="detail-panel"><div class="detail-title">Чати <span class="detail-meta">same Project only</span></div>${candidate}<div class="detail-actions"><button data-id="${esc(p.id)}" data-action="scan_chats">Перевірити чати</button>${adopt}</div></section>`;
}

function technicalActions(p, online) {
  const disabled = online ? "" : " disabled";
  return `<section class="detail-panel"><div class="detail-title">Технічні дії <span class="detail-meta">advanced</span></div><div class="detail-actions"><button data-id="${esc(p.id)}" data-action="restart"${disabled}>Оновити вкладку</button><button data-id="${esc(p.id)}" data-action="rollover" class="danger-lite"${disabled}>Новий чат</button></div></section>`;
}function projectTask(p) {
  const c = p.state?.checkpoint || {};
  return oneLine(c.currentTask || p.state?.runtime?.latestAssistantExcerpt, "Немає активної задачі");
}

function card(p) {
  const status = projectStatus(p);
  const checkpoint = checkpointSummary(p);
  const mirror = mirrorSummary(p);
  const online = p.worker?.online !== false;
  const runtime = p.state?.runtime || {};
  const workerName = p.worker?.name || p.worker?.id || "worker unavailable";
  const open = expandedProjects.has(p.id) ? " open" : "";
  const disabled = online ? "" : " disabled";
  const primaryAction = status.paused ? "resume" : "pause";
  const primaryLabel = status.paused ? "▶ Відновити" : "Ⅱ Пауза";
  const chatLink = p.chatUrl ? `<a class="chat-link" href="${esc(p.chatUrl)}">Чат ↗</a>` : `<span class="chat-link">Без чату</span>`;
  return `<article class="project-card" data-project="${esc(p.id)}"><div class="card-main"><div class="card-head"><div class="project-heading"><h2 class="project-name">${esc(p.name)}</h2><div class="worker-line">Worker: ${esc(workerName)} · ${online ? "online" : "offline"}</div></div><span class="status-pill ${status.tone}">${esc(status.label)}</span></div><div class="chip-row">${chip("HB",ago(runtime.lastSeenAt),online?"ok":"bad")}${chip("CP",checkpoint.label,checkpoint.tone)}${chip("Mirror",mirror.label,mirror.tone)}${chip("Plan",String(p.planVersion || "v1").replace(/^2026-/,""))}</div><div class="task-box"><span class="task-label">Поточна задача</span><p class="task-text">${esc(projectTask(p))}</p></div><div class="primary-actions"><button data-id="${esc(p.id)}" data-action="${primaryAction}" class="action-button primary"${disabled}>${primaryLabel}</button>${chatLink}</div></div><details class="project-details" data-project-id="${esc(p.id)}"${open}><summary>Технічні деталі</summary><div class="details-body"><section class="detail-panel"><div class="detail-title">Остання відповідь <span class="detail-meta">прогрес ${ago(runtime.lastProgressAt)}</span></div><p class="detail-text">${esc(runtime.latestAssistantExcerpt || "Ще немає даних від активної вкладки.")}</p></section>${checkpointBlock(p)}${recoveryBlock(p)}${mirrorBlock(p)}${discoveryBlock(p)}${technicalActions(p,online)}</div></details></article>`;
}

function matchesFilter(p) {
  const s = projectStatus(p);
  if (currentFilter === "active") return s.active;
  if (currentFilter === "paused") return s.paused;
  if (currentFilter === "attention") return s.attention;
  return true;
}function renderOverview(data) {
  const projects = data.projects || [];
  const stats = projects.reduce((acc,p)=>{
    const s = projectStatus(p);
    if (p.worker?.online !== false) acc.online += 1;
    if (s.active) acc.active += 1;
    if (s.paused) acc.paused += 1;
    if (s.attention) acc.attention += 1;
    return acc;
  }, { online:0, active:0, paused:0, attention:0 });
  $("overview").innerHTML = `<div class="metric"><span class="metric-value">${stats.online}/${projects.length}</span><span class="metric-label">Online</span></div><div class="metric"><span class="metric-value">${stats.active}</span><span class="metric-label">Активні</span></div><div class="metric"><span class="metric-value">${stats.paused}</span><span class="metric-label">На паузі</span></div><div class="metric ${stats.attention ? "attention" : ""}"><span class="metric-value">${stats.attention}</span><span class="metric-label">Потребують уваги</span></div>`;
}

function renderProjects(data) {
  const filtered = (data.projects || []).filter(matchesFilter);
  $("projects").innerHTML = filtered.length ? filtered.map(card).join("") : `<div class="empty-state">У цьому фільтрі немає проєктів.</div>`;
}

function render(data) {
  lastData = data;
  renderOverview(data);
  renderProjects(data);
  const workers = data.workers || [];
  const onlineWorkers = workers.filter(w => w.online).length;
  $("workersStatus").textContent = `${onlineWorkers}/${workers.length} workers online · safe restart залишає проєкти на паузі.`;
  $("updated").textContent = `${(data.projects || []).length} проєкти · ${onlineWorkers}/${workers.length} workers · ${new Date(data.generatedAt).toLocaleTimeString("uk-UA",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}`;
}function showMessage(text) {
  $("message").textContent = text || "";
}

async function load() {
  $("refresh").disabled = true;
  try {
    const data = await api("./api/status");
    render(data);
    showMessage("");
  } catch (error) {
    showMessage(`Помилка: ${error.message}`);
  } finally {
    $("refresh").disabled = false;
  }
}

$("filters").addEventListener("click", event => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  currentFilter = button.dataset.filter;
  $("filters").querySelectorAll(".filter").forEach(item => item.classList.toggle("active", item === button));
  if (lastData) renderProjects(lastData);
  tg?.HapticFeedback?.selectionChanged?.();
});

$("projects").addEventListener("toggle", event => {
  const details = event.target.closest?.("details[data-project-id]");
  if (!details) return;
  if (details.open) expandedProjects.add(details.dataset.projectId);
  else expandedProjects.delete(details.dataset.projectId);
}, true);$("projects").addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  button.disabled = true;
  try {
    await api(`./api/projects/${button.dataset.id}/action`, { method:"POST", body:JSON.stringify({ action:button.dataset.action }) });
    tg?.HapticFeedback?.impactOccurred?.("medium");
    await load();
  } catch (error) {
    showMessage(`Помилка: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

$("refresh").onclick = () => load();
$("restartService").onclick = async () => {
  if (!confirm("Безпечно перезапустити всі Autopilot workers? Проєкти будуть поставлені на паузу й залишаться paused після restart.")) return;
  const button = $("restartService");
  button.disabled = true;
  try {
    const result = await api("./api/service/restart", { method:"POST", body:"{}" });
    showMessage(result.projectsRemainPaused ? "Workers перезапущено. Проєкти залишені на паузі." : "Restart запущено…");
    await load();
  } catch (error) {
    showMessage(`Помилка: ${error.message}`);
  } finally {
    button.disabled = false;
  }
};

load();
setInterval(load, 15000);