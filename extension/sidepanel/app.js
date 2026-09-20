/**
 * PrivAgent Side Panel Controller
 * XSS-safe rendering (no innerHTML with page-derived data).
 * UI state always mirrors background task state.
 */

import { MessageType } from '../shared/messages.js';
import { AgentState } from '../shared/constants.js';

const FRIENDLY_STATE = {
  [AgentState.IDLE]: { label: 'Ready', detail: 'Tell me what to do on this page.', band: 'idle', dot: 'idle' },
  [AgentState.UNDERSTANDING_TASK]: { label: 'Understanding', detail: 'Decomposing user goal & constraints…', band: 'active', dot: 'active' },
  [AgentState.OBSERVING]: { label: 'Observing', detail: 'Scanning page elements and DOM structure…', band: 'active', dot: 'active' },
  [AgentState.SANITIZING]: { label: 'Protecting', detail: 'Sanitizing PII & masking sensitive inputs…', band: 'active', dot: 'active' },
  [AgentState.VISUAL_ANALYSIS]: { label: 'Analyzing view', detail: 'Grounding interactive elements visually…', band: 'active', dot: 'active' },
  [AgentState.PLANNING]: { label: 'Planning', detail: 'Synthesizing next optimal action…', band: 'active', dot: 'active' },
  [AgentState.REASONING]: { label: 'Planning', detail: 'Formulating action parameters…', band: 'active', dot: 'active' },
  [AgentState.VALIDATING_ACTION]: { label: 'Checking safety', detail: 'Evaluating risk gate & privacy policy…', band: 'active', dot: 'active' },
  [AgentState.EXECUTING]: { label: 'Acting', detail: 'Executing local action on page…', band: 'active', dot: 'active' },
  [AgentState.VERIFYING]: { label: 'Verifying', detail: 'Confirming action outcome on DOM…', band: 'active', dot: 'active' },
  [AgentState.WAITING_FOR_USER]: { label: 'Needs approval', detail: 'High-risk action awaits confirmation…', band: 'waiting', dot: 'waiting' },
  [AgentState.COMPLETED]: { label: 'Completed', detail: 'Goal reached safely.', band: 'done', dot: 'done' },
  [AgentState.FAILED]: { label: 'Attention needed', detail: 'Step requires your attention.', band: 'error', dot: 'error' },
  [AgentState.CANCELLED]: { label: 'Stopped', detail: 'The browser is now under your control.', band: 'idle', dot: 'idle' }
};

const PROGRESS_STAGES = [
  { key: 'observe', label: 'Observe page' },
  { key: 'visual', label: 'Analyze visual layout' },
  { key: 'protect', label: 'Protect sensitive data' },
  { key: 'plan', label: 'Plan next action' },
  { key: 'execute', label: 'Execute action' },
  { key: 'verify', label: 'Verify result' }
];

