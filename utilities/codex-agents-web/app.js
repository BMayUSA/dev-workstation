const state = {
  snapshot: null,
  view: 'board',
  query: '',
  activeTag: '',
  activeProject: '',
  status: '',
  activeDetail: null,
  saveTimers: new Map(),
  saveSequence: 0,
  refreshTimer: null,
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
  return state.snapshot?.statuses?.[status] || status.replaceAll('_', ' ');
}

function prettyOperational(status) {
  return ({
    working: 'Running', waiting_for_approval: 'Approval needed', waiting_on_agents: 'Waiting on agents',
    compacting: 'Compacting', idle: 'Turn complete', stale: 'Stale', done: 'Agent done',
    abandoned: 'Abandoned', ended: 'Ended', unknown: 'No live status',
  })[status] || status.replaceAll('_', ' ');
}

function relativeTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function workspaceName(path = '') {
  return path.split('/').filter(Boolean).at(-1) || 'No workspace';
}

function workspaceMarkup(path = '') {
  return `<span class="workspace-tag" title="${escapeHtml(path || 'Working directory unavailable')}">${escapeHtml(workspaceName(path))}</span>`;
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
    renderBoard();
    if (!quiet && state.view === 'threads') await loadThreads();
  } catch (error) {
    if (!quiet) toast(error.message);
  }
}

function renderSidebar() {
  const { cards, counts, tags, projects, index } = state.snapshot;
  $('#board-count').textContent = cards.length;
  $('#thread-count').textContent = counts.top_level || 0;
  const tagRoot = $('#tag-filters');
  tagRoot.innerHTML = tags.length ? tags.map(tag => `
    <button class="tag-filter ${state.activeTag === tag.name ? 'active' : ''}" data-tag="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</button>
  `).join('') : '<span class="muted">No tags yet</span>';
  $$('.tag-filter', tagRoot).forEach(button => button.addEventListener('click', () => {
    state.activeTag = state.activeTag === button.dataset.tag ? '' : button.dataset.tag;
    renderSidebar(); renderBoard();
  }));
  const projectRoot = $('#project-filters');
  projectRoot.innerHTML = projects.length ? projects.map(project => `
    <button class="project-filter ${state.activeProject === project.cwd ? 'active' : ''}" data-project="${escapeHtml(project.cwd)}" title="${escapeHtml(project.cwd)}">
      <span>${escapeHtml(workspaceName(project.cwd))}</span><small>${project.thread_count}</small>
    </button>
  `).join('') : '<span class="muted">No projects yet</span>';
  $$('.project-filter', projectRoot).forEach(button => button.addEventListener('click', () => {
    state.activeProject = state.activeProject === button.dataset.project ? '' : button.dataset.project;
    renderSidebar(); renderBoard();
    if (state.view === 'threads') loadThreads();
  }));
  const indexed = index.total ? `${index.indexed}/${index.total}` : '0';
  $('#index-status').textContent = index.error ? 'Conversation index paused' :
    index.running ? `Indexing conversations ${indexed}` : `Conversation search ready · ${indexed}`;
  $('.pulse-dot').classList.toggle('running', index.running);
}

