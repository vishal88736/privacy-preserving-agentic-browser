/**
 * PrivAgent Side Panel Controller
 * XSS-safe rendering (no innerHTML with page-derived data).
 * UI state always mirrors background task state.
 */

import { MessageType } from '../shared/messages.js';
import { AgentState } from '../shared/constants.js';

const FRIENDLY_STATE = {
  [AgentState.IDLE]: { label: 'Idle', detail: 'Tell me what to do on this page.', band: 'idle', dot: 'idle' },
  [AgentState.UNDERSTANDING_TASK]: { label: 'Understanding', detail: 'Breaking down your goal…', band: 'active', dot: 'active' },
  [AgentState.OBSERVING]: { label: 'Observing', detail: 'Reading page structure and layout…', band: 'active', dot: 'active' },
  [AgentState.SANITIZING]: { label: 'Protecting', detail: 'Redacting sensitive fields locally…', band: 'active', dot: 'active' },
  [AgentState.VISUAL_ANALYSIS]: { label: 'Analyzing view', detail: 'Interpreting the visual layout…', band: 'active', dot: 'active' },
  [AgentState.PLANNING]: { label: 'Planning', detail: 'Deciding the next safe action…', band: 'active', dot: 'active' },
  [AgentState.REASONING]: { label: 'Planning', detail: 'Deciding the next safe action…', band: 'active', dot: 'active' },
  [AgentState.VALIDATING_ACTION]: { label: 'Checking safety', detail: 'Validating action and privacy…', band: 'active', dot: 'active' },
  [AgentState.EXECUTING]: { label: 'Acting', detail: 'Performing the action in the page…', band: 'active', dot: 'active' },
  [AgentState.VERIFYING]: { label: 'Verifying', detail: 'Checking the result…', band: 'active', dot: 'active' },
  [AgentState.WAITING_FOR_USER]: { label: 'Needs approval', detail: 'Waiting for your decision…', band: 'waiting', dot: 'waiting' },
  [AgentState.COMPLETED]: { label: 'Completed', detail: 'Goal reached.', band: 'done', dot: 'done' },
  [AgentState.FAILED]: { label: 'Attention needed', detail: 'Something went wrong.', band: 'error', dot: 'error' },
  [AgentState.CANCELLED]: { label: 'Stopped', detail: 'You took back control.', band: 'idle', dot: 'idle' }
};

const PROGRESS_STAGES = [
  { key: 'understand', label: 'Understanding task' },
  { key: 'observe', label: 'Page analyzed' },
  { key: 'privacy', label: 'Privacy scan completed' },
  { key: 'act', label: 'Performing actions' },
  { key: 'verify', label: 'Verified & done' }
];

function stageForState(state) {
  switch (state) {
    case AgentState.UNDERSTANDING_TASK: return 0;
    case AgentState.OBSERVING:
    case AgentState.SANITIZING:
    case AgentState.VISUAL_ANALYSIS: return 1;
    case AgentState.PLANNING:
    case AgentState.REASONING:
    case AgentState.VALIDATING_ACTION: return 2;
    case AgentState.EXECUTING: return 3;
    case AgentState.VERIFYING:
    case AgentState.WAITING_FOR_USER: return 3;
    case AgentState.COMPLETED: return 4;
    default: return -1;
  }
}

/** Summarize model output for display: concise, no chain-of-thought, no secrets. */
export function summarizeThought(thought, action) {
  let t = String(thought || '').trim();
  // Drop common reasoning preamble
  t = t.replace(/^(because|since|as)\b[^.]*\.\s*/i, '');
  // Strip internal element-id references (el_1) and coordinate chatter
  t = t.replace(/\(el_\d+\)/gi, '');
  t = t.replace(/\bel_\d+\b/gi, 'this field');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/[#*`>_]/g, '');
  // Never display long digit runs (possible IDs/numbers) in activity text
  t = t.replace(/\b\d{4}[\s-]?\d{2,}\b/g, '••••');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > 220) t = t.slice(0, 217) + '…';
  if (!t) {
    const verb = action?.action || 'ACTION';
    const target = action?.target?.label || action?.target?.element_id || 'page';
    t = `${verb} → ${target}`;
  }
  return t;
}

