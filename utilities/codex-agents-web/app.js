const state = {
  snapshot: null,
  view: 'tasks',
  query: '',
  activeLabel: '',
  activeProject: '',
  status: '',
  activeDetail: null,
  saveTimers: new Map(),
  saveSequence: 0,
  refreshTimer: null,
  localCollapsed: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function prettyStatus(status) {
  return state.snapshot?.statuses?.[status] || String(status).replaceAll('_', ' ');
}

function prettyOperational(status) {
  return ({
    working: 'Running', waiting_for_approval: 'Approval needed', waiting_on_agents: 'Waiting on agents',
    compacting: 'Compacting', idle: 'Turn complete', stale: 'Stale', done: 'Agent done',
    abandoned: 'Abandoned', ended: 'Ended', unknown: 'No live activity',
  })[status] || String(status).replaceAll('_', ' ');
}

function relativeTime(timestamp) {
  if (!timestamp) return '—';
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(timestamp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function projectName(path = '') {
  return path.split('/').filter(Boolean).at(-1) || 'No project';
}

function projectLabel(path = '') {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join(' / ') || 'No project';
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.remove('show'), 2200);
}

async function loadState({ quiet = false } = {}) {
  try {
    const completed = $('#show-completed').checked ? '1' : '0';
    state.snapshot = await api(`/api/state?completed=${completed}`);
    renderSidebar();
    renderProjectInputs();
    renderTasks();
    if (!quiet && state.view === 'threads') await loadThreads();
  } catch (error) {
    if (!quiet) toast(error.message);
  }
}

function renderSidebar() {
  const { cards, counts, tags, projects, index } = state.snapshot;
  $('#task-count').textContent = cards.length;
  $('#thread-count').textContent = counts.top_level || 0;

  const labelRoot = $('#label-filters');
  labelRoot.innerHTML = tags.length ? tags.map(tag => `
    <button class="label-filter ${state.activeLabel === tag.name ? 'active' : ''}" data-label="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</button>
  `).join('') : '<span class="muted">No labels yet</span>';
  $$('.label-filter', labelRoot).forEach(button => button.addEventListener('click', () => {
    state.activeLabel = state.activeLabel === button.dataset.label ? '' : button.dataset.label;
    renderSidebar(); renderTasks();
  }));

  const projectRoot = $('#project-filters');
  const visibleProjects = state.view === 'tasks' ? projects.filter(project => project.task_count) : projects;
  projectRoot.innerHTML = visibleProjects.length ? visibleProjects.map(project => `
    <button class="project-filter ${state.activeProject === project.cwd ? 'active' : ''}" data-project="${escapeHtml(project.cwd)}" title="${escapeHtml(project.cwd)}">
      <span>${escapeHtml(projectLabel(project.cwd))}</span><small>${state.view === 'tasks' ? project.task_count : project.thread_count}</small>
    </button>
  `).join('') : '<span class="muted">No projects yet</span>';
  $$('.project-filter', projectRoot).forEach(button => button.addEventListener('click', () => {
    state.activeProject = state.activeProject === button.dataset.project ? '' : button.dataset.project;
    renderSidebar(); renderTasks();
    if (state.view === 'threads') loadThreads();
  }));

  const indexed = index.total ? `${index.indexed}/${index.total}` : '0';
  $('#index-status').textContent = index.error ? 'Thread search paused' :
    index.running ? `Indexing threads ${indexed}` : `Thread search ready · ${indexed}`;
  $('.pulse-dot').classList.toggle('running', index.running);
}

function projectOptions({ includeAuto = false, selected = '' } = {}) {
  const first = includeAuto ? '<option value="">Automatic from linked thread</option>' : '<option value="">No project</option>';
  return first + state.snapshot.projects.map(project =>
    `<option value="${escapeHtml(project.cwd)}" ${selected === project.cwd ? 'selected' : ''}>${escapeHtml(projectLabel(project.cwd))}</option>`
  ).join('');
}

function renderProjectInputs() {
  const quick = $('#quick-add-project');
  const dialog = $('#task-project-input');
  const quickValue = quick.value || state.activeProject;
  quick.innerHTML = projectOptions({ selected: quickValue });
  quick.value = quickValue;
  const dialogValue = dialog.value || state.activeProject;
  dialog.innerHTML = projectOptions({ selected: dialogValue });
  dialog.value = dialogValue;
}

function filteredTasks() {
  const query = state.query.toLowerCase().trim();
  return state.snapshot.cards.filter(task => {
    if (state.status && task.workflow_status !== state.status) return false;
    if (state.activeLabel && !task.tags.some(label => label.name === state.activeLabel)) return false;
    if (state.activeProject && task.cwd !== state.activeProject) return false;
    if (!query) return true;
    return [task.title, task.preview, task.note, task.cwd, ...task.tags.map(label => label.name),
      ...task.threads.map(thread => thread.native_title)]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderTasks() {
  if (!state.snapshot) return;
  const tasks = filteredTasks();
  const knownProjects = state.snapshot.projects.map(project => project.cwd);
  const taskProjects = [...new Set(tasks.map(task => task.cwd).filter(Boolean))];
  const ordered = [...knownProjects.filter(cwd => taskProjects.includes(cwd)),
    ...taskProjects.filter(cwd => !knownProjects.includes(cwd))];
  if (tasks.some(task => !task.cwd)) ordered.push('');

  const root = $('#task-list');
  root.innerHTML = ordered.length ? ordered.map((cwd, index) => {
    const project = state.snapshot.projects.find(item => item.cwd === cwd);
    const projectTasks = tasks.filter(task => task.cwd === cwd);
    return projectSection(cwd, projectTasks, project, index, ordered.length);
  }).join('') : `<div class="task-empty"><span class="empty-check">✓</span><strong>No tasks here</strong><p>${state.query || state.activeLabel || state.activeProject || state.status ? 'Clear a filter to see more work.' : 'Add a task above, or turn a Codex thread into one.'}</p></div>`;
  bindTaskEvents();
  renderLiveSummary(tasks);
}

function projectSection(cwd, tasks, project, index, total) {
  const collapsed = cwd ? Boolean(project?.collapsed) : state.localCollapsed;
  const statusOrder = ['in_progress', 'open', 'waiting', 'paused', 'done'];
  const statusGroups = statusOrder.filter(status => tasks.some(task => task.workflow_status === status));
  return `<section class="project-group ${collapsed ? 'collapsed' : ''}" data-project="${escapeHtml(cwd)}">
    <header class="project-header">
      <button class="collapse-project" data-project="${escapeHtml(cwd)}" aria-expanded="${!collapsed}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(projectName(cwd))}"><span>⌄</span></button>
      <div class="project-identity"><h3>${escapeHtml(projectName(cwd))}</h3><p title="${escapeHtml(cwd)}">${escapeHtml(cwd || 'Tasks without a working directory')}</p></div>
      <span class="project-task-count">${tasks.length} task${tasks.length === 1 ? '' : 's'}</span>
      ${cwd ? `<div class="project-order" aria-label="Reorder project"><button class="icon-button move-project" data-project="${escapeHtml(cwd)}" data-direction="-1" ${index === 0 ? 'disabled' : ''} title="Move project up">↑</button><button class="icon-button move-project" data-project="${escapeHtml(cwd)}" data-direction="1" ${index === total - 1 ? 'disabled' : ''} title="Move project down">↓</button></div>` : ''}
    </header>
    <div class="project-body">${statusGroups.map(status => statusSection(status, tasks.filter(task => task.workflow_status === status))).join('')}</div>
  </section>`;
}

function statusSection(status, tasks) {
  return `<div class="status-group"><div class="status-heading"><span class="status-dot ${status}"></span><span>${escapeHtml(prettyStatus(status))}</span><small>${tasks.length}</small></div><div class="task-rows">${tasks.map(taskTemplate).join('')}</div></div>`;
}

function taskTemplate(task) {
  const operational = task.operational?.state || 'unknown';
  const updatedAt = task.thread_updated_at || task.updated_at;
  const labels = task.tags.slice(0, 4).map(label => `<span class="label">${escapeHtml(label.name)}</span>`).join('');
  const threads = task.threads.length;
  return `<article class="task-row ${task.workflow_status === 'done' ? 'done' : ''}" data-task-id="${escapeHtml(task.card_id)}">
    <button class="task-checkbox toggle-task" data-task-id="${escapeHtml(task.card_id)}" data-done="${task.workflow_status === 'done'}" aria-label="${task.workflow_status === 'done' ? 'Reopen' : 'Complete'} ${escapeHtml(task.title)}">${task.workflow_status === 'done' ? '✓' : ''}</button>
    <div class="task-content"><div class="task-title-line"><strong>${escapeHtml(task.title)}</strong>${operational !== 'unknown' ? `<span class="operational-badge ${operational}">${escapeHtml(prettyOperational(operational))}</span>` : ''}</div><div class="task-meta">${labels}<span class="thread-link ${threads ? 'linked' : ''}">⌁ ${threads ? `${threads} thread${threads === 1 ? '' : 's'}` : 'No thread'}</span>${task.note ? '<span class="has-note" title="Has note">▤</span>' : ''}</div></div>
    <select class="row-status" data-task-id="${escapeHtml(task.card_id)}" aria-label="Workflow status for ${escapeHtml(task.title)}">${Object.entries(state.snapshot.statuses).map(([value, label]) => `<option value="${value}" ${task.workflow_status === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
    <time title="${escapeHtml(new Date(updatedAt * 1000).toLocaleString())}">${relativeTime(updatedAt)}</time>
  </article>`;
}

function bindTaskEvents() {
  $$('.task-row').forEach(row => row.addEventListener('click', event => {
    if (!event.target.closest('button, select')) openTask(row.dataset.taskId);
  }));
  $$('.toggle-task').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    await updateTask(button.dataset.taskId, { workflow_status: button.dataset.done === 'true' ? 'open' : 'done' }, button.dataset.done === 'true' ? 'Task reopened' : 'Task completed');
  }));
  $$('.row-status').forEach(select => select.addEventListener('change', async event => {
    event.stopPropagation(); await updateTask(select.dataset.taskId, { workflow_status: select.value });
  }));
  $$('.collapse-project').forEach(button => button.addEventListener('click', () => toggleProject(button.dataset.project)));
  $$('.move-project').forEach(button => button.addEventListener('click', () => moveProject(button.dataset.project, Number(button.dataset.direction))));
}

async function updateTask(taskId, changes, message = '') {
  try {
    await api(`/api/cards/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    await loadState({ quiet: true });
    if (message) toast(message);
  } catch (error) { toast(error.message); }
}

async function toggleProject(cwd) {
  if (!cwd) { state.localCollapsed = !state.localCollapsed; renderTasks(); return; }
  const project = state.snapshot.projects.find(item => item.cwd === cwd);
  try {
    await api('/api/projects', { method: 'PATCH', body: JSON.stringify({ cwd, collapsed: !project?.collapsed }) });
    await loadState({ quiet: true });
  } catch (error) { toast(error.message); }
}

async function moveProject(cwd, direction) {
  const allProjects = state.snapshot.projects.map(project => project.cwd);
  const taskProjectSet = new Set(state.snapshot.cards.map(task => task.cwd).filter(Boolean));
  const projects = allProjects.filter(project => taskProjectSet.has(project));
  const current = projects.indexOf(cwd);
  const target = current + direction;
  if (current < 0 || target < 0 || target >= projects.length) return;
  [projects[current], projects[target]] = [projects[target], projects[current]];
  const reordered = [...projects, ...allProjects.filter(project => !taskProjectSet.has(project))];
  try {
    await api('/api/projects/reorder', { method: 'POST', body: JSON.stringify({ projects: reordered }) });
    await loadState({ quiet: true });
  } catch (error) { toast(error.message); }
}

function renderLiveSummary(tasks) {
  const counts = {};
  tasks.forEach(task => { const value = task.operational?.state || 'unknown'; counts[value] = (counts[value] || 0) + 1; });
  const items = [['working', 'running'], ['waiting_for_approval', 'need approval'], ['waiting_on_agents', 'waiting']]
    .filter(([key]) => counts[key]).map(([key, label]) => `<span class="summary-pill"><strong>${counts[key]}</strong> ${label}</span>`);
  $('#live-summary').innerHTML = items.join('') || '<span class="summary-pill">No live Codex activity</span>';
}

async function loadThreads() {
  const root = $('#thread-list');
  root.innerHTML = '<div class="empty-state">Searching local history…</div>';
  try {
    const parameters = new URLSearchParams({ q: state.query });
    if (state.activeProject) parameters.set('cwd', state.activeProject);
    const payload = await api(`/api/threads?${parameters}`);
    root.innerHTML = payload.threads.length ? payload.threads.map(threadTemplate).join('') : '<div class="empty-state"><strong>No matching threads</strong>Try another title, phrase, or project.</div>';
    $$('.thread-row', root).forEach(row => row.addEventListener('click', event => {
      if (!event.target.closest('button')) openThread(row.dataset.threadId);
    }));
    $$('.make-task', root).forEach(button => button.addEventListener('click', async event => {
      event.stopPropagation();
      try {
        await api('/api/cards/thread', { method: 'POST', body: JSON.stringify({ thread_id: button.dataset.threadId }) });
        await loadState({ quiet: true }); await loadThreads(); toast('Thread added as a task');
      } catch (error) { toast(error.message); }
    }));
    $$('.open-linked-task', root).forEach(button => button.addEventListener('click', event => {
      event.stopPropagation(); openTask(button.dataset.taskId);
    }));
  } catch (error) { root.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
}

function threadTemplate(thread) {
  let action;
  if (thread.work_item_id) action = `<button class="button quiet open-linked-task" data-task-id="${escapeHtml(thread.work_item_id)}">View task</button>`;
  else if (thread.card_id && !thread.dismissed_at) action = `<button class="button quiet open-linked-task" data-task-id="${escapeHtml(thread.card_id)}">View task</button>`;
  else action = `<button class="button quiet make-task" data-thread-id="${escapeHtml(thread.thread_id)}">Make task</button>`;
  const operational = thread.operational?.state || 'unknown';
  return `<div class="thread-row" data-thread-id="${escapeHtml(thread.thread_id)}"><div class="thread-main"><strong>${escapeHtml(thread.title || 'Untitled thread')}</strong><p>${escapeHtml(thread.preview || thread.thread_id)}</p></div><div class="thread-project"><span>${escapeHtml(projectName(thread.cwd))}</span><small title="${escapeHtml(thread.cwd)}">${escapeHtml(thread.cwd || 'Unavailable')}</small></div><div class="thread-date">${operational !== 'unknown' ? `<span class="activity-dot ${operational}" title="${escapeHtml(prettyOperational(operational))}"></span>` : ''}${relativeTime(thread.updated_at)}</div><div class="row-action">${action}</div></div>`;
}

async function openTask(taskId) {
  try {
    const detail = await api(`/api/cards/${encodeURIComponent(taskId)}`);
    state.activeDetail = { kind: 'task', value: detail };
    renderTaskDetail(detail); openDrawer();
  } catch (error) { toast(error.message); }
}

async function openThread(threadId) {
  try {
    $('#drawer-content').innerHTML = '<div class="empty-state">Loading conversation…</div>';
    openDrawer();
    const detail = await api(`/api/threads/${encodeURIComponent(threadId)}`);
    state.activeDetail = { kind: 'thread', value: detail };
    renderThreadDetail(detail);
  } catch (error) { toast(error.message); closeDrawer(); }
}

function openDrawer() {
  $('#detail-drawer').classList.add('open'); $('#detail-drawer').setAttribute('aria-hidden', 'false'); $('#scrim').hidden = false;
}
function closeDrawer() {
  $('#detail-drawer').classList.remove('open'); $('#detail-drawer').setAttribute('aria-hidden', 'true'); $('#scrim').hidden = true; state.activeDetail = null;
}

function taskFields(detail) {
  return `<div class="detail-grid"><label class="field"><span>Task title</span><input id="detail-title-input" value="${escapeHtml(detail.title_override || detail.title || '')}"></label><label class="field"><span>Workflow status</span><select id="detail-status">${Object.entries(state.snapshot.statuses).map(([value, label]) => `<option value="${value}" ${detail.workflow_status === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label></div>
  <label class="field"><span>Project</span><select id="detail-project">${projectOptions({ includeAuto: true, selected: detail.project_cwd || '' })}</select><small class="field-hint">${detail.project_cwd ? escapeHtml(detail.project_cwd) : detail.cwd ? `Currently inferred as ${escapeHtml(detail.cwd)}` : 'No project until you choose one or link a thread'}</small></label>
  <label class="field detail-labels"><span>Labels · comma separated</span><input id="detail-labels" value="${escapeHtml((detail.tags || []).map(label => label.name).join(', '))}" placeholder="bug, follow-up, research"></label>
  <label class="field detail-note"><span>Notes</span><textarea id="detail-note" placeholder="Context, next action, or definition of done…">${escapeHtml(detail.note || '')}</textarea></label>`;
}

function renderTaskDetail(detail) {
  $('#copy-thread-id').hidden = true;
  const saveStatus = $('#auto-save-status');
  saveStatus.hidden = false; saveStatus.textContent = 'All changes saved'; saveStatus.className = 'save-state saved';
  const origin = detail.thread_id ? 'Started from a Codex thread' : 'Independent task';
  const threads = detail.threads.map(thread => `<div class="linked-thread"><button class="thread-open" data-thread-id="${escapeHtml(thread.thread_id)}"><span class="thread-symbol">⌁</span><span><strong>${escapeHtml(thread.native_title || 'Untitled thread')}</strong><small>${escapeHtml(projectName(thread.cwd))} · ${relativeTime(thread.updated_at)}${thread.primary ? ' · started this task' : ''}</small></span></button>${thread.primary ? '<span class="primary-thread">Primary</span>' : `<button class="icon-button detach-thread" data-thread-id="${escapeHtml(thread.thread_id)}" title="Unlink thread" aria-label="Unlink ${escapeHtml(thread.native_title)}">×</button>`}</div>`).join('');
  $('#drawer-content').innerHTML = `<div class="detail-eyebrow"><span>Task</span><span>${escapeHtml(origin)}</span></div><h2 class="detail-title">${escapeHtml(detail.title)}</h2><div class="detail-meta"><span>${escapeHtml(detail.cwd || 'No project')}</span><span>${detail.threads.length} linked thread${detail.threads.length === 1 ? '' : 's'}</span></div>${taskFields(detail)}
    <section class="detail-section"><div class="detail-section-heading"><div><h3>Codex threads</h3><p>Conversations can be linked now or discovered later.</p></div><span class="muted">${detail.threads.length}</span></div><div class="linked-thread-list">${threads || '<p class="muted">This task stands on its own right now.</p>'}</div><div class="thread-finder"><label class="field"><span>Find a thread to link</span><input id="thread-search-input" placeholder="Search by title, prompt, or thread ID" autocomplete="off"></label><div id="thread-search-results" class="thread-search-results"></div></div></section>`;
  bindTaskDetail(detail);
}

function bindTaskDetail(detail) {
  $('#detail-title-input').addEventListener('input', event => { $('.detail-title').textContent = event.target.value || detail.title; scheduleTaskSave(); });
  $('#detail-labels').addEventListener('input', scheduleTaskSave);
  $('#detail-note').addEventListener('input', scheduleTaskSave);
  $('#detail-status').addEventListener('change', () => scheduleTaskSave(0));
  $('#detail-project').addEventListener('change', () => scheduleTaskSave(0));
  $$('.thread-open').forEach(button => button.addEventListener('click', () => openThread(button.dataset.threadId)));
  $$('.detach-thread').forEach(button => button.addEventListener('click', async () => {
    try {
      await api(`/api/tasks/${encodeURIComponent(detail.card_id)}/threads/${encodeURIComponent(button.dataset.threadId)}`, { method: 'DELETE' });
      await loadState({ quiet: true }); await openTask(detail.card_id); toast('Thread unlinked');
    } catch (error) { toast(error.message); }
  }));
  let searchTimer;
  $('#thread-search-input').addEventListener('input', event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchThreadsForTask(detail, event.target.value), 220);
  });
}

async function searchThreadsForTask(detail, query) {
  const root = $('#thread-search-results');
  if (!query.trim()) { root.innerHTML = ''; return; }
  root.innerHTML = '<span class="muted">Searching…</span>';
  try {
    const payload = await api(`/api/threads?q=${encodeURIComponent(query.trim())}`);
    const attached = new Set(detail.threads.map(thread => thread.thread_id));
    const matches = payload.threads.filter(thread => !attached.has(thread.thread_id)).slice(0, 8);
    root.innerHTML = matches.length ? matches.map(thread => `<button class="thread-result" data-thread-id="${escapeHtml(thread.thread_id)}"><span><strong>${escapeHtml(thread.title || 'Untitled thread')}</strong><small>${escapeHtml(projectName(thread.cwd))}${thread.work_item_id || (thread.card_id && !thread.dismissed_at) ? ' · linked elsewhere' : ''}</small></span><span>${thread.work_item_id || (thread.card_id && !thread.dismissed_at) ? 'Move here' : 'Link'}</span></button>`).join('') : '<span class="muted">No matching unlinked threads.</span>';
    $$('.thread-result', root).forEach(button => button.addEventListener('click', async () => {
      try {
        await api(`/api/tasks/${encodeURIComponent(detail.card_id)}/threads`, { method: 'POST', body: JSON.stringify({ thread_id: button.dataset.threadId }) });
        await loadState({ quiet: true }); await openTask(detail.card_id); toast('Thread linked to task');
      } catch (error) { toast(error.message); }
    }));
  } catch (error) { root.innerHTML = `<span class="muted">${escapeHtml(error.message)}</span>`; }
}

function currentTaskChanges() {
  if (!$('#detail-title-input')) return null;
  return {
    title_override: $('#detail-title-input').value.trim(),
    note: $('#detail-note').value,
    workflow_status: $('#detail-status').value,
    project_cwd: $('#detail-project').value,
    tags: $('#detail-labels').value.split(',').map(value => value.trim()).filter(Boolean),
  };
}

function scheduleTaskSave(delay = 550) {
  const detail = state.activeDetail?.value;
  const changes = currentTaskChanges();
  if (!detail?.card_id || !changes) return;
  const taskId = detail.card_id;
  const sequence = ++state.saveSequence;
  const status = $('#auto-save-status');
  status.hidden = false; status.textContent = 'Saving…'; status.className = 'save-state saving';
  clearTimeout(state.saveTimers.get(taskId));
  state.saveTimers.set(taskId, setTimeout(() => {
    state.saveTimers.delete(taskId); saveTaskChanges(taskId, changes, sequence);
  }, delay));
}

async function saveTaskChanges(taskId, changes, sequence) {
  try {
    const updated = await api(`/api/cards/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(changes) });
    if (sequence !== state.saveSequence) return;
    if (state.activeDetail?.kind === 'task' && state.activeDetail.value.card_id === taskId) {
      state.activeDetail.value = updated;
      const status = $('#auto-save-status'); status.textContent = 'All changes saved'; status.className = 'save-state saved';
    }
    await loadState({ quiet: true });
  } catch (error) {
    if (sequence !== state.saveSequence) return;
    const status = $('#auto-save-status'); status.textContent = 'Could not save'; status.className = 'save-state error'; toast(error.message);
  }
}

function renderThreadDetail(detail) {
  $('#copy-thread-id').hidden = false; $('#auto-save-status').hidden = true;
  const operational = detail.operational?.state || 'unknown';
  const messages = detail.messages.map(message => `<article class="message ${message.role}"><div class="message-role">${message.role}</div><div class="message-text">${escapeHtml(message.text)}</div></article>`).join('');
  const tools = detail.tools.map(tool => `<details><summary>${escapeHtml(tool.name)}${tool.status ? ` · ${escapeHtml(tool.status)}` : ''}</summary><div class="tool-output">${escapeHtml(tool.input)}${tool.output ? `\n\nOutput\n${escapeHtml(tool.output)}` : ''}</div></details>`).join('');
  const subagents = detail.subagents.map(thread => `<div class="linked-thread"><button class="thread-open view-subagent" data-thread-id="${escapeHtml(thread.thread_id)}"><span class="thread-symbol">↳</span><span><strong>${escapeHtml(thread.native_title || 'Subagent')}</strong><small>${relativeTime(thread.updated_at)}</small></span></button></div>`).join('');
  const linkedTaskId = detail.work_item_id || (detail.card_id && !detail.dismissed_at ? detail.card_id : '');
  const taskAction = linkedTaskId ? `<button class="button secondary" id="open-thread-task" data-task-id="${escapeHtml(linkedTaskId)}">Open linked task</button>` : `<button class="button primary" id="make-thread-task">Make this a task</button>`;
  const taskOptions = linkTaskOptions(linkedTaskId, detail.card_id);
  $('#drawer-content').innerHTML = `<div class="detail-eyebrow"><span>Codex thread</span><span class="operational-badge ${operational}">${escapeHtml(prettyOperational(operational))}</span></div><h2 class="detail-title">${escapeHtml(detail.title)}</h2><div class="detail-meta"><span>${escapeHtml(detail.cwd)}</span><span>${escapeHtml(detail.model || 'Unknown model')}</span><span>${relativeTime(detail.updated_at)}</span></div><div class="thread-task-actions">${taskAction}${taskOptions}</div>${subagents ? `<section class="detail-section"><div class="detail-section-heading"><h3>Subagents</h3><span class="muted">${detail.subagents.length}</span></div>${subagents}</section>` : ''}<section class="detail-section"><div class="detail-section-heading"><h3>Conversation</h3><span class="muted">${detail.messages.length} messages</span></div><div class="conversation">${messages || '<p class="muted">No readable conversation events found.</p>'}</div></section>${tools ? `<section class="detail-section tool-activity"><div class="detail-section-heading"><h3>Tool activity</h3><span class="muted">${detail.tools.length}</span></div>${tools}</section>` : ''}`;
  bindThreadDetail(detail);
}

function linkTaskOptions(linkedTaskId, ownCardId) {
  const tasks = state.snapshot.cards.filter(task => task.card_id !== ownCardId);
  if (!tasks.length) return '';
  return `<div class="link-task-control"><select id="task-target"><option value="">${linkedTaskId ? 'Move to another task…' : 'Link to an existing task…'}</option>${tasks.map(task => `<option value="${escapeHtml(task.card_id)}">${escapeHtml(task.title)}</option>`).join('')}</select><button class="button quiet" id="link-to-selected">Link</button></div>`;
}

function bindThreadDetail(detail) {
  $('#copy-thread-id').onclick = () => copyText(detail.thread_id, 'Thread ID copied');
  $('#make-thread-task')?.addEventListener('click', async () => {
    try { await api('/api/cards/thread', { method: 'POST', body: JSON.stringify({ thread_id: detail.thread_id }) }); await loadState({ quiet: true }); await openThread(detail.thread_id); toast('Thread added as a task'); }
    catch (error) { toast(error.message); }
  });
  $('#open-thread-task')?.addEventListener('click', event => openTask(event.currentTarget.dataset.taskId));
  $('#link-to-selected')?.addEventListener('click', async () => {
    const target = $('#task-target').value; if (!target) return;
    try { await api(`/api/tasks/${encodeURIComponent(target)}/threads`, { method: 'POST', body: JSON.stringify({ thread_id: detail.thread_id }) }); await loadState({ quiet: true }); await openTask(target); toast('Thread linked to task'); }
    catch (error) { toast(error.message); }
  });
  $$('.view-subagent').forEach(button => button.addEventListener('click', () => openThread(button.dataset.threadId)));
}

async function copyText(value, message) {
  try { await navigator.clipboard.writeText(value); toast(message); }
  catch { toast('Clipboard access was unavailable'); }
}

async function createTask(title, projectCwd) {
  await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title, project_cwd: projectCwd }) });
  await loadState(); toast('Task created');
}

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach(element => element.classList.toggle('active', element.id === `${view}-view`));
  renderSidebar();
  if (view === 'threads') loadThreads();
}

