const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const initData = tg?.initData || '';
const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>\"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
}[c]));

let currentView = sessionStorage.getItem('project-control-view') || 'overview';
let lastPayload = null;

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
  const seconds = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (seconds < 10) return 'щойно';
  if (seconds < 60) return `${seconds} с тому`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} хв тому`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} год тому`;
  return `${Math.round(seconds / 86400)} дн тому`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} ГБ`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} МБ`;
  return `${Math.round(value / 1024)} КБ`;
}

function formatUptime(seconds) {
  const value = Number(seconds || 0);
  if (!value) return '—';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  if (days) return `${days} д ${hours} год`;
  const minutes = Math.floor((value % 3600) / 60);
  return hours ? `${hours} год ${minutes} хв` : `${minutes} хв`;
}

function formatLoad(load) {
  if (!Array.isArray(load) || !load.length) return '—';
  return load.slice(0, 3).map((item) => Number(item).toFixed(2)).join(' · ');
}

const projectStatus = {
  idle: ['Очікує', 'ok'],
  ready: ['Готовий', 'info'],
  running: ['Працює', 'info'],
  waiting_approval: ['Потрібне підтвердження', 'warn'],
  blocked: ['Заблоковано', 'bad'],
  paused: ['Пауза', 'warn'],
  complete: ['Завершено', 'ok'],
};

const commanderStatus = {
  operational: ['Працює штатно', 'ok'],
  degraded: ['Частково доступний', 'warn'],
  offline: ['Недоступний', 'bad'],
};

const automationStatus = {
  active: ['Активний', 'info'],
  attention: ['Потрібна увага', 'bad'],
  paused: ['Призупинено', 'warn'],
  idle: ['Очікує', 'warn'],
};

const operationNames = {
  'terminal.exec': 'Команда в терміналі',
  'device.health': 'Перевірка пристрою',
  'file.read': 'Читання файлу',
  'file.write': 'Запис файлу',
  'file.edit': 'Редагування файлу',
  'file.delete': 'Видалення файлу',
  'service.status': 'Стан сервісу',
  'service.restart': 'Перезапуск сервісу',
  'process.list': 'Список процесів',
  'git.status': 'Стан Git',
  'git.diff': 'Зміни Git',
  'git.log': 'Історія Git',
  'git.commit': 'Git commit',
  'git.push': 'Git push',
};

function pill(label, tone = '') {
  return `<span class="status-pill ${tone}">${esc(label)}</span>`;
}

function chip(label, value, tone = '') {
  return `<span class="chip ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong></span>`;
}

function metric(label, value, tone = '', hint = '') {
  return `<article class="metric ${tone}">
    <span class="metric-value">${esc(value)}</span>
    <span class="metric-label">${esc(label)}</span>
    ${hint ? `<span class="metric-hint">${esc(hint)}</span>` : ''}
  </article>`;
}

function moduleCard({ kicker, title, statusLabel, statusTone, body, footer, target }) {
  return `<article class="module-card">
    <div class="module-card-head">
      <div>
        <span class="section-kicker">${esc(kicker)}</span>
        <h2>${esc(title)}</h2>
      </div>
      ${pill(statusLabel, statusTone)}
    </div>
    <div class="module-card-body">${body}</div>
    <button class="module-open" type="button" data-open-view="${esc(target)}">
      <span>${esc(footer)}</span><span aria-hidden="true">→</span>
    </button>
  </article>`;
}

function activityItem(item) {
  const ok = item.ok === true;
  return `<article class="activity-item">
    <span class="activity-dot ${ok ? 'ok' : 'bad'}"></span>
    <div class="activity-main">
      <div class="activity-line">
        <strong>${esc(operationNames[item.operation] || item.operation || 'Дія Commander')}</strong>
        <span>${esc(ago(Date.parse(item.completedAt)))}</span>
      </div>
      <div class="activity-meta">
        <span>${esc(item.deviceId || '—')}</span>
        <span>GitHub #${esc(item.issueNumber || '—')}</span>
        ${Number.isInteger(item.exitCode) ? `<span>код ${esc(item.exitCode)}</span>` : ''}
      </div>
    </div>
    <span class="activity-result ${ok ? 'ok' : 'bad'}">${ok ? 'Успішно' : 'Помилка'}</span>
  </article>`;
}

function emptyState(text) {
  return `<div class="empty-state">${esc(text)}</div>`;
}