export function friendlyActionLabel(action) {
  if (!action?.action) return 'Step';
  const target = action.target?.label || action.target?.element_id || '';
  switch (action.action) {
    case 'TYPE': return target ? `Fill “${target}”` : 'Fill field';
    case 'CLICK': return target ? `Click “${target}”` : 'Click';
    case 'SUBMIT': return target ? `Submit via “${target}”` : 'Submit';
    case 'UPLOAD': return 'Upload document';
    case 'NAVIGATE': return `Open ${action.target?.url || 'page'}`;
    case 'SELECT': return target ? `Choose option in “${target}”` : 'Select option';
    case 'SCROLL': return 'Scroll page';
    case 'WAIT': return 'Wait for page';
    case 'DONE': return 'Done';
    default: return action.action.charAt(0) + action.action.slice(1).toLowerCase();
  }
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return ''; }
}

class SidePanelApp {
  constructor() {
    this.task = null;
    this.lastPrompt = '';
    this.taskStartWall = null;
    this.elapsedTimer = null;
    this.init();
  }

  $(id) { return document.getElementById(id); }

  init() {
    this.cache();
    this.applyTheme();
    this.bind();
    this.applySettingsToUI();
    this.listen();
    this.pollStatus();
    this.renderPrivacyStatic();
  }

  cache() {
    this.promptInput = this.$('task-prompt');
    this.startBtn = this.$('start-task-btn');
    this.sendBtn = this.$('submit-task-btn');
    this.pauseBtn = this.$('pause-task-btn');
    this.stopBtn = this.$('stop-task-btn');
    this.retryBtn = this.$('retry-task-btn');
    this.clearBtn = this.$('clear-task-btn');
    this.banner = this.$('status-banner');
    this.stateText = this.$('agent-state-text');
    this.subText = this.$('agent-substatus-text');
    this.stepBadge = this.$('step-counter');
    this.headerDot = this.$('header-dot');
    this.headerSub = this.$('header-sub');
    this.currentCard = this.$('current-task-card');
    this.currentPrompt = this.$('current-task-prompt');
    this.progressList = this.$('task-progress');
    this.elapsed = this.$('task-elapsed');
    this.emptyState = this.$('empty-state');
    this.doneState = this.$('done-state');
    this.doneSummary = this.$('done-summary');
    this.donePrivacy = this.$('done-privacy');
    this.errorState = this.$('error-state');
    this.errorSummary = this.$('error-summary');
    this.errorHint = this.$('error-hint');
    this.feed = this.$('activity-feed');
    this.feedEmpty = this.$('activity-empty');
    this.activityCount = this.$('activity-count');
    this.metricSensitive = this.$('metric-sensitive-count');
    this.metricCalls = this.$('metric-server-calls');
    this.metricSteps = this.$('metric-steps');
    this.privacyCats = this.$('privacy-categories');
    this.localList = this.$('local-items-list');
    this.debugPanel = this.$('debug-panel');
    this.debugBody = this.$('debug-body');
    // Modals
    this.confirmModal = this.$('confirmation-modal');
    this.privacyModal = this.$('privacy-modal');
    this.vaultModal = this.$('vault-modal');
    this.settingsModal = this.$('settings-modal');
  }

