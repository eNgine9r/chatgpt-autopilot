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
const cleanPreview = (value, fallback="Ще немає даних від активної вкладки.") => String(value || fallback)
  .replace(/^\s{0,3}#{1,6}\s+/gm, "")
  .replace(/\*\*(.*?)\*\*/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/^\s*[-*]\s+/gm, "• ")
  .trim();
const pluralUk = (n, one, few, many) => {
  const x = Math.abs(Number(n || 0)) % 100;
  const y = x % 10;
  if (x > 10 && x < 20) return many;
  if (y === 1) return one;
  if (y >= 2 && y <= 4) return few;
  return many;
};
const completionLabel = (value) => ({
  active:"активна",
  complete:"завершена",
  complete_verified:"підтверджена",
  complete_pending_evidence:"очікує доказів",
  blocked:"заблокована"
}[String(value || "")] || oneLine(value, "активна"));

const money = (value) => `$${Number(value || 0).toFixed(Number(value || 0) < 10 ? 2 : 0)}`;
const compactNumber = (value) => new Intl.NumberFormat("uk-UA", { notation:"compact", maximumFractionDigits:1 }).format(Number(value || 0));
const percent = (value) => `${Number(value || 0).toFixed(0)}%`;
const aiProject = (id) => (lastData?.browserless?.projects || []).find((item) => item.id === id) || null;
const aiDecisionLabel = (value) => ({ continue:"продовжує", wait:"очікує", user_action_required:"дія користувача", escalation_required:"потрібна увага" }[String(value || "")] || oneLine(value, "очікує"));
let currentFilter = "all";
let lastData = null;
const expandedProjects = new Set();

async function api(path, options={}) {
  const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}function projectStatus(p) {
  const ai = aiProject(p.id);
  const browserless = lastData?.browserless;
  if (browserless) {
    if (!browserless.available) return { label:"AI недоступний", tone:"bad", paused:false, attention:true, active:false };
    if (!ai) return { label:"Немає AI-стану", tone:"bad", paused:false, attention:true, active:false };
    const serviceOnline = browserless.service?.online !== false;
    const latest = ai.latestJob || {};
    const cp = ai.checkpoint || {};
    const queued = Number(ai.jobs?.pending || 0) + Number(ai.jobs?.running || 0);
    const blockers = Array.isArray(cp.blockers) ? cp.blockers.length : 0;
    const attentionDecision = ["user_action_required","escalation_required"].includes(latest.decision);
    if (!serviceOnline) return { label:"AI офлайн", tone:"bad", paused:false, attention:true, active:false };
    if (latest.status === "blocked" || blockers) return { label:"Потрібна увага", tone:"bad", paused:false, attention:true, active:false };
    if (attentionDecision) return { label:"Потрібна дія", tone:"warn", paused:false, attention:true, active:false };
    if (queued || ["pending","running"].includes(latest.status)) return { label:"Обробка", tone:"info", paused:false, attention:false, active:true };
    if (["complete","complete_verified"].includes(cp.stage)) return { label:"Завершено", tone:"ok", paused:false, attention:false, active:false };
    return { label:"Очікує події", tone:"ok", paused:false, attention:false, active:false };
  }
  const runtime = p.state?.runtime || {};
  const paused = Boolean(p.state?.control?.paused);
  const online = p.worker?.online !== false;
  const status = String(runtime.status || "unknown");
  const generating = String(runtime.progressKey || "").includes("|generating|");
  const recoveryStage = p.state?.recovery?.stage || "idle";
  const attention = !online || /error|failed/i.test(status) || Boolean(p.watchdog?.alerted) || recoveryStage !== "idle";
  if (!online) return { label:"Офлайн", tone:"bad", paused, attention:true, active:false };
  if (attention) return { label:"Потрібна увага", tone:"bad", paused, attention:true, active:false };
  if (paused) return { label:"На паузі", tone:"warn", paused:true, attention:false, active:false };
  if (generating || ["working","assistant"].includes(status)) return { label:"Працює", tone:"info", paused:false, attention:false, active:true };
  return { label:"Готовий", tone:"ok", paused:false, attention:false, active:false };
}

function mirrorSummary(p) {
  const m = p.state?.mirrorSync || {};
  const labels = { never:"ще не було", started:"перевірка", same:"синхронно", blocked:"заблоковано", refresh:"оновлено", timeout:"тайм-аут", error:"помилка" };
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

function browserlessProjectBlock(ai) {
  if (!ai) return "";
  const cp = ai.checkpoint || {};
  const latest = ai.latestJob || {};
  const usage = ai.usageMonth || {};
  const queue = Number(ai.jobs?.pending || 0) + Number(ai.jobs?.running || 0);
  const blockers = (cp.blockers || []).length ? cp.blockers.join(" • ") : "Немає";
  return `<section class="detail-panel ai-project-panel"><div class="detail-title">AI-автопілот <span class="detail-meta">${esc(aiDecisionLabel(latest.decision))}</span></div><div class="kv-list"><div class="kv-row kv-stack"><span>Поточна задача</span><b>${esc(cp.currentTask || "Очікує нової матеріальної події")}</b></div><div class="kv-row kv-stack"><span>Наступний крок</span><b>${esc(cp.nextAction || "—")}</b></div><div class="kv-row"><span>Job</span><b>${esc(latest.status || "—")} · ${queue} активних</b></div><div class="kv-row"><span>Luna за місяць</span><b>${Number(usage.calls || 0)} · ${money(usage.costUsd)}</b></div><div class="kv-row kv-stack"><span>Перешкоди</span><b>${esc(blockers)}</b></div></div></section>`;
}

function checkpointBlock(p) {
  if (!p.checkpointLedger?.enabled) return "";
  const c = p.state?.checkpoint || {};
  if (!c.fingerprint) return `<section class="detail-panel checkpoint-panel"><div class="detail-title">Контрольна точка <span class="detail-meta">ще не отримано</span></div></section>`;
  const ev = c.evidenceHealth || {};
  const evidence = !ev.configured ? ["не налаштовано",""] : ev.ok ? ["підтверджено","evidence-ok"] : [oneLine((ev.reasons || []).join(" • "), "очікує"),"evidence-warn"];
  const blockers = (c.blockers || []).length ? esc(c.blockers.join(" • ")) : "Немає";
  return `<section class="detail-panel checkpoint-panel"><div class="detail-title">Контрольна точка #${Number(c.revision || 0)} <span class="detail-meta">${esc(completionLabel(c.completionStatus || c.stage))}</span></div><div class="kv-list"><div class="kv-row kv-stack"><span>Ціль</span><b>${esc(c.goal || "—")}</b></div><div class="kv-row kv-stack"><span>Поточна задача</span><b>${esc(c.currentTask || "—")}</b></div><div class="kv-row kv-stack"><span>Наступний крок</span><b>${esc(c.nextAction || "—")}</b></div><div class="kv-row"><span>Докази</span><b class="${evidence[1]}">${esc(evidence[0])}</b></div><div class="kv-row kv-stack"><span>Перешкоди</span><b>${blockers}</b></div></div></section>`;
}

function recoveryBlock(p) {
  if (!p.browserRecovery?.enabled) return "";
  const r = p.state?.recovery || {};
  const stage = r.stage || "idle";
  const tone = stage === "idle" ? "evidence-ok" : "evidence-warn";
  return `<section class="detail-panel"><div class="detail-title">Самовідновлення <span class="detail-meta ${tone}">${stage === "idle" ? "готовий" : esc(stage)}</span></div><div class="kv-list"><div class="kv-row"><span>Відновлення</span><b>${ago(r.lastRecoveredAt)}</b></div><div class="kv-row"><span>Спроби</span><b>${Number(r.attempts || 0)}</b></div>${r.lastError ? `<div class="kv-row"><span>Помилка</span><b class="evidence-bad">${esc(r.lastError)}</b></div>` : ""}</div></section>`;
}function mirrorBlock(p) {
  if (!p.browserRecovery?.enabled) return "";
  const m = p.state?.mirrorSync || {};
  const info = mirrorSummary(p);
  const tone = info.tone === "ok" ? "evidence-ok" : info.tone === "bad" ? "evidence-bad" : "evidence-warn";
  return `<section class="detail-panel"><div class="detail-title">Синхронізація <span class="detail-meta ${tone}">${esc(info.label)}</span></div><div class="kv-list"><div class="kv-row"><span>Перевірка</span><b>${ago(m.lastProbeAt)}</b></div><div class="kv-row"><span>Оновлення</span><b>${ago(m.lastRefreshAt)}</b></div>${m.lastError ? `<div class="kv-row"><span>Помилка</span><b class="evidence-bad">${esc(m.lastError)}</b></div>` : ""}</div></section>`;
}

function discoveryBlock(p) {
  if (!p.chatDiscovery?.enabled) return "";
  const d = p.state?.discovery || {};
  const candidate = d.candidateUrl
    ? `<div class="kv-list"><div class="kv-row"><span>Кандидат</span><b>${esc(d.candidateTitle || d.candidateUrl)}</b></div><div class="kv-row"><span>Режим</span><b>${d.candidateEligible ? "автоматично" : "ручна перевірка"}</b></div><div class="kv-row"><span>Знайдено</span><b>${ago(d.candidateSeenAt)}</b></div></div>`
    : `<p class="detail-text">Новіші чати цього проєкту не знайдені.</p>`;
  const adopt = d.candidateUrl ? `<button data-id="${esc(p.id)}" data-action="adopt_candidate" class="primary">Переприв’язати</button>` : "";
  return `<section class="detail-panel"><div class="detail-title">Чати <span class="detail-meta">лише цей проєкт</span></div>${candidate}<div class="detail-actions"><button data-id="${esc(p.id)}" data-action="scan_chats">Перевірити чати</button>${adopt}</div></section>`;
}

function technicalActions(p, online, forceDisabled=false) {
  const disabled = online && !forceDisabled ? "" : " disabled";
  return `<section class="detail-panel"><div class="detail-title">Резервний Chromium <span class="detail-meta">окреме підтвердження</span></div><div class="detail-actions"><button data-id="${esc(p.id)}" data-action="restart"${disabled}>Оновити вкладку</button><button data-id="${esc(p.id)}" data-action="rollover" class="danger-lite"${disabled}>Новий чат</button></div></section>`;
}function projectTask(p) {
  const ai = aiProject(p.id);
  if (lastData?.browserless?.available && ai) return oneLine(ai.checkpoint?.currentTask || ai.checkpoint?.nextAction, "Очікує нової матеріальної події");
  const c = p.state?.checkpoint || {};
  return oneLine(c.currentTask || p.state?.runtime?.latestAssistantExcerpt, "Немає активної задачі");
}

function card(p) {
  const status = projectStatus(p);
  const ai = aiProject(p.id);
  const browserlessMode = Boolean(lastData?.browserless);
  const browserlessActive = Boolean(browserlessMode && lastData.browserless.available && ai);
  const checkpoint = checkpointSummary(p);
  const mirror = mirrorSummary(p);
  const online = p.worker?.online !== false;
  const runtime = p.state?.runtime || {};
  const workerName = p.worker?.name || p.worker?.id || "воркер недоступний";
  const open = expandedProjects.has(p.id) ? " open" : "";
  const disabled = online ? "" : " disabled";
  const chatLink = p.chatUrl ? `<a class="chat-link" href="${esc(p.chatUrl)}">Чат ↗</a>` : `<span class="chat-link">Без чату</span>`;
  let subtitle; let chips; let actions; let details;
  if (browserlessMode) {
    const latest = ai?.latestJob || {};
    const aiTone = status.tone === "bad" ? "bad" : status.tone === "warn" ? "warn" : "ok";
    subtitle = browserlessActive
      ? `AI: Browserless · Luna · ${lastData.browserless.service?.online ? "онлайн" : "офлайн"}`
      : "AI: Browserless · телеметрія недоступна";
    chips = ai
      ? `${chip("AI",aiDecisionLabel(latest.decision),aiTone)}${chip("Luna",`${Number(ai.usageMonth?.calls || 0)} викл.`)}${chip("КТ",completionLabel(ai.checkpoint?.stage || "active"))}${chip("План",String(ai.planVersion || p.planVersion || "v1").replace(/^2026-/,""))}`
      : `${chip("AI","недоступно","bad")}${chip("План",String(p.planVersion || "v1").replace(/^2026-/,""))}`;
    actions = `<div class="primary-actions ai-primary"><span class="mode-badge">Подієвий режим</span>${chatLink}</div>`;
    details = `${browserlessProjectBlock(ai)}${technicalActions(p,online,true)}`;
  } else {
    subtitle = `Воркер: ${workerName} · ${online ? "онлайн" : "офлайн"}`;
    chips = `${chip("Пульс",ago(runtime.lastSeenAt),online?"ok":"bad")}${chip("КТ",checkpoint.label,checkpoint.tone)}${chip("Синхр.",mirror.label,mirror.tone)}${chip("План",String(p.planVersion || "v1").replace(/^2026-/,""))}`;
    const primaryAction = status.paused ? "resume" : "pause";
    const primaryLabel = status.paused ? "▶ Відновити" : "Ⅱ Пауза";
    actions = `<div class="primary-actions"><button data-id="${esc(p.id)}" data-action="${primaryAction}" class="action-button primary"${disabled}>${primaryLabel}</button>${chatLink}</div>`;
    details = `<section class="detail-panel"><div class="detail-title">Остання відповідь <span class="detail-meta">прогрес ${ago(runtime.lastProgressAt)}</span></div><p class="detail-text">${esc(cleanPreview(runtime.latestAssistantExcerpt))}</p></section>${checkpointBlock(p)}${recoveryBlock(p)}${mirrorBlock(p)}${discoveryBlock(p)}${technicalActions(p,online)}`;
  }
  return `<article class="project-card" data-project="${esc(p.id)}"><div class="card-main"><div class="card-head"><div class="project-heading"><h2 class="project-name">${esc(p.name)}</h2><div class="worker-line">${esc(subtitle)}</div></div><span class="status-pill ${status.tone}">${esc(status.label)}</span></div><div class="chip-row">${chips}</div><div class="task-box"><span class="task-label">Поточна задача</span><p class="task-text">${esc(projectTask(p))}</p></div>${actions}</div><details class="project-details" data-project-id="${esc(p.id)}"${open}><summary>Технічні деталі</summary><div class="details-body">${details}</div></details></article>`;
}

function matchesFilter(p) {
  const s = projectStatus(p);
  if (currentFilter === "active") return s.active;
  if (currentFilter === "paused") return s.paused;
  if (currentFilter === "attention") return s.attention;
  return true;
}function renderBrowserless(data) {
  const root = $("browserless");
  const b = data.browserless;
  if (!b) { root.hidden = true; return; }
  root.hidden = false;
  if (!b.available) {
    root.innerHTML = `<div class="ai-card-head"><div><span class="section-kicker">AI-АВТОПІЛОТ</span><h2>Browserless + Luna</h2><p>Телеметрія тимчасово недоступна.</p></div><span class="status-pill bad">Недоступно</span></div>`;
    return;
  }
  const q = b.queue || {}; const month = b.usage?.month || {}; const budget = b.budget || {}; const activity = b.activity || {};
  const activeJobs = Number(q.jobsPending || 0) + Number(q.jobsRunning || 0);
  const activeEvents = Number(q.eventsPending || 0) + Number(q.eventsQueued || 0);
  const activeActions = Number(q.actionsPlanned || 0) + Number(q.actionsRunning || 0);
  const online = b.service?.online !== false;
  const hardPct = Math.min(100, Math.max(0, Number(budget.hardUtilizationPct || 0)));
  const queueTone = activeJobs || activeEvents || activeActions ? "info" : "ok";
  root.innerHTML = `<div class="ai-card-head"><div><span class="section-kicker">AI-АВТОПІЛОТ</span><h2>Browserless + Luna</h2><p>Подієвий режим · без Chromium polling · остання подія ${ago(activity.lastEventAt)}</p></div><span class="status-pill ${online ? "ok" : "bad"}">${online ? "Онлайн" : "Офлайн"}</span></div><div class="budget-head"><div><span class="budget-value">${money(budget.monthCostUsd)}</span><span class="budget-label">за місяць · ціль ${money(budget.targetMonthlyUsd)} · hard ${money(budget.hardMonthlyUsd)}</span></div><span class="budget-remaining">залишок ${money(budget.remainingHardUsd)}</span></div><div class="budget-track"><span style="width:${hardPct.toFixed(2)}%"></span></div><div class="ai-metrics"><div class="ai-metric"><strong>${Number(month.calls || 0)}</strong><span>Luna виклики</span></div><div class="ai-metric"><strong>${compactNumber(month.inputTokens)}</strong><span>Вхідні токени</span></div><div class="ai-metric"><strong>${compactNumber(month.cachedInputTokens)}</strong><span>Кеш · ${percent(b.usage?.cacheRatioPct)}</span></div><div class="ai-metric"><strong>${compactNumber(month.outputTokens)}</strong><span>Вихідні токени</span></div><div class="ai-metric ${activeJobs ? "attention" : ""}"><strong>${activeJobs}</strong><span>Активні jobs</span></div><div class="ai-metric"><strong>${Number(activity.eventsToday || 0)}</strong><span>Події сьогодні</span></div></div><div class="ai-foot"><span class="chip ${queueTone}">Черга<strong>${activeEvents} подій · ${activeJobs} jobs · ${activeActions} дій</strong></span><span class="ai-last">Luna ${ago(activity.lastUsageAt)}</span></div>`;
}

function renderOverview(data) {
  const projects = data.projects || [];
  const aiProjectIds = new Set((data.browserless?.projects || []).map(item => item.id));
  const aiOnline = Boolean(data.browserless?.available && data.browserless?.service?.online !== false);
  const stats = projects.reduce((acc,p)=>{
    const s = projectStatus(p);
    if (data.browserless ? (aiOnline && aiProjectIds.has(p.id)) : p.worker?.online !== false) acc.online += 1;
    if (s.active) acc.active += 1;
    if (s.paused) acc.paused += 1;
    if (s.attention) acc.attention += 1;
    return acc;
  }, { online:0, active:0, paused:0, attention:0 });
  $("overview").innerHTML = `<div class="metric"><span class="metric-value">${stats.online}/${projects.length}</span><span class="metric-label">Онлайн</span></div><div class="metric"><span class="metric-value">${stats.active}</span><span class="metric-label">Активні</span></div><div class="metric"><span class="metric-value">${stats.paused}</span><span class="metric-label">На паузі</span></div><div class="metric ${stats.attention ? "attention" : ""}"><span class="metric-value">${stats.attention}</span><span class="metric-label">Потребують уваги</span></div>`;
}

function renderProjects(data) {
  const filtered = (data.projects || []).filter(matchesFilter);
  $("projects").innerHTML = filtered.length ? filtered.map(card).join("") : `<div class="empty-state">У цьому фільтрі немає проєктів.</div>`;
}

function render(data) {
  lastData = data;
  renderOverview(data);
  renderBrowserless(data);
  renderProjects(data);
  const workers = data.workers || [];
  const onlineWorkers = workers.filter(w => w.online).length;
  const browserlessMode = Boolean(data.browserless);
  const browserlessActive = Boolean(data.browserless?.available && data.browserless?.service?.online);
  if (browserlessMode) {
    $("workersStatus").textContent = browserlessActive
      ? `Резервний Chromium: ${onlineWorkers}/${workers.length} онлайн · production працює через Browserless. Резерв потребує окремого підтвердження.`
      : "Browserless потребує уваги. Резервний Chromium заблоковано до окремого підтвердження.";
    $("restartService").disabled = true;
    $("restartService").textContent = "Резервний Chromium вимкнено";
  } else {
    $("workersStatus").textContent = `${onlineWorkers}/${workers.length} ${pluralUk(workers.length,"воркер","воркери","воркерів")} онлайн · резервний режим.`;
    $("restartService").disabled = false;
    $("restartService").textContent = "Перезапустити резервні воркери";
  }
  const projectCount = (data.projects || []).length;
  const runtimeLabel = browserlessMode ? `Browserless ${browserlessActive ? "онлайн" : "потребує уваги"}` : `${onlineWorkers}/${workers.length} воркерів`;
  $("updated").textContent = `${projectCount} ${pluralUk(projectCount,"проєкт","проєкти","проєктів")} · ${runtimeLabel} · ${new Date(data.generatedAt).toLocaleTimeString("uk-UA",{hour:"2-digit",minute:"2-digit",second:"2-digit"})}`;
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
  if (!confirm("Перезапустити всі воркери Autopilot? Проєкти буде безпечно поставлено на паузу, і після перезапуску вони залишаться на паузі.")) return;
  const button = $("restartService");
  button.disabled = true;
  try {
    const result = await api("./api/service/restart", { method:"POST", body:"{}" });
    showMessage(result.projectsRemainPaused ? "Воркери перезапущено. Проєкти залишено на паузі." : "Перезапуск запущено…");
    await load();
  } catch (error) {
    showMessage(`Помилка: ${error.message}`);
  } finally {
    button.disabled = false;
  }
};

load();
setInterval(load, 15000);