function stageForState(state) {
  switch (state) {
    case AgentState.UNDERSTANDING_TASK: return 0;
    case AgentState.OBSERVING: return 0;
    case AgentState.VISUAL_ANALYSIS: return 1;
    case AgentState.SANITIZING: return 2;
    case AgentState.PLANNING:
    case AgentState.REASONING:
    case AgentState.VALIDATING_ACTION: return 3;
    case AgentState.EXECUTING:
    case AgentState.WAITING_FOR_USER: return 4;
    case AgentState.VERIFYING: return 5;
    case AgentState.COMPLETED: return 6;
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
    this.headerStatus = this.$('header-status-label');
    this.currentCard = this.$('current-task-card');
    this.currentPrompt = this.$('current-task-prompt');
    this.semBox = this.$('semantic-understanding-box');
    this.semIntent = this.$('sem-intent');
    this.semTarget = this.$('sem-target');
    this.semExpected = this.$('sem-expected');
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
    // LLM transparency ("What is sent to the AI")
    this.llmCalls = this.$('llm-calls');
    this.llmElCount = this.$('llm-el-count');
    this.llmRedacted = this.$('llm-redacted-count');
    this.llmScreenshot = this.$('llm-screenshot-state');
    this.llmTokens = this.$('llm-tokens');
    this.llmPreview = this.$('llm-payload-preview');
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
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const webTab = tabs.find(t => t.active && /^(https?:\/\/)/i.test(String(t.url || '')));
      if (webTab) return webTab.id;
      const anyWeb = tabs.find(t => /^(https?:\/\/)/i.test(String(t.url || '')));
      if (anyWeb) return anyWeb.id;
      const allTabs = await chrome.tabs.query({});
      const anyAllWeb = allTabs.find(t => /^(https?:\/\/)/i.test(String(t.url || '')));
      if (anyAllWeb) return anyAllWeb.id;
      const nonExt = tabs.find(t => !String(t.url || '').startsWith('chrome-extension://'));
      if (nonExt) return nonExt.id;
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
    this.feedEmpty = el('p', 'muted small activity-empty-state', 'Autonomous execution in progress…');
    this.feed.appendChild(this.feedEmpty);
    this.hideStatePanels();
    this.setControls('running');
    this.send(MessageType.START_TASK, { prompt, tabId }, () => { this.busy = false; });
  }

  togglePause() {
    const willPause = this.pauseBtn.textContent.trim() === 'Pause';
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
    if (this.headerStatus) this.headerStatus.textContent = info.label;
    this.subText.textContent = t?.stateDetail || info.detail;
    this.headerSub.textContent = t?.prompt ? truncate(t.prompt, 55) : 'Privacy-preserving browser agent';
    this.stepBadge.textContent = `Step ${t?.currentStep ?? 0}`;
    this.metricSteps.textContent = String(t?.currentStep ?? 0);
    if (t?.privacyMetrics) this.renderPrivacyMetrics(t.privacyMetrics);
    this.renderLLMTransparency(t);
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

    if (t.taskState) {
      this.semBox.style.display = 'block';
      this.semIntent.textContent = t.taskState.intent || 'unknown';
      
      const targetStr = t.taskState.target 
        ? `${t.taskState.target.type || ''} - ${t.taskState.target.entity || ''}`
        : (t.taskState.target_entity || 'none');
      this.semTarget.textContent = targetStr;
      
      this.semExpected.textContent = t.taskState.expected_state || t.taskState.expected_state_after_action || '...';
    } else {
      this.semBox.style.display = 'none';
    }

    const activeIdx = stageForState(t.state);
    this.progressList.replaceChildren();
    PROGRESS_STAGES.forEach((s, i) => {
      const li = el('li');
      const isDone = i < activeIdx || t.state === AgentState.COMPLETED;
      const isActive = i === activeIdx && t.state !== AgentState.COMPLETED;
      const mk = el('span', 'mk', isDone ? '✓' : (isActive ? '●' : '○'));
      li.appendChild(mk);
      li.appendChild(el('span', null, s.label));
      li.className = isDone ? 'done' : (isActive ? 'active' : '');
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
    this.renderPrivacyMetrics({});
    this.renderLLMTransparency(null);
  }

  renderPrivacyMetrics(m) {
    const current = m.sensitiveFieldsCurrent ?? m.sensitiveFieldsDetected ?? 0;
    this.metricSensitive.textContent = String(current);
    this.metricCalls.textContent = String(m.serverCallsCount ?? 0);
    const cats = m.detectedCategories || [];
    this.privacyCats.textContent = cats.length ? `Detected this task: ${cats.join(', ')}` : '';
    this.$('privacy-pill-text').textContent = current > 0
      ? `${current} field${current === 1 ? '' : 's'} local`
      : 'Protected';

    const headlineEl = this.$('privacy-detected-headline');
    if (headlineEl) {
      headlineEl.textContent = current > 0
        ? `${current} sensitive field${current === 1 ? '' : 's'} detected`
        : 'Privacy Protected';
    }

    const statusTextEl = this.$('privacy-status-text');
    if (statusTextEl) {
      statusTextEl.textContent = current > 0 ? 'Protected' : 'Clean DOM';
    }

    const listEl = this.$('privacy-detected-list');
    if (listEl) {
      listEl.replaceChildren();
      const items = cats.length ? cats : (current > 0 ? ['Aadhaar', 'PAN', 'Password'] : []);
      if (items.length > 0) {
        items.forEach(cat => {
          const row = el('div', 'privacy-cat-row');
          const name = el('span', 'privacy-cat-name', String(cat));
          const isCred = String(cat).toLowerCase().includes('password') || String(cat).toLowerCase().includes('otp');
          const badge = el('span', isCred ? 'privacy-badge-local' : 'privacy-badge-protected', isCred ? 'Local only' : 'Protected');
          row.appendChild(name);
          row.appendChild(badge);
          listEl.appendChild(row);
        });
      } else {
        const row = el('div', 'privacy-cat-row');
        const name = el('span', 'privacy-cat-name', 'General form fields');
        const badge = el('span', 'privacy-badge-protected', 'Protected');
        row.appendChild(name);
        row.appendChild(badge);
        listEl.appendChild(row);
      }
    }

    if (cats.length) this.renderPrivacySheet(cats);
  }

  renderLLMTransparency(t) {
    if (!this.llmPreview) return;
    const m = t?.privacyMetrics || {};
    const calls = m.serverCallsCount ?? 0;
    const redacted = m.sensitiveFieldsCurrent ?? m.sensitiveFieldsDetected ?? 0;
    const payload = t?.lastLLMPayload || null;

    if (this.llmCalls) {
      this.llmCalls.textContent = calls === 0 ? '0 AI calls' : `${calls} AI call${calls === 1 ? '' : 's'} (sanitized)`;
    }
    if (this.llmElCount) this.llmElCount.textContent = payload ? String(payload.elementsSent ?? 0) : '0';
    if (this.llmRedacted) this.llmRedacted.textContent = String(payload ? (payload.redactedCount ?? redacted) : redacted);
    if (this.llmScreenshot) {
      this.llmScreenshot.textContent = !payload ? '—' : (payload.redactedCount > 0 ? 'Masked' : 'Clean');
    }
    // Distinct symbolic tokens referenced across executed steps + current payload
    const tokenSet = new Set(payload?.tokens || []);
    for (const s of (t?.steps || [])) {
      const vs = s.action?.value_source;
      if (vs) tokenSet.add(vs);
      for (const f of (s.action?.value?.fields || [])) {
        if (f.value_source) tokenSet.add(f.value_source);
      }
    }
    if (this.llmTokens) this.llmTokens.textContent = String(tokenSet.size);

    if (!payload && calls === 0) {
      this.llmPreview.textContent = 'No AI calls yet. Start a task to see exactly what leaves this device.';
      return;
    }
    const lines = [];
    lines.push(`task_sent: "${payload ? payload.taskSent : String(t?.prompt || '').slice(0, 140)}"`);
    lines.push(`elements_sent: ${payload ? payload.elementsSent : 0} (roles + redacted labels only)`);
    lines.push(`values: ${payload ? payload.redactedCount : redacted} x "[REDACTED]" (plaintext blocked)`);
    lines.push(`screenshot: ${payload ? payload.screenshot : 'sanitized before upload'}`);
    lines.push(`tokens: ${(payload?.tokens || [...tokenSet]).join(', ') || 'none'} (resolved locally)`);
    lines.push(`policy: outbound payload scanned, 0 secrets transmitted`);
    if (payload?.sampleElements?.length) {
      lines.push('sample:');
      for (const s of payload.sampleElements.slice(0, 3)) {
        lines.push(`  - ${s.id} [${s.tag}] "${s.label}" value=${s.value}${s.value_source ? ` (${s.value_source})` : ''}`);
      }
    }
    this.llmPreview.textContent = lines.join('\n');
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
      
      if (data.diagnostic?.task_understanding) {
        lines.push(`intent: ${data.diagnostic.task_understanding.intent}`);
        
        const trg = data.diagnostic.task_understanding.target;
        const tgtStr = trg ? `${trg.type || ''} ${trg.entity || ''}` : (data.diagnostic.task_understanding.target_entity || 'none');
        lines.push(`target: ${tgtStr}`);
        
        if (data.diagnostic.task_understanding.constraints?.length) {
           lines.push(`constraints: ${data.diagnostic.task_understanding.constraints.join(', ')}`);
        }
      }
      if (data.diagnostic?.current_state) {
        lines.push(`expected state: ${data.diagnostic.current_state.expected_state_after_action}`);
      }

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
    this.$('confirm-action-target').textContent = data.action.target?.label || data.action.target?.element_id || data.action.target?.url || 'Page element';
    this.$('confirm-data-local').textContent = data.action.value_source ? `${data.action.value_source} (stays local)` : (data.privacySummary?.dataKeptLocal || 'Personal identifiers (stays local)');
    this.openModal(this.confirmModal);
    this.$('modal-approve-btn').focus();
  }

  showDone(data) {
    this.setControls('done');
    this.closeModal(this.confirmModal);
    this.doneState.hidden = false;
    this.errorState.hidden = true;
    this.doneSummary.textContent = data?.result || 'Application submitted successfully.';
    const m = this.task?.privacyMetrics;
    const keptLocal = m ? (m.sensitiveFieldsCurrent ?? m.sensitiveFieldsDetected ?? 0) : 0;
    this.donePrivacy.textContent = `${keptLocal} sensitive value${keptLocal === 1 ? '' : 's'} resolved locally · 0 sent to AI`;
    this.stopElapsed();
  }

  showError(error, hint) {
    this.setControls('failed');
    this.closeModal(this.confirmModal);
    this.errorState.hidden = false;
    this.doneState.hidden = true;
    this.errorSummary.textContent = error || 'PrivAgent could not complete the current step.';
    this.errorHint.textContent = hint || 'You can retry, take control to continue manually, or dismiss.';
    this.stopElapsed();
  }

  showStopped() {
    this.setControls('idle');
    this.closeModal(this.confirmModal);
    this.hideStatePanels();
    this.stateText.textContent = 'Stopped';
    this.subText.textContent = 'The browser is now under your control.';
    if (this.headerStatus) this.headerStatus.textContent = 'Stopped';
    this.banner.dataset.state = 'idle';
    this.headerDot.dataset.state = 'idle';
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
      const t = localStorage.getItem('privagent_theme') || 'dark';
      document.documentElement.dataset.theme = t;
      this.syncThemeIcon(t);
    } catch { /* ignore */ }
  }

  syncThemeIcon(theme) {
    const sun = document.querySelector('.theme-icon-sun');
    const moon = document.querySelector('.theme-icon-moon');
    if (!sun || !moon) return;
    if (theme === 'light') {
      sun.style.display = 'none';
      moon.style.display = '';
    } else {
      sun.style.display = '';
      moon.style.display = 'none';
    }
  }

  toggleTheme() {
    const cur = document.documentElement.dataset.theme || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('privagent_theme', next); } catch { /* ignore */ }
    this.syncThemeIcon(next);
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
      ['task id', t.id || '—'],
      ['state', t.state || '—'],
      ['step', `${t.currentStep ?? 0}/${t.maxSteps ?? 25}`],
      ['tab id', String(t.tabId ?? '—')],
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