function renderOverview(data) {
  const commander = data.commander || {};
  const autopilot = data.autopilot || {};
  const system = data.system || {};
  const [commanderLabel, commanderTone] = commanderStatus[commander.state] || ['Невідомо', 'bad'];
  const [automationLabel, automationTone] = automationStatus[autopilot.automationState] || ['Невідомо', 'bad'];

  $('overview-metrics').innerHTML = [
    metric('Commander', commander.online ? 'Онлайн' : commanderLabel, commander.online ? 'ok' : commanderTone),
    metric('Пристрої', `${commander.onlineDevices || 0}/${commander.totalDevices || 0}`, commander.onlineDevices === commander.totalDevices && commander.totalDevices ? 'ok' : 'warn'),
    metric('Автопілот', automationLabel, automationTone),
    metric('Сповіщення', String(system.alerts || 0), system.alerts ? 'bad' : 'ok'),
  ].join('');

  const deviceRows = (commander.devices || []).map((device) => `
    <div class="mini-row">
      <span class="device-mark ${device.status === 'online' ? 'ok' : 'bad'}"></span>
      <span>${esc(device.name)}</span>
      <strong>${device.status === 'online' ? 'Онлайн' : 'Офлайн'}</strong>
    </div>`).join('') || '<div class="muted-copy">Пристрої не виявлено.</div>';

  const projectRows = (autopilot.projects || []).map((project) => {
    const [label, tone] = projectStatus[project.status] || [project.status || 'Невідомо', 'bad'];
    return `<div class="mini-row">
      <span class="device-mark ${tone}"></span>
      <span>${esc(project.name)}</span>
      <strong>${esc(label)}</strong>
    </div>`;
  }).join('') || '<div class="muted-copy">Проєкти відсутні.</div>';

  $('overview-modules').innerHTML = [
    moduleCard({
      kicker: 'ВІДДАЛЕНЕ КЕРУВАННЯ',
      title: 'Commander',
      statusLabel: commanderLabel,
      statusTone: commanderTone,
      body: `<div class="module-summary"><strong>${commander.onlineDevices || 0} з ${commander.totalDevices || 0}</strong><span>пристроїв онлайн</span></div>
        <div class="mini-list">${deviceRows}</div>`,
      footer: 'Відкрити Commander',
      target: 'commander',
    }),
    moduleCard({
      kicker: 'АВТОМАТИЗАЦІЯ',
      title: 'Автопілот',
      statusLabel: automationLabel,
      statusTone: automationTone,
      body: `<div class="module-summary"><strong>${autopilot.infrastructureOnline ? 'Інфраструктура онлайн' : 'Інфраструктура недоступна'}</strong><span>автоматизація: ${automationLabel.toLowerCase()}</span></div>
        <div class="mini-list">${projectRows}</div>`,
      footer: 'Відкрити Автопілот',
      target: 'autopilot',
    }),
  ].join('');

  const activity = commander.activity || [];
  $('overview-activity').innerHTML = activity.length
    ? activity.slice(0, 4).map(activityItem).join('')
    : emptyState('Ще немає команд у поточному сеансі Commander.');
}

function deviceCard(device) {
  const online = device.status === 'online';
  const health = device.health || {};
  const caps = device.capabilities || {};
  return `<article class="device-card">
    <div class="card-head">
      <div class="device-title">
        <span class="device-orb ${online ? 'ok' : 'bad'}"></span>
        <div>
          <h3>${esc(device.name)}</h3>
          <span>${esc(device.id)}</span>
        </div>
      </div>
      ${pill(online ? 'Онлайн' : 'Офлайн', online ? 'ok' : 'bad')}
    </div>
    <div class="device-stats">
      <div><span>Час роботи</span><strong>${esc(formatUptime(health.uptimeSeconds))}</strong></div>
      <div><span>Вільна пам’ять</span><strong>${esc(formatBytes(health.freeMemoryBytes))}</strong></div>
      <div><span>Навантаження</span><strong>${esc(formatLoad(health.loadAverage))}</strong></div>
      <div><span>Агент</span><strong>${esc(device.agentVersion || '—')}</strong></div>
    </div>
    <div class="capability-grid">
      ${capabilityTile('Термінал', caps.terminal)}
      ${capabilityTile('Файли', caps.files)}
      ${capabilityTile('Сервіси', caps.services)}
      ${capabilityTile('Git', caps.git)}
    </div>
    <div class="device-foot">Останній сигнал: <strong>${esc(ago(device.lastHeartbeatAt))}</strong></div>
  </article>`;
}