function bindGlobalEvents() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('#show-completed').addEventListener('change', loadState);
  $('#status-filter').addEventListener('change', event => { state.status = event.target.value; renderTasks(); });
  let searchTimer;
  $('#global-search').addEventListener('input', event => {
    state.query = event.target.value; clearTimeout(searchTimer);
    searchTimer = setTimeout(() => state.view === 'threads' ? loadThreads() : renderTasks(), 180);
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#global-search').focus(); }
    if (event.key === 'Escape' && $('#detail-drawer').classList.contains('open')) closeDrawer();
  });
  $('#quick-add-form').addEventListener('submit', async event => {
    event.preventDefault();
    const title = $('#quick-add-title').value.trim(); if (!title) return;
    try { await createTask(title, $('#quick-add-project').value); $('#quick-add-title').value = ''; $('#quick-add-title').focus(); }
    catch (error) { toast(error.message); }
  });
  $('#new-task').addEventListener('click', () => {
    $('#task-title-input').value = ''; $('#task-project-input').value = state.activeProject || '';
    $('#task-dialog').showModal(); setTimeout(() => $('#task-title-input').focus(), 20);
  });
  $('#task-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { await createTask($('#task-title-input').value.trim(), $('#task-project-input').value); $('#task-dialog').close(); }
    catch (error) { toast(error.message); }
  });
  $('#cancel-task').addEventListener('click', () => $('#task-dialog').close());
  $('#close-drawer').addEventListener('click', closeDrawer); $('#scrim').addEventListener('click', closeDrawer);
}

async function start() {
  bindGlobalEvents(); await loadState();
  state.refreshTimer = setInterval(() => {
    if (!document.hidden && !$('#detail-drawer').classList.contains('open')) loadState({ quiet: true });
  }, 5000);
}

start();