  bind() {
    this.startBtn.addEventListener('click', () => this.start());
    this.sendBtn.addEventListener('click', () => this.start());
    this.promptInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.start(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeAllModals();
    });
    this.clearBtn.addEventListener('click', () => { this.promptInput.value = ''; this.promptInput.focus(); });
    this.pauseBtn.addEventListener('click', () => this.togglePause());
    this.stopBtn.addEventListener('click', () => this.stop());
    this.retryBtn.addEventListener('click', () => this.retry());
    this.$('error-retry-btn').addEventListener('click', () => this.retry());
    this.$('error-takeover-btn').addEventListener('click', () => this.stop());
    this.$('error-dismiss-btn').addEventListener('click', () => this.hideStatePanels());
    this.$('done-dismiss-btn').addEventListener('click', () => this.hideStatePanels());
    this.$('done-new-btn').addEventListener('click', () => { this.hideStatePanels(); this.promptInput.focus(); });

    this.queryChips().forEach((c) => c.addEventListener('click', () => {
      this.promptInput.value = c.getAttribute('data-prompt') || '';
      this.start();
    }));

    this.$('modal-approve-btn').addEventListener('click', () => this.confirm(true));
    this.$('modal-reject-btn').addEventListener('click', () => this.confirm(false));

    this.$('privacy-pill').addEventListener('click', () => this.openModal(this.privacyModal));
    this.$('close-privacy-btn').addEventListener('click', () => this.closeModal(this.privacyModal));
    this.$('privacy-sheet-close-btn').addEventListener('click', () => this.closeModal(this.privacyModal));

    this.$('vault-btn').addEventListener('click', () => this.openVault());
    this.$('close-vault-btn').addEventListener('click', () => this.closeModal(this.vaultModal));
    this.$('save-vault-btn').addEventListener('click', () => this.saveVault());

    this.$('settings-btn').addEventListener('click', () => this.openSettings());
    this.$('close-settings-btn').addEventListener('click', () => this.closeModal(this.settingsModal));
    this.$('save-settings-btn').addEventListener('click', () => this.saveSettings());