function capabilityTile(label, enabled) {
  return `<div class="capability ${enabled ? 'enabled' : ''}">
    <span>${enabled ? '✓' : '—'}</span><strong>${esc(label)}</strong>
  </div>`;
}

function securityRow(label, enabled, detail) {
  return `<div class="security-row">
    <span class="security-icon ${enabled ? 'ok' : 'bad'}">${enabled ? '✓' : '!'}</span>
    <div><strong>${esc(label)}</strong><span>${esc(detail)}</span></div>
  </div>`;
}

function renderCommander(data) {
  const commander = data.commander || {};
  const [stateLabel, stateTone] = commanderStatus[commander.state] || ['Невідомо', 'bad'];
  const transport = commander.transport || {};
  const security = commander.security || {};
  const devices = commander.devices || [];
  const activity = commander.activity || [];

  $('commander-content').innerHTML = `
    <section class="hero-card commander-hero">
      <div>
        <span class="section-kicker">COMMANDER</span>
        <h2>Віддалене керування</h2>
        <p>Приватний контур керування Raspberry Pi через Міст GitHub та Commander Gateway.</p>
      </div>
      ${pill(stateLabel, stateTone)}
      <div class="hero-metrics">
        <div><strong>${esc(commander.onlineDevices || 0)}/${esc(commander.totalDevices || 0)}</strong><span>пристроїв онлайн</span></div>
        <div><strong>${esc(transport.name || 'Міст GitHub')}</strong><span>транспорт</span></div>
        <div><strong>${esc(transport.pollSeconds || 3)} с</strong><span>опитування</span></div>
      </div>
    </section>

    <section class="section-block">
      <div class="section-head"><div><span class="section-kicker">ПРИСТРОЇ</span><h2>Підключені Raspberry Pi</h2></div></div>
      <div class="device-grid">${devices.length ? devices.map(deviceCard).join('') : emptyState('Commander Gateway не повернув жодного пристрою.')}</div>
    </section>

    <section class="split-grid">
      <article class="section-card">
        <div class="section-head compact"><div><span class="section-kicker">БЕЗПЕКА</span><h2>Політика Commander</h2></div></div>
        <div class="security-list">
          ${securityRow('Заборона нових привілеїв (NoNewPrivs)', security.noNewPrivs === true, 'Процеси не можуть отримати нові привілеї')}
          ${securityRow('Лише власник', security.ownerOnly === true, 'Команди приймаються через авторизований GitHub-контур')}
          ${securityRow('ADMIN вимкнено', security.adminOperations === false, 'Системні адміністративні операції не публікуються')}
          ${securityRow('Root-shell відсутній', security.rootShell === false, 'Термінал працює як непривілейований користувач')}
        </div>
      </article>
      <article class="section-card">
        <div class="section-head compact"><div><span class="section-kicker">КАНАЛ КЕРУВАННЯ</span><h2>Маршрут команди</h2></div></div>
        <div class="control-path">
          <span>ChatGPT Plus</span><b>↓</b><span>GitHub</span><b>↓</b><span>Commander Bridge</span><b>↓</b><span>Gateway → Agents</span>
        </div>
        <div class="inline-state">${pill(transport.active ? 'Міст активний' : 'Міст недоступний', transport.active ? 'ok' : 'bad')}</div>
      </article>
    </section>

    <section class="section-block">
      <div class="section-head"><div><span class="section-kicker">ЖУРНАЛ</span><h2>Останні команди</h2></div></div>
      <div class="activity-list">${activity.length ? activity.map(activityItem).join('') : emptyState('Історія поточного сеансу порожня.')}</div>
    </section>`;
}