function filteredCards() {
  const query = state.query.toLowerCase().trim();
  return state.snapshot.cards.filter(card => {
    if (state.status && card.workflow_status !== state.status) return false;
    if (state.activeTag && !card.tags.some(tag => tag.name === state.activeTag)) return false;
    if (state.activeProject && card.cwd !== state.activeProject) return false;
    if (!query) return true;
    return [card.title, card.preview, card.note, card.cwd, ...card.tags.map(tag => tag.name)]
      .some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderBoard() {
  if (!state.snapshot) return;
  const cards = filteredCards();
  const pinned = cards.filter(card => card.card_type === 'thread' && card.pinned_at);
  const recent = cards.filter(card => card.card_type === 'thread' && !card.pinned_at);
  const workItems = cards.filter(card => card.card_type === 'work_item');
  const root = $('#board');
  root.innerHTML = `${pinned.length ? boardSection('Pinned', pinned, 'Kept at the top') : ''}
    ${boardSection('Inbox', recent, 'Newest activity first')}
    ${workItems.length ? boardSection('Work items', workItems, 'Grouped threads') : ''}`;
  bindBoardEvents();
  renderLiveSummary(cards);
}

function boardSection(title, cards, note) {
  const empty = title === 'Inbox'
    ? '<div class="board-empty"><strong>Your board is clear</strong>New Codex threads will appear here automatically.</div>'
    : '';
  return `<section class="board-section">
    <header class="board-section-header">
      <div><h3>${title}</h3><span>${note}</span></div>
      <span class="board-section-count">${cards.length}</span>
    </header>
    <div class="board-rows">${cards.length ? cards.map(cardTemplate).join('') : empty}</div>
  </section>`;
}

function cardTemplate(card) {
  const operational = card.operational?.state || 'unknown';
  const tagMarkup = card.tags.slice(0, 3).map(tag => `<span class="tag">${escapeHtml(tag.name)}</span>`).join('');
  const workCount = card.card_type === 'work_item' ? `<span class="thread-count-badge">${card.threads.length} thread${card.threads.length === 1 ? '' : 's'}</span>` : '';
  const pinned = Boolean(card.pinned_at);
  const updatedAt = card.thread_updated_at || card.updated_at;
  return `<article class="card ${pinned ? 'pinned' : ''}" data-card-id="${escapeHtml(card.card_id)}">
    <div class="card-content">
      <div class="card-top">
        <span class="card-kind">${card.card_type === 'work_item' ? 'Work item' : 'Thread'}</span>
        ${workspaceMarkup(card.cwd)}
        <span class="operational-badge ${operational}">${escapeHtml(prettyOperational(operational))}</span>
      </div>
      <h4>${escapeHtml(card.title)}</h4>
      <p class="card-preview">${escapeHtml(card.preview || 'No preview available.')}</p>
      ${tagMarkup ? `<div class="card-tags">${tagMarkup}</div>` : ''}
    </div>
    <div class="card-aside">
      <time title="${escapeHtml(new Date(updatedAt * 1000).toLocaleString())}">${relativeTime(updatedAt)}</time>
      <span class="status-badge ${card.workflow_status}">${escapeHtml(prettyStatus(card.workflow_status))}</span>
      ${workCount}
      ${card.card_type === 'thread' ? `<div class="card-actions">
        <button class="icon-button board-pin ${pinned ? 'active' : ''}" data-card-id="${escapeHtml(card.card_id)}" data-pinned="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${escapeHtml(card.title)}" title="${pinned ? 'Unpin' : 'Pin'}">${pinned ? '◆' : '◇'}</button>
        <button class="icon-button board-dismiss" data-card-id="${escapeHtml(card.card_id)}" aria-label="Move ${escapeHtml(card.title)} to All threads" title="Move to All threads">×</button>
      </div>` : ''}
    </div>
  </article>`;
}

function bindBoardEvents() {
  $$('.card').forEach(card => {
    card.addEventListener('click', event => {
      if (!event.target.closest('button')) openCard(card.dataset.cardId);
    });
  });
  $$('.board-pin').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    await setPinned(button.dataset.cardId, button.dataset.pinned !== 'true');
  }));
  $$('.board-dismiss').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    try {
      await api(`/api/cards/${encodeURIComponent(button.dataset.cardId)}`, {
        method: 'PATCH', body: JSON.stringify({ dismissed: true }),
      });
      await loadState({ quiet: true }); toast('Moved to All threads');
    } catch (error) { toast(error.message); }
  }));
}

async function setPinned(cardId, pinned) {
  try {
    await api(`/api/cards/${encodeURIComponent(cardId)}`, {
      method: 'PATCH', body: JSON.stringify({ pinned }),
    });
    await loadState({ quiet: true });
    if (state.view === 'threads') await loadThreads();
    toast(pinned ? 'Pinned to the top' : 'Unpinned');
  } catch (error) { toast(error.message); }
}

function renderLiveSummary(cards) {
  const counts = {};
  cards.forEach(card => { const value = card.operational?.state || 'unknown'; counts[value] = (counts[value] || 0) + 1; });
  const items = [
    ['working', 'running'], ['waiting_for_approval', 'approval'], ['idle', 'idle'],
  ].filter(([key]) => counts[key]).map(([key, label]) => `<span class="summary-pill"><strong>${counts[key]}</strong> ${label}</span>`);
  $('#live-summary').innerHTML = items.join('') || '<span class="summary-pill">No live activity</span>';
}