    this.$('theme-btn').addEventListener('click', () => this.toggleTheme());
  }

  queryChips() { return Array.from(document.querySelectorAll('.chip')); }

  send(type, payload, cb) {
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) { cb?.(null); return; }
        cb?.(res);
      });
    } catch { cb?.(null); }
  }

  listen() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === MessageType.AGENT_STATUS_UPDATE) this.onUpdate(msg.payload);
    });
  }

  pollStatus() {
    this.send(MessageType.GET_AGENT_STATUS, undefined, (res) => {
      if (res?.task && res.task.state !== AgentState.IDLE) {
        this.task = res.task;
        this.lastPrompt = res.task.prompt || this.lastPrompt;
        this.renderAll();
      }
      if (res?.settings) this.reflectSettings(res.settings);
    });
  }

  // ---- actions ----
  async activeTabId() {
    try {
      // If there are multiple tabs, find an active webpage tab (not chrome-extension://)
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const webTab = tabs.find(t => t.active && !String(t.url || '').startsWith('chrome-extension://'));
      if (webTab) return webTab.id;
      const nonExt = tabs.find(t => !String(t.url || '').startsWith('chrome-extension://'));
      if (nonExt) return nonExt.id;
      // Check all tabs across windows if needed
      const allTabs = await chrome.tabs.query({});
      const anyWebTab = allTabs.find(t => !String(t.url || '').startsWith('chrome-extension://'));
      if (anyWebTab) return anyWebTab.id;
      let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id ?? null;
    } catch { return null; }
  }

  async start() {
    const prompt = this.promptInput.value.trim();
    if (!prompt || this.busy) return;
    const tabId = await this.activeTabId();
    if (!tabId) { this.showError('No active tab found.', 'Open a website first, then start the agent.'); return; }
    this.busy = true;
    this.lastPrompt = prompt;
    this.feed.replaceChildren();
    this.feedEmpty = el('p', 'muted small', 'Starting…');
    this.feed.appendChild(this.feedEmpty);
    this.hideStatePanels();
    this.setControls('running');
    this.send(MessageType.START_TASK, { prompt, tabId }, () => { this.busy = false; });
  }

  togglePause() {
    const willPause = this.pauseBtn.textContent === 'Pause';
    this.pauseBtn.textContent = willPause ? 'Resume' : 'Pause';
    this.send(willPause ? MessageType.PAUSE_TASK : MessageType.RESUME_TASK);
  }

  stop() {
    this.send(MessageType.CANCEL_TASK);
    this.closeModal(this.confirmModal);
    this.setControls('idle');
  }

  retry() {
    const prompt = this.lastPrompt || this.task?.prompt || this.promptInput.value.trim();
    if (!prompt) { this.promptInput.focus(); return; }
    this.promptInput.value = prompt;
    this.hideStatePanels();
    this.start();
  }

  confirm(approved) {
    this.closeModal(this.confirmModal);
    this.send(MessageType.USER_CONFIRM_ACTION, { approved });
  }

  setControls(mode) {
    const running = mode === 'running';
    const failed = mode === 'failed';
    this.startBtn.hidden = running;
    this.sendBtn.disabled = running;
    this.promptInput.disabled = running;
    this.pauseBtn.hidden = !running;
    this.stopBtn.hidden = !running;
    this.retryBtn.hidden = !(failed || mode === 'done');
    if (!running) this.pauseBtn.textContent = 'Pause';
  }

  // ---- updates ----
  onUpdate({ event, data, task }) {
    if (task) this.task = task;
    if (event === 'TASK_STARTED') {
      this.taskStartWall = Date.now();
      this.startElapsed();
      this.hideStatePanels();
      // Render first: the STARTED snapshot may still carry state IDLE,
      // whose idle-branch would otherwise undo the running controls.
      this.renderAll();
      this.setControls('running');
      return;
    }
    this.renderAll();
    switch (event) {
      case 'STATE_CHANGED': break;
      case 'PRIVACY_UPDATED': break;
      case 'STEP_COMPLETED': if (data) this.addStep(data, 'done'); break;
      case 'STEP_FAILED': if (data) this.addStep(data, 'failed'); break;
      case 'CONFIRMATION_REQUIRED': this.showConfirmation(data); break;
      case 'TASK_COMPLETED': this.showDone(data); break;
      case 'TASK_FAILED': this.showError(data?.error, data?.hint); break;
      case 'TASK_CANCELLED': this.showStopped(); break;
      default: break;
    }
    this.renderDebug();
  }

  renderAll() {
    const t = this.task;
    const state = t?.state || AgentState.IDLE;
    const info = FRIENDLY_STATE[state] || FRIENDLY_STATE[AgentState.IDLE];
    this.banner.dataset.state = info.band;
    this.headerDot.dataset.state = info.dot;
    this.stateText.textContent = info.label;
    this.subText.textContent = t?.stateDetail || info.detail;
    this.headerSub.textContent = t?.prompt ? truncate(t.prompt, 60) : 'Privacy-preserving browser agent';
    this.stepBadge.textContent = `Step ${t?.currentStep ?? 0}`;
    this.metricSteps.textContent = String(t?.currentStep ?? 0);
    if (t?.privacyMetrics) this.renderPrivacyMetrics(t.privacyMetrics);
    this.renderCurrentTask();
    this.activityCount.textContent = t?.steps?.length ? `${t.steps.length} step${t.steps.length === 1 ? '' : 's'}` : '';
    if (!t || state === AgentState.IDLE) {
      this.emptyState.hidden = false;
      this.setControls('idle');
    } else {
      this.emptyState.hidden = true;
    }
    if (state === AgentState.COMPLETED || state === AgentState.FAILED || state === AgentState.CANCELLED) {
      this.stopElapsed();
    }
  }

  renderCurrentTask() {
    const t = this.task;
    if (!t?.prompt || t.state === AgentState.IDLE) { this.currentCard.hidden = true; return; }
    this.currentCard.hidden = false;
    this.currentPrompt.textContent = t.prompt;
    const activeIdx = stageForState(t.state);
    this.progressList.replaceChildren();
    PROGRESS_STAGES.forEach((s, i) => {
      const li = el('li');
      const mk = el('span', 'mk', i < activeIdx || t.state === AgentState.COMPLETED ? '✓' : (i === activeIdx ? '●' : '○'));
      li.appendChild(mk);
      li.appendChild(el('span', null, s.label));
      li.className = i < activeIdx || t.state === AgentState.COMPLETED ? 'done' : (i === activeIdx ? 'active' : '');
      this.progressList.appendChild(li);
    });
  }

  renderPrivacyStatic() {
    this.localList.replaceChildren();
    ['Aadhaar & PAN numbers', 'Passwords & OTPs', 'Identity documents', 'Form keystrokes'].forEach((s) => {
      const li = el('li');
      li.appendChild(el('span', 'tick', '✓'));
      li.appendChild(el('span', null, s));
      this.localList.appendChild(li);
    });
    this.renderPrivacySheet(['Aadhaar', 'PAN', 'Passwords', 'Documents']);
  }

  renderPrivacyMetrics(m) {
    // "Current page" counts describe this observation; cumulative totals live in debug.
    const current = m.sensitiveFieldsCurrent ?? m.sensitiveFieldsDetected ?? 0;
    this.metricSensitive.textContent = String(current);
    this.metricCalls.textContent = String(m.serverCallsCount ?? 0);
    const cats = m.detectedCategories || [];
    this.privacyCats.textContent = cats.length ? `Detected this task: ${cats.join(', ')}` : '';
    this.$('privacy-pill-text').textContent = current > 0
      ? `${current} field${current === 1 ? '' : 's'} local`
      : 'Protected';
    if (cats.length) this.renderPrivacySheet(cats);
  }

  renderPrivacySheet(cats) {
    const ul = this.$('privacy-sheet-local');
    ul.replaceChildren();
    (cats.length ? cats : ['Aadhaar', 'PAN', 'Passwords', 'Documents']).forEach((c) => {
      const li = el('li');
      li.appendChild(el('span', 'tick', '✓'));
      li.appendChild(el('span', null, String(c)));
      ul.appendChild(li);
    });
  }

  addStep(data, status) {
    if (this.feedEmpty) { this.feedEmpty.remove(); this.feedEmpty = null; }
    while (this.feed.children.length > 80) this.feed.firstChild.remove();
    const item = el('div', 'timeline-item');
    item.dataset.status = status === 'failed' ? 'failed' : 'done';
    const mark = el('span', 'timeline-mark', status === 'failed' ? '!' : '✓');
    mark.setAttribute('aria-hidden', 'true');
    const body = el('div', 'timeline-body');
    const title = el('p', 'timeline-title', friendlyActionLabel(data.action));
    const sub = el('p', 'timeline-sub', summarizeThought(data.thought, data.action));
    body.appendChild(title);
    body.appendChild(sub);
    const meta = el('div', 'timeline-meta');
    const risk = el('span', `risk-badge risk-${data.action?.risk || 'LOW'}`, data.action?.risk || 'LOW');
    meta.appendChild(risk);
    meta.appendChild(el('span', 'time-stamp', `Step ${data.stepNumber ?? ''} · ${fmtTime(data.timestamp || Date.now())}`));
    if (data.action?.value_source) {
      meta.appendChild(el('span', 'time-stamp', `via ${data.action.value_source} (local)`));
    }
    body.appendChild(meta);
    const target = data.action?.target?.label || data.action?.target?.element_id;
    if (target || data.result) {
      const det = document.createElement('details');
      const sum = el('summary', null, 'Details');
      det.appendChild(sum);
      const lines = [];
      if (target) lines.push(`target: ${target}`);
      if (data.action?.value_source) lines.push(`value: ${data.action.value_source} → resolved locally`);
      else if (data.action?.value) lines.push('value: non-sensitive text');
      if (data.result && typeof data.result === 'object') {
        const r = data.result.uploadedFile ? `uploaded: ${data.result.uploadedFile}` : (data.result.navigatedTo ? `opened: ${data.result.navigatedTo}` : '');
        if (r) lines.push(r);
      }
      if (data.error) lines.push(`note: ${String(data.error).slice(0, 180)}`);
      det.appendChild(el('div', 'timeline-detail', lines.join('\n') || '—'));
      body.appendChild(det);
    }
    item.appendChild(mark);
    item.appendChild(body);
    this.feed.appendChild(item);
    this.feed.scrollTop = this.feed.scrollHeight;
    if (this.task) this.activityCount.textContent = `${this.feed.children.length} step${this.feed.children.length === 1 ? '' : 's'}`;
  }

  showConfirmation(data) {
    if (!data?.action) return;
    this.$('confirm-reason').textContent = data.reason || 'This action needs your approval.';
    this.$('confirm-action-verb').textContent = data.action.action || 'ACTION';
    this.$('confirm-action-target').textContent = data.action.target?.label || data.action.target?.element_id || data.action.target?.url || 'Page';
    this.$('confirm-data-local').textContent = data.action.value_source ? `${data.action.value_source} (stays local)` : (data.privacySummary?.dataKeptLocal || 'No secret values');
    this.openModal(this.confirmModal);
    this.$('modal-approve-btn').focus();
  }

  showDone(data) {
    this.setControls('done');
    this.closeModal(this.confirmModal);
    this.doneState.hidden = false;
    this.errorState.hidden = true;
    this.doneSummary.textContent = data?.result || 'The agent finished the task.';
    const m = this.task?.privacyMetrics;
    const keptLocal = m ? (m.sensitiveFieldsCurrent ?? m.sensitiveFieldsDetected ?? 0) : 0;
    this.donePrivacy.textContent = m && keptLocal
      ? `${keptLocal} sensitive field${keptLocal === 1 ? '' : 's'} stayed on this device.`
      : 'No sensitive fields were needed.';
    this.stopElapsed();
  }

  showError(error, hint) {
    this.setControls('failed');
    this.closeModal(this.confirmModal);
    this.errorState.hidden = false;
    this.doneState.hidden = true;
    this.errorSummary.textContent = error || 'The task could not be completed.';
    this.errorHint.textContent = hint || 'You can retry, or take control to continue manually.';
    this.stopElapsed();
  }

  showStopped() {
    this.setControls('idle');
    this.closeModal(this.confirmModal);
    this.hideStatePanels();
    this.subText.textContent = 'Stopped. You are in control.';
    this.stopElapsed();
  }

  hideStatePanels() {
    this.doneState.hidden = true;
    this.errorState.hidden = true;
  }

  // ---- vault / settings / theme ----
  openModal(m) { m.hidden = false; }
  closeModal(m) { m.hidden = true; }
  closeAllModals() { [this.confirmModal, this.privacyModal, this.vaultModal, this.settingsModal].forEach((m) => { m.hidden = true; }); }

  openVault() {
    this.send(MessageType.GET_VAULT, undefined, (res) => {
      const v = res?.vault || {};
      this.$('vault-aadhaar').value = typeof v.LOCAL_AADHAAR === 'string' ? v.LOCAL_AADHAAR : '';
      this.$('vault-pan').value = typeof v.LOCAL_PAN === 'string' ? v.LOCAL_PAN : '';
      this.$('vault-name').value = typeof v.LOCAL_FULL_NAME === 'string' ? v.LOCAL_FULL_NAME : '';
      this.$('vault-dob').value = typeof v.LOCAL_DOB === 'string' ? v.LOCAL_DOB : '';
      this.$('vault-phone').value = typeof v.LOCAL_PHONE === 'string' ? v.LOCAL_PHONE : '';
      this.$('vault-password').value = typeof v.LOCAL_PASSWORD === 'string' ? v.LOCAL_PASSWORD : '';
      this.openModal(this.vaultModal);
    });
  }

  saveVault() {
    const updates = [
      ['LOCAL_AADHAAR', this.$('vault-aadhaar').value],
      ['LOCAL_PAN', this.$('vault-pan').value],
      ['LOCAL_FULL_NAME', this.$('vault-name').value],
      ['LOCAL_DOB', this.$('vault-dob').value],
      ['LOCAL_PHONE', this.$('vault-phone').value],
      ['LOCAL_PASSWORD', this.$('vault-password').value]
    ];
    (async () => {
      for (const [key, value] of updates) {
        await new Promise((r) => this.send(MessageType.UPDATE_VAULT, { key, value }, () => r()));
      }
      this.closeModal(this.vaultModal);
    })();
  }

  applySettingsToUI() {
    try {
      const raw = localStorage.getItem('privagent_settings');
      if (raw) this.reflectSettings(JSON.parse(raw));
    } catch { /* ignore */ }
  }

  reflectSettings(s) {
    if (!s) return;
    try { localStorage.setItem('privagent_settings', JSON.stringify(s)); } catch { /* ignore */ }
    this.$('settings-backend').value = s.backendUrl || '';
    this.$('settings-maxsteps').value = s.maxSteps || '';
    this.$('settings-confirm').checked = s.alwaysConfirm !== false;
    this.$('settings-debug').checked = !!s.showDebug;
    this.debugPanel.style.display = s.showDebug ? '' : 'none';
  }

  openSettings() {
    this.send(MessageType.GET_AGENT_STATUS, undefined, (res) => {
      if (res?.settings) this.reflectSettings(res.settings);
      this.openModal(this.settingsModal);
    });
  }

  saveSettings() {
    const settings = {
      backendUrl: this.$('settings-backend').value.trim(),
      maxSteps: Math.min(50, Math.max(1, parseInt(this.$('settings-maxsteps').value, 10) || 25)),
      alwaysConfirm: this.$('settings-confirm').checked,
      showDebug: this.$('settings-debug').checked
    };
    this.reflectSettings(settings);
    this.send(MessageType.UPDATE_SETTINGS, settings);
    this.closeModal(this.settingsModal);
  }

  applyTheme() {
    try {
      const t = localStorage.getItem('privagent_theme');
      if (t) document.documentElement.dataset.theme = t;
    } catch { /* ignore */ }
  }

  toggleTheme() {
    const cur = document.documentElement.dataset.theme;
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const next = (cur || (prefersDark ? 'dark' : 'light')) === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('privagent_theme', next); } catch { /* ignore */ }
  }

  startElapsed() {
    this.stopElapsed();
    this.elapsedTimer = setInterval(() => {
      if (!this.taskStartWall) return;
      const s = Math.floor((Date.now() - this.taskStartWall) / 1000);
      this.elapsed.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }, 1000);
  }

  stopElapsed() {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
  }

  renderDebug() {
    if (this.debugPanel.style.display === 'none') return;
    const t = this.task;
    this.debugBody.replaceChildren();
    if (!t) { this.debugBody.appendChild(el('p', 'muted small', 'No task data yet.')); return; }
    const rows = [
      ['task', t.id || '—'],
      ['state', t.state || '—'],
      ['step', `${t.currentStep ?? 0}/${t.maxSteps ?? 25}`],
      ['tab', String(t.tabId ?? '—')],
      ['server calls', String(t.privacyMetrics?.serverCallsCount ?? 0)],
      ['sensitive fields', String(t.privacyMetrics?.sensitiveFieldsDetected ?? 0)],
      ['pending confirm', t.pendingConfirmation ? 'yes' : 'no']
    ];
    for (const [k, v] of rows) {
      const row = el('div', 'row');
      row.appendChild(el('span', null, k));
      row.appendChild(el('span', null, v));
      this.debugBody.appendChild(row);
    }
  }
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

document.addEventListener('DOMContentLoaded', () => { window.privAgentApp = new SidePanelApp(); });