function autopilotProjectCard(project) {
  const [label, tone] = projectStatus[project.status] || [project.status || 'Невідомо', 'bad'];
  const action = project.canApprove
    ? `<button class="action-button primary" data-project="${esc(project.id)}" data-action="approve">Підтвердити крок</button>`
    : project.canRetry
      ? `<button class="action-button primary" data-project="${esc(project.id)}" data-action="retry">Повторити</button>`
      : '<button class="action-button secondary" disabled>Дія не потрібна</button>';
  const link = project.taskUrl
    ? `<a class="action-link" href="${esc(project.taskUrl)}" target="_blank" rel="noreferrer">Відкрити GitHub ↗</a>`
    : '';
  return `<article class="project-card">
    <div class="card-head">
      <div><h3>${esc(project.name)}</h3><span>Автопілот v3 · ${esc(project.id)}</span></div>
      ${pill(label, tone)}
    </div>
    <div class="task-box">
      <span>Остання задача</span>
      <strong>${esc(project.currentTask || 'Немає активної задачі')}</strong>
    </div>
    <div class="chip-row">
      ${chip('Стан', label, tone)}
      ${chip('Етап', project.stepId || '—')}
      ${chip('Оновлено', ago(project.updatedAt))}
    </div>
    ${project.lastError ? `<div class="error-box"><strong>Остання помилка</strong><span>${esc(project.lastError)}</span></div>` : ''}
    <div class="action-row">${action}${link}</div>
  </article>`;
}

function renderAutopilot(data) {
  const autopilot = data.autopilot || {};
  const [stateLabel, stateTone] = automationStatus[autopilot.automationState] || ['Невідомо', 'bad'];
  const projects = autopilot.projects || [];

  $('autopilot-content').innerHTML = `
    <section class="hero-card autopilot-hero">
      <div>
        <span class="section-kicker">АВТОПІЛОТ V3</span>
        <h2>Автоматизація проєктів</h2>
        <p>Інфраструктура та автоматизація показуються окремо, щоб активний сервіс не виглядав як запущена автономна робота.</p>
      </div>
      ${pill(stateLabel, stateTone)}
      <div class="hero-metrics">
        <div><strong>${autopilot.infrastructureOnline ? 'Онлайн' : 'Офлайн'}</strong><span>інфраструктура</span></div>
        <div><strong>${esc(stateLabel)}</strong><span>автоматизація</span></div>
        <div><strong>${esc(projects.length)}</strong><span>проєктів</span></div>
      </div>
    </section>
    <section class="section-block">
      <div class="section-head"><div><span class="section-kicker">ПРОЄКТИ</span><h2>Стан автоматизації</h2></div></div>
      <div class="project-grid">${projects.length ? projects.map(autopilotProjectCard).join('') : emptyState('Немає налаштованих проєктів Autopilot.')}</div>
    </section>
    <section class="section-card note-card">
      <span class="section-kicker">ПОТОЧНИЙ РЕЖИМ</span>
      <h2>${autopilot.automationState === 'active' ? 'Автоматична робота' : 'Ручне керування'}</h2>
      <p>${autopilot.automationState === 'active'
        ? 'Autopilot виконує активні кроки згідно детермінованого плану.'
        : 'Autopilot infrastructure залишається онлайн, але завершені проєкти не запускають нову роботу автоматично.'}</p>
    </section>`;
}

function serviceLabel(key) {
  return ({
    commanderGateway: 'Commander Gateway',
    commanderBridge: 'Commander Міст GitHub',
    autopilot: 'Автопілот v3',
    miniapp: 'Telegram Mini App',
    telegram: 'Telegram Bridge',
    legacyRdc: 'Remote Desktop Commander',
    secureTunnel: 'Secure MCP Tunnel',
  })[key] || key;
}

function serviceRow(key, service) {
  const active = service?.activeState === 'active';
  const legacy = ['legacyRdc', 'secureTunnel'].includes(key);
  const desired = legacy ? !active : active;
  const value = legacy
    ? (active ? 'Активний' : 'Вимкнено')
    : (active ? 'Працює' : service?.activeState === 'unknown' ? 'Невідомо' : 'Не працює');
  return `<div class="service-row">
    <span class="service-led ${desired ? 'ok' : active ? 'warn' : 'bad'}"></span>
    <div><strong>${esc(serviceLabel(key))}</strong><span>${esc(service?.unit || '')}</span></div>
    <span class="service-value ${desired ? 'ok' : 'bad'}">${esc(value)}</span>
  </div>`;
}