async function loadThreads() {
  const root = $('#thread-list');
  root.innerHTML = '<div class="empty-state">Searching local history…</div>';
  try {
    const parameters = new URLSearchParams({ q: state.query });
    if (state.activeProject) parameters.set('cwd', state.activeProject);
    const payload = await api(`/api/threads?${parameters}`);
    root.innerHTML = payload.threads.length ? payload.threads.map(threadTemplate).join('') :
      '<div class="empty-state"><strong>No matching threads</strong>Try another title, phrase, or repository.</div>';
    $$('.thread-row', root).forEach(row => row.addEventListener('click', event => {
      if (!event.target.closest('button')) openThread(row.dataset.threadId);
    }));
    $$('.promote-thread', root).forEach(button => button.addEventListener('click', async event => {
      event.stopPropagation();
      try {
        const returning = button.textContent.trim() === 'Return to board';
        await api('/api/cards/thread', { method: 'POST', body: JSON.stringify({ thread_id: button.dataset.threadId }) });
        toast(returning ? 'Returned to board' : 'Added to board');
        await loadState({ quiet: true }); await loadThreads();
      } catch (error) { toast(error.message); }
    }));
    $$('.pin-thread', root).forEach(button => button.addEventListener('click', async event => {
      event.stopPropagation();
      await setPinned(button.dataset.cardId, button.dataset.pinned !== 'true');
    }));
  } catch (error) { root.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`; }
}

function threadTemplate(thread) {
  let action;
  if (thread.work_item_id) {
    action = '<span class="status-badge">In work item</span>';
  } else if (thread.card_id && !thread.dismissed_at) {
    const pinned = Boolean(thread.pinned_at);
    action = `<button class="button quiet pin-thread" data-card-id="${escapeHtml(thread.card_id)}" data-pinned="${pinned}">${pinned ? 'Unpin' : 'Pin'}</button>`;
  } else {
    const label = thread.dismissed_at ? 'Return to board' : 'Add to board';
    action = `<button class="button quiet promote-thread" data-thread-id="${escapeHtml(thread.thread_id)}">${label}</button>`;
  }
  return `<div class="thread-row" data-thread-id="${escapeHtml(thread.thread_id)}">
    <div class="thread-main"><strong>${escapeHtml(thread.title || 'Untitled thread')}</strong><p>${escapeHtml(thread.preview || thread.thread_id)}</p></div>
    <div class="thread-workspace">${workspaceMarkup(thread.cwd)}<span title="${escapeHtml(thread.cwd)}">${escapeHtml(thread.cwd || 'Unavailable')}</span></div>
    <div class="thread-date">${relativeTime(thread.updated_at)}</div>
    <div class="row-action">${action}</div>
  </div>`;
}

async function openCard(cardId) {
  try {
    const detail = await api(`/api/cards/${encodeURIComponent(cardId)}`);
    state.activeDetail = { kind: 'card', value: detail };
    renderCardDetail(detail); openDrawer();
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

function cardFields(detail) {
  return `<div class="detail-grid">
    <label class="field"><span>Display title</span><input id="detail-title-input" value="${escapeHtml(detail.title_override || detail.title || '')}"></label>
    <label class="field"><span>Workflow status</span><select id="detail-status">
      ${Object.entries(state.snapshot.statuses).map(([value, label]) => `<option value="${value}" ${detail.workflow_status === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
    </select></label>
  </div>
  <label class="field"><span>Tags · comma separated</span><input id="detail-tags" value="${escapeHtml((detail.tags || []).map(tag => tag.name).join(', '))}" placeholder="research, bug, follow-up"></label>
  <label class="field" style="margin-top: 16px"><span>Note · Markdown</span><textarea id="detail-note" placeholder="Leave the context you want to remember…">${escapeHtml(detail.note || '')}</textarea></label>`;
}

function renderCardDetail(detail) {
  $('#copy-thread-id').hidden = detail.card_type !== 'thread';
  const saveStatus = $('#auto-save-status');
  saveStatus.hidden = false; saveStatus.textContent = 'All changes saved'; saveStatus.className = 'save-state saved';
  const operational = detail.operational?.state || 'unknown';
  const children = detail.card_type === 'work_item' ? `
    <section class="detail-section"><div class="detail-section-heading"><h3>Threads</h3><span class="muted">${detail.threads.length}</span></div>
      <div>${detail.threads.map(thread => `<div class="child-thread"><div><strong>${escapeHtml(thread.native_title)}</strong><span>${escapeHtml(workspaceName(thread.cwd))} · ${relativeTime(thread.updated_at)}</span></div><div class="inline-actions"><button class="button quiet view-child" data-thread-id="${escapeHtml(thread.thread_id)}">View</button><button class="button quiet detach-child" data-thread-id="${escapeHtml(thread.thread_id)}">Remove</button></div></div>`).join('') || '<p class="muted">No threads attached yet.</p>'}</div>
      <div class="attach-row"><input id="attach-thread-id" placeholder="Paste a thread ID"><button class="button secondary" id="attach-thread">Attach</button></div>
    </section>` : '';
  $('#drawer-content').innerHTML = `
    <div class="detail-eyebrow"><span>${detail.card_type === 'work_item' ? 'Work item' : 'Thread card'}</span><span class="operational-badge ${operational}">${escapeHtml(prettyOperational(operational))}</span></div>
    <h2 class="detail-title">${escapeHtml(detail.title)}</h2>
    <div class="detail-meta">${detail.cwd ? `<span>${escapeHtml(detail.cwd)}</span>` : ''}${detail.thread_id ? `<span>${escapeHtml(detail.thread_id)}</span>` : ''}</div>
    ${cardFields(detail)}
    ${children}
    ${detail.card_type === 'thread' ? `<section class="detail-section detail-board-actions"><button class="button secondary" id="view-conversation">View full conversation</button><button class="button quiet" id="toggle-pin-card">${detail.pinned_at ? 'Unpin' : 'Pin to top'}</button><button class="button danger" id="dismiss-card">Move to All threads</button></section>` : ''}`;
  bindCardDetail(detail);
}

function bindCardDetail(detail) {
  $('#copy-thread-id').onclick = () => copyText(detail.thread_id, 'Thread ID copied');
  $('#detail-title-input').addEventListener('input', event => {
    $('.detail-title').textContent = event.target.value || detail.title;
    scheduleCardSave();
  });
  $('#detail-tags').addEventListener('input', () => scheduleCardSave());
  $('#detail-note').addEventListener('input', () => scheduleCardSave());
  $('#detail-status').addEventListener('change', () => scheduleCardSave(0));
  $('#toggle-pin-card')?.addEventListener('click', async () => {
    await setPinned(detail.card_id, !detail.pinned_at); closeDrawer();
  });
  if ($('#dismiss-card')) $('#dismiss-card').onclick = async () => {
    try { await api(`/api/cards/${encodeURIComponent(detail.card_id)}`, { method: 'PATCH', body: JSON.stringify({ dismissed: true }) }); closeDrawer(); await loadState(); toast('Moved to All threads'); }
    catch (error) { toast(error.message); }
  };
  $('#view-conversation')?.addEventListener('click', () => openThread(detail.thread_id));
  $$('.view-child').forEach(button => button.addEventListener('click', () => openThread(button.dataset.threadId)));
  $$('.detach-child').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/api/work-items/${encodeURIComponent(detail.card_id)}/threads/${encodeURIComponent(button.dataset.threadId)}`, { method: 'DELETE' }); await openCard(detail.card_id); await loadState({ quiet: true }); toast('Thread returned to the board'); }
    catch (error) { toast(error.message); }
  }));
  $('#attach-thread')?.addEventListener('click', async () => {
    const threadId = $('#attach-thread-id').value.trim(); if (!threadId) return;
    try { await api(`/api/work-items/${encodeURIComponent(detail.card_id)}/threads`, { method: 'POST', body: JSON.stringify({ thread_id: threadId }) }); await openCard(detail.card_id); await loadState({ quiet: true }); toast('Thread attached'); }
    catch (error) { toast(error.message); }
  });
}

function currentCardChanges() {
  const title = $('#detail-title-input');
  const tags = $('#detail-tags');
  const note = $('#detail-note');
  const status = $('#detail-status');
  if (!title || !tags || !note || !status) return null;
  return {
    title_override: title.value.trim(),
    note: note.value,
    workflow_status: status.value,
    tags: tags.value.split(',').map(value => value.trim()).filter(Boolean),
  };
}

function scheduleCardSave(delay = 550) {
  const detail = state.activeDetail?.value;
  const changes = currentCardChanges();
  if (!detail?.card_id || !changes) return;
  const cardId = detail.card_id;
  const sequence = ++state.saveSequence;
  const status = $('#auto-save-status');
  status.hidden = false; status.textContent = 'Saving…'; status.className = 'save-state saving';
  clearTimeout(state.saveTimers.get(cardId));
  state.saveTimers.set(cardId, setTimeout(() => {
    state.saveTimers.delete(cardId);
    saveCardChanges(cardId, changes, sequence);
  }, delay));
}

async function saveCardChanges(cardId, changes, sequence) {
  try {
    const updated = await api(`/api/cards/${encodeURIComponent(cardId)}`, {
      method: 'PATCH', body: JSON.stringify(changes),
    });
    if (sequence !== state.saveSequence) return;
    if (state.activeDetail?.kind === 'card' && state.activeDetail.value.card_id === cardId) {
      state.activeDetail.value = updated;
      const status = $('#auto-save-status');
      status.hidden = false; status.textContent = 'All changes saved'; status.className = 'save-state saved';
    }
    await loadState({ quiet: true });
  } catch (error) {
    if (sequence !== state.saveSequence) return;
    const status = $('#auto-save-status');
    status.hidden = false; status.textContent = 'Could not save'; status.className = 'save-state error';
    toast(error.message);
  }
}

function renderThreadDetail(detail) {
  $('#copy-thread-id').hidden = false; $('#auto-save-status').hidden = true;
  const operational = detail.operational?.state || 'unknown';
  const messages = detail.messages.map(message => `<article class="message ${message.role}"><div class="message-role">${message.role}</div><div class="message-text">${escapeHtml(message.text)}</div></article>`).join('');
  const tools = detail.tools.map(tool => `<details><summary>${escapeHtml(tool.name)}${tool.status ? ` · ${escapeHtml(tool.status)}` : ''}</summary><div class="tool-output">${escapeHtml(tool.input)}${tool.output ? `\n\nOutput\n${escapeHtml(tool.output)}` : ''}</div></details>`).join('');
  const subagents = detail.subagents.map(thread => `<div class="child-thread"><div><strong>${escapeHtml(thread.native_title || 'Subagent')}</strong><span>${relativeTime(thread.updated_at)}</span></div><button class="button quiet view-subagent" data-thread-id="${escapeHtml(thread.thread_id)}">View</button></div>`).join('');
  const cardAction = detail.work_item_id ? '' : detail.dismissed_at
    ? `<button class="button secondary" id="promote-detail">Return to board</button>`
    : detail.card_id
      ? `<button class="button quiet" id="pin-detail">${detail.pinned_at ? 'Unpin' : 'Pin to top'}</button>`
      : `<button class="button secondary" id="promote-detail">Add to board</button>`;
  const attachOptions = workItemOptions(detail.work_item_id);
  $('#drawer-content').innerHTML = `
    <div class="detail-eyebrow"><span>Codex thread</span><span class="operational-badge ${operational}">${escapeHtml(prettyOperational(operational))}</span></div>
    <h2 class="detail-title">${escapeHtml(detail.title)}</h2>
    <div class="detail-meta"><span>${escapeHtml(detail.cwd)}</span><span>${escapeHtml(detail.model || 'Unknown model')}</span><span>${escapeHtml(detail.thread_id)}</span><span>${relativeTime(detail.updated_at)}</span></div>
    <div class="inline-actions">${cardAction}${attachOptions}</div>
    ${subagents ? `<section class="detail-section"><div class="detail-section-heading"><h3>Subagents</h3><span class="muted">${detail.subagents.length}</span></div>${subagents}</section>` : ''}
    <section class="detail-section"><div class="detail-section-heading"><h3>Conversation</h3><span class="muted">${detail.messages.length} messages</span></div><div class="conversation">${messages || '<p class="muted">No readable conversation events found.</p>'}</div></section>
    ${tools ? `<section class="detail-section tool-activity"><div class="detail-section-heading"><h3>Tool activity</h3><span class="muted">${detail.tools.length}</span></div>${tools}</section>` : ''}`;
  bindThreadDetail(detail);
}

function workItemOptions(selected) {
  const workItems = state.snapshot.cards.filter(card => card.card_type === 'work_item');
  if (!workItems.length) return '';
  return `<div class="inline-actions"><select id="work-item-target"><option value="">Attach to work item…</option>${workItems.map(item => `<option value="${escapeHtml(item.card_id)}" ${selected === item.card_id ? 'selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}</select><button class="button quiet" id="attach-to-selected">Attach</button></div>`;
}

function bindThreadDetail(detail) {
  $('#copy-thread-id').onclick = () => copyText(detail.thread_id, 'Thread ID copied');
  $('#promote-detail')?.addEventListener('click', async () => {
    try { await api('/api/cards/thread', { method: 'POST', body: JSON.stringify({ thread_id: detail.thread_id }) }); await loadState({ quiet: true }); await openThread(detail.thread_id); toast(detail.dismissed_at ? 'Returned to board' : 'Added to board'); }
    catch (error) { toast(error.message); }
  });
  $('#pin-detail')?.addEventListener('click', async () => {
    await setPinned(detail.card_id, !detail.pinned_at); await openThread(detail.thread_id);
  });
  $('#attach-to-selected')?.addEventListener('click', async () => {
    const target = $('#work-item-target').value; if (!target) return;
    try { await api(`/api/work-items/${encodeURIComponent(target)}/threads`, { method: 'POST', body: JSON.stringify({ thread_id: detail.thread_id }) }); await loadState({ quiet: true }); await openThread(detail.thread_id); toast('Attached to work item'); }
    catch (error) { toast(error.message); }
  });
  $$('.view-subagent').forEach(button => button.addEventListener('click', () => openThread(button.dataset.threadId)));
}

async function copyText(value, message) {
  try { await navigator.clipboard.writeText(value); toast(message); }
  catch { toast('Clipboard access was unavailable'); }
}

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach(element => element.classList.toggle('active', element.id === `${view}-view`));
  if (view === 'threads') loadThreads();
}

function showPrompt({ eyebrow, title, label, confirm, onConfirm }) {
  const dialog = $('#prompt-dialog');
  $('#dialog-eyebrow').textContent = eyebrow; $('#dialog-title').textContent = title;
  $('#dialog-label').textContent = label; $('#dialog-confirm').textContent = confirm; $('#dialog-input').value = '';
  dialog._onConfirm = onConfirm; dialog.showModal(); setTimeout(() => $('#dialog-input').focus(), 20);
}

function bindGlobalEvents() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('#show-completed').addEventListener('change', () => loadState());
  $('#status-filter').addEventListener('change', event => { state.status = event.target.value; renderBoard(); });
  let searchTimer;
  $('#global-search').addEventListener('input', event => {
    state.query = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => state.view === 'threads' ? loadThreads() : renderBoard(), 180);
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#global-search').focus(); }
    if (event.key === 'Escape' && $('#detail-drawer').classList.contains('open')) closeDrawer();
  });
  $('#new-work-item').addEventListener('click', () => showPrompt({ eyebrow: 'Group related work', title: 'Create a work item', label: 'Work item title', confirm: 'Create work item', onConfirm: async title => { await api('/api/work-items', { method: 'POST', body: JSON.stringify({ title }) }); await loadState(); toast('Work item added to Inbox'); } }));
  $('#prompt-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { await $('#prompt-dialog')._onConfirm($('#dialog-input').value.trim()); $('#prompt-dialog').close(); }
    catch (error) { toast(error.message); }
  });
  $('#close-drawer').addEventListener('click', closeDrawer); $('#scrim').addEventListener('click', closeDrawer);
}

async function start() {
  bindGlobalEvents();
  await loadState();
  state.refreshTimer = setInterval(() => {
    if (!document.hidden && !$('#detail-drawer').classList.contains('open')) loadState({ quiet: true });
  }, 5000);
}

start();
