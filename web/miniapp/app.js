const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const initData = tg?.initData || '';
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>\"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
}[c]));

function headers() {
  return { Authorization: `tma ${initData}`, 'content-type': 'application/json' };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...headers(), ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function ago(ms) {
  if (!ms) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds} с`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} хв`;
  return `${Math.round(seconds / 3600)} год`;
}
const statusInfo = {
  idle: ['Очікує', 'ok'],
  ready: ['Готовий', 'info'],
  running: ['Працює', 'info'],
  waiting_approval: ['Потрібне підтвердження', 'warn'],
  blocked: ['Заблоковано', 'bad'],
  paused: ['Пауза', 'warn'],
  complete: ['Завершено', 'ok'],
};

function status(project) {
  const [label, tone] = statusInfo[project.status] || [project.status || 'Невідомо', 'bad'];
  return { label, tone };
}

function chip(label, value, tone = '') {
  return `<span class="chip ${tone}">${esc(label)}<strong>${esc(value)}</strong></span>`;
}

function renderOverview(data) {
  const attention = (data.projects || []).filter((p) => ['waiting_approval', 'blocked'].includes(p.status)).length;
  $('overview').innerHTML = [
    ['Проєкти', (data.projects || []).length, ''],
    ['Потрібна дія', attention, attention ? 'attention' : ''],
    ['GitHub', data.githubWebhook?.online ? 'OK' : 'OFF', data.githubWebhook?.online ? '' : 'attention'],
    ['AI calls', Number(data.aiCalls || 0), Number(data.aiCalls || 0) ? 'attention' : ''],
  ].map(([label, value, tone]) => `<div class="metric ${tone}"><span class="metric-value">${esc(value)}</span><span class="metric-label">${esc(label)}</span></div>`).join('');
}
function renderServices(data) {
  const github = data.githubWebhook?.online ? ['Онлайн', 'ok'] : ['Офлайн', 'bad'];
  const telegram = data.telegramBridge?.online ? ['Онлайн', 'ok'] : ['Офлайн', 'bad'];
  $('services').innerHTML = `
    <div class="ai-card-head">
      <div>
        <span class="section-kicker">V3 INFRASTRUCTURE</span>
        <h2>Deterministic control plane</h2>
        <p>Mini App → захищений listener → локальний v3 control API. Порт 8780 не публікується.</p>
      </div>
      <span class="status-pill ok">AI 0</span>
    </div>
    <div class="chip-row">
      ${chip('GitHub webhook', github[0], github[1])}
      ${chip('Telegram bridge', telegram[0], telegram[1])}
      ${chip('Control API', 'local-only', 'ok')}
      ${chip('AI calls', String(Number(data.aiCalls || 0)), Number(data.aiCalls || 0) ? 'bad' : 'ok')}
    </div>`;
}

function projectCard(project) {
  const s = status(project);
  const action = project.canApprove
    ? `<button class="action-button primary" data-project="${esc(project.id)}" data-action="approve">Підтвердити</button>`
    : project.canRetry
      ? `<button class="action-button primary" data-project="${esc(project.id)}" data-action="retry">Retry</button>`
      : `<button class="action-button secondary" disabled>Дія не потрібна</button>`;
  const taskLink = project.taskUrl
    ? `<a class="chat-link" href="${esc(project.taskUrl)}" target="_blank" rel="noreferrer">GitHub ↗</a>`
    : '';
  return `<article class="project-card">
    <div class="card-main">
      <div class="card-head">
        <div class="project-heading">
          <h2 class="project-name">${esc(project.name)}</h2>
          <div class="worker-line">Autopilot v3 · ${esc(project.id)}</div>
        </div>
        <span class="status-pill ${s.tone}">${esc(s.label)}</span>
      </div>
      <div class="task-box">
        <span class="task-label">Поточна задача</span>
        <p class="task-text">${esc(project.currentTask)}</p>
      </div>
      <div class="chip-row">
        ${chip('State', project.status, s.tone)}
        ${chip('Step', project.stepId || '—')}
        ${chip('Оновлено', ago(project.updatedAt))}
      </div>
      <div class="primary-actions">${action}${taskLink}</div>
    </div>
    ${project.lastError ? `<div class="details-body"><section class="detail-panel"><div class="detail-title">Помилка</div><p class="detail-text evidence-bad">${esc(project.lastError)}</p></section></div>` : ''}
  </article>`;
}
function render(data) {
  renderOverview(data);
  renderServices(data);
  $('projects').innerHTML = (data.projects || []).map(projectCard).join('') || '<div class="empty-state">Немає v3-проєктів.</div>';
  $('updated').textContent = `v3 · ${new Date(data.generatedAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function showMessage(text) {
  $('message').textContent = text || '';
}

async function load() {
  $('refresh').disabled = true;
  try {
    render(await api('./api/status'));
    showMessage('');
  } catch (error) {
    showMessage(`Помилка: ${error.message}`);
  } finally {
    $('refresh').disabled = false;
  }
}

$('projects').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const projectId = button.dataset.project;
  if (action === 'approve' && !confirm('Підтвердити поточний крок Autopilot v3?')) return;
  button.disabled = true;
  try {
    await api(`./api/projects/${encodeURIComponent(projectId)}/${action}`, {
      method: 'POST',
      body: '{}',
    });
    tg?.HapticFeedback?.impactOccurred?.('medium');
    showMessage(action === 'approve' ? 'Підтвердження прийнято.' : 'Retry запущено.');
    await load();
  } catch (error) {
    showMessage(`Помилка: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

$('refresh').onclick = () => load();
load();
setInterval(load, 15000);