function renderSystem(data) {
  const system = data.system || {};
  const services = system.services || {};
  const commander = data.commander || {};
  const autopilot = data.autopilot || {};
  const primaryKeys = ['commanderGateway', 'commanderBridge', 'autopilot', 'miniapp', 'telegram'];
  const legacyKeys = ['legacyRdc', 'secureTunnel'];

  $('system-content').innerHTML = `
    <section class="hero-card system-hero">
      <div>
        <span class="section-kicker">СИСТЕМА</span>
        <h2>Інфраструктура</h2>
        <p>Стан локальних сервісів, каналів керування та відключених legacy-компонентів.</p>
      </div>
      ${pill(system.alerts ? `${system.alerts} попередж.` : 'Все штатно', system.alerts ? 'warn' : 'ok')}
    </section>
    <section class="section-card">
      <div class="section-head compact"><div><span class="section-kicker">СЕРВІСИ</span><h2>Основні компоненти</h2></div></div>
      <div class="service-list">${primaryKeys.map((key) => serviceRow(key, services[key])).join('')}</div>
    </section>
    <section class="section-card">
      <div class="section-head compact"><div><span class="section-kicker">ВІДКЛЮЧЕНІ КОМПОНЕНТИ</span><h2>Legacy та резервні канали</h2></div></div>
      <div class="service-list">${legacyKeys.map((key) => serviceRow(key, services[key])).join('')}</div>
    </section>
    <section class="split-grid system-facts">
      <article class="fact-card"><span>Commander</span><strong>${esc(commander.state || 'offline')}</strong><small>${esc(commander.onlineDevices || 0)}/${esc(commander.totalDevices || 0)} пристроїв</small></article>
      <article class="fact-card"><span>Автопілот</span><strong>${esc((automationStatus[autopilot.automationState] || [autopilot.automationState || '—'])[0])}</strong><small>Виклики ШІ: ${esc(autopilot.aiCalls || 0)}</small></article>
      <article class="fact-card"><span>Версія центру</span><strong>v${esc(data.version || '—')}</strong><small>режим керування проєктами</small></article>
      <article class="fact-card"><span>Оновлено</span><strong>${new Date(data.generatedAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}</strong><small>автооновлення 15 с</small></article>
    </section>`;
}

function render(data) {
  lastPayload = data;
  renderOverview(data);
  renderCommander(data);
  renderAutopilot(data);
  renderSystem(data);

  const alerts = Number(data.system?.alerts || 0);
  $('global-state').textContent = alerts ? `Є попередження: ${alerts}` : 'Система працює штатно';
  $('global-state').className = `mini-status ${alerts ? 'warn' : 'ok'}`;
  $('updated').textContent = `Оновлено о ${new Date(data.generatedAt).toLocaleTimeString('uk-UA', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  })}`;
  applyView(currentView);
}

function applyView(view) {
  currentView = ['overview', 'commander', 'autopilot', 'system'].includes(view) ? view : 'overview';
  sessionStorage.setItem('project-control-view', currentView);
  document.querySelectorAll('.view').forEach((node) => node.classList.toggle('active', node.dataset.view === currentView));
  document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.viewTarget === currentView));
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function showMessage(text, tone = '') {
  const node = $('message');
  node.textContent = text || '';
  node.className = `toast ${tone}`;
}

async function load({ quiet = false } = {}) {
  $('refresh').disabled = true;
  try {
    render(await api('./api/status'));
    if (!quiet) showMessage('');
  } catch (error) {
    showMessage(`Не вдалося оновити дані: ${error.message}`, 'bad');
  } finally {
    $('refresh').disabled = false;
  }
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-view-target],[data-open-view]');
  if (nav) {
    applyView(nav.dataset.viewTarget || nav.dataset.openView);
    tg?.HapticFeedback?.selectionChanged?.();
    return;
  }

  const button = event.target.closest('button[data-action][data-project]');
  if (!button) return;
  const action = button.dataset.action;
  const projectId = button.dataset.project;
  const confirmation = action === 'approve'
    ? 'Підтвердити поточний крок Autopilot?'
    : 'Повторити заблокований крок Autopilot?';
  if (!confirm(confirmation)) return;

  button.disabled = true;
  try {
    await api(`./api/projects/${encodeURIComponent(projectId)}/${action}`, {
      method: 'POST',
      body: '{}',
    });
    tg?.HapticFeedback?.notificationOccurred?.('success');
    showMessage(action === 'approve' ? 'Крок підтверджено.' : 'Повторний запуск прийнято.', 'ok');
    await load({ quiet: true });
  } catch (error) {
    tg?.HapticFeedback?.notificationOccurred?.('error');
    showMessage(`Помилка: ${error.message}`, 'bad');
  } finally {
    button.disabled = false;
  }
});

$('refresh').onclick = async () => {
  tg?.HapticFeedback?.impactOccurred?.('light');
  await load();
};

applyView(currentView);
load();
setInterval(() => load({ quiet: true }), 15000);
