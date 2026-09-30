/**
 * PrivAgent Side Panel Controller
 * XSS-safe rendering (no innerHTML with page-derived data).
 * UI state always mirrors background task state.
 */

import { MessageType } from '../shared/messages.js';
import { AgentState, isDocumentToken } from '../shared/constants.js';
import {
  buildLogExport,
  collectLogEntries,
  createLogger,
  getLogStore,
  installGlobalErrorHandlers,
  LOG_LEVEL_STORAGE_KEY,
  normalizeLevel
} from '../shared/logger.js';
import { setupLocalVisionMessageHandler } from '../perception/local-vision.js';
import { extractPdfTableRows } from '../perception/pdf-table-extractor.js';

const log = createLogger({ scope: 'SidePanel', surface: 'sidepanel' });
const MAX_VLM_SCREENSHOT_PREVIEWS = 8;
const MAX_VLM_SCREENSHOT_PREVIEW_CHARS = 12 * 1024 * 1024;
const MAX_VLM_SCREENSHOT_PREVIEW_TOTAL_CHARS = 24 * 1024 * 1024;

// The panel is a long-lived document, so an uncaught error or a rejected
// promise here previously left the UI silently stale — the background kept
// running while the panel stopped reflecting it.
installGlobalErrorHandlers(log);

// Restore this surface's persisted entries before appending new ones.
getLogStore('sidepanel').hydrate().catch(() => {});

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
  [AgentState.PAUSED]: { label: 'Paused', detail: 'Paused. Resume to continue the task.', band: 'waiting', dot: 'waiting' },
  [AgentState.COMPLETED]: { label: 'Completed', detail: 'Goal reached safely.', band: 'done', dot: 'done' },
  [AgentState.FAILED]: { label: 'Attention needed', detail: 'Step requires your attention.', band: 'error', dot: 'error' },
  [AgentState.CANCELLED]: { label: 'Stopped', detail: 'The browser is now under your control.', band: 'idle', dot: 'idle' }
};

const PROGRESS_STAGES = [
  { key: 'observe', label: 'Observe page' },
  { key: 'protect', label: 'Protect sensitive data' },
  { key: 'visual', label: 'Analyze visual layout' },
  { key: 'plan', label: 'Plan next action' },
  { key: 'execute', label: 'Execute action' },
  { key: 'verify', label: 'Verify result' }
];

// Mirrors the actual execution order: SANITIZING runs before
// VISUAL_ANALYSIS in every agent cycle, so the progress marker must not
// move backward (2→1) between stages.
function stageForState(state) {
  switch (state) {
    case AgentState.UNDERSTANDING_TASK: return 0;
    case AgentState.OBSERVING: return 0;
    case AgentState.SANITIZING: return 1;
    case AgentState.VISUAL_ANALYSIS: return 2;
    case AgentState.PLANNING:
    case AgentState.REASONING:
    case AgentState.VALIDATING_ACTION: return 3;
    case AgentState.EXECUTING:
    case AgentState.WAITING_FOR_USER: return 4;
    case AgentState.PAUSED: return 4;
    case AgentState.VERIFYING: return 5;
    case AgentState.COMPLETED: return 6;
    default: return -1;
  }
}

// Maps clarification-modal semantic types to vault-accepted symbolic keys.
// Deriving LOCAL_${sem} directly produced keys like LOCAL_DATE_OF_BIRTH and
// LOCAL_ZIP_CODE that the vault whitelist rejected — the user's "save to
// vault" choice was silently discarded.
const VAULT_KEY_ALIASES = {
  LOCAL_DOB: 'LOCAL_DOB', LOCAL_DATE_OF_BIRTH: 'LOCAL_DOB', LOCAL_BIRTH_DATE: 'LOCAL_DOB',
  LOCAL_ZIP: 'LOCAL_ZIP', LOCAL_ZIP_CODE: 'LOCAL_ZIP', LOCAL_POSTAL_CODE: 'LOCAL_ZIP', LOCAL_PIN_CODE: 'LOCAL_ZIP',
  LOCAL_ADDRESS: 'LOCAL_ADDRESS', LOCAL_ADDRESS_LINE1: 'LOCAL_ADDRESS', LOCAL_ADDRESS_LINE_1: 'LOCAL_ADDRESS',
  LOCAL_ADDRESS_LINE2: 'LOCAL_ADDRESS', LOCAL_STREET_ADDRESS: 'LOCAL_ADDRESS',
  LOCAL_FULL_NAME: 'LOCAL_FULL_NAME', LOCAL_NAME: 'LOCAL_FULL_NAME',
  LOCAL_PHONE: 'LOCAL_PHONE', LOCAL_MOBILE: 'LOCAL_PHONE', LOCAL_MOBILE_NUMBER: 'LOCAL_PHONE',
  LOCAL_PHONE_NUMBER: 'LOCAL_PHONE', LOCAL_TEL: 'LOCAL_PHONE',
  LOCAL_EMAIL: 'LOCAL_EMAIL', LOCAL_MAIL: 'LOCAL_EMAIL',
  LOCAL_AADHAAR: 'LOCAL_AADHAAR', LOCAL_AADHAAR_NUMBER: 'LOCAL_AADHAAR', LOCAL_AADHAR: 'LOCAL_AADHAAR',
  LOCAL_PAN: 'LOCAL_PAN', LOCAL_PAN_NUMBER: 'LOCAL_PAN',
  LOCAL_PASSWORD: 'LOCAL_PASSWORD', LOCAL_PASSCODE: 'LOCAL_PASSWORD',
  LOCAL_CREDIT_CARD: 'LOCAL_CREDIT_CARD', LOCAL_CARD_NUMBER: 'LOCAL_CREDIT_CARD',
  LOCAL_CVV: 'LOCAL_CVV', LOCAL_CVC: 'LOCAL_CVV',
  LOCAL_SSN: 'LOCAL_SSN', LOCAL_SIN: 'LOCAL_SIN', LOCAL_NIN: 'LOCAL_NIN',
  LOCAL_NHS: 'LOCAL_NHS', LOCAL_IBAN: 'LOCAL_IBAN',
  LOCAL_CITY: 'LOCAL_CITY', LOCAL_STATE: 'LOCAL_STATE',
  LOCAL_COUNTRY: 'LOCAL_COUNTRY', LOCAL_GENDER: 'LOCAL_GENDER', LOCAL_TERMS: 'LOCAL_TERMS'
};

function vaultKeyForSemantic(sem) {
  const key = `LOCAL_${String(sem || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
  if (VAULT_KEY_ALIASES[key]) return VAULT_KEY_ALIASES[key];
  // Unknown semantics are stored as custom vault entries (available to the
  // planner for future forms), so "save to vault" never silently
  // discards the value.
  const slug = String(sem || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
  return slug ? `LOCAL_CUSTOM_${slug}` : '';
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

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Base64 for the runtime message channel; the reader is always revoked. */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('The selected file could not be read.'));
    reader.readAsDataURL(file);
  });
}

class SidePanelApp {
  constructor() {
    this.task = null;
    this.lastPrompt = '';
    this.taskStartWall = null;
    this.elapsedTimer = null;
    this.vlmScreenshotPreviews = [];
    this.pdfFile = null;
    this.pdfRows = [];
    this.vaultLoadGeneration = 0;
    this.vaultDocumentRowId = 0;
    this.vaultLoaded = false;
    this.vaultSaving = false;
    this.vaultReviewRequired = false;
    this.init();
  }

  $(id) { return document.getElementById(id); }

  init() {
    setupLocalVisionMessageHandler();
    this.cache();
    this.applyTheme();
    this.bind();
    this.applySettingsToUI();
    this.listen();
    this.pollStatus();
    this.renderPrivacyStatic();
    this.applyConfiguredLogLevel();
  }

  /**
   * Match the service worker's threshold.
   *
   * Both surfaces read the same storage key, so a level raised for debugging
   * the agent loop applies to the panel's own diagnostics too instead of the
   * two contexts disagreeing about what counts as a warning.
   */
  async applyConfiguredLogLevel() {
    try {
      if (chrome.storage?.local) {
        const stored = await chrome.storage.local.get(LOG_LEVEL_STORAGE_KEY);
        const requested = stored?.[LOG_LEVEL_STORAGE_KEY];
        if (requested) log.setLevel(normalizeLevel(requested));
      }
    } catch (error) {
      log.warn('Could not read the configured log level; using the default.', { error });
    }
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
    // Transparency about what the configured backend receives.
    this.llmCalls = this.$('llm-calls');
    this.llmElCount = this.$('llm-el-count');
    this.llmRedacted = this.$('llm-redacted-count');
    this.llmScreenshot = this.$('llm-screenshot-state');
    this.llmTokens = this.$('llm-tokens');
    this.llmPreview = this.$('llm-payload-preview');
    this.llmScreenshotPreviewCard = this.$('llm-screenshot-preview-card');
    this.llmScreenshotPreviewList = this.$('llm-screenshot-preview-list');
    this.debugPanel = this.$('debug-panel');
    this.debugBody = this.$('debug-body');
    // Modals
    this.confirmModal = this.$('confirmation-modal');
    this.userInputModal = this.$('user-input-modal');
    this.userInputPrompt = this.$('user-input-prompt-text');
    this.userInputFieldsContainer = this.$('user-input-fields-container');
    this.userInputSingleContainer = this.$('user-input-single-container');
    this.userInputSingleText = this.$('user-input-single-text');
    this.userInputSkipBtn = this.$('user-input-skip-btn');
    this.userInputSubmitBtn = this.$('user-input-submit-btn');
    this.userInputStatus = this.$('user-input-status');
    this.userInputCount = this.$('user-input-count');
    this.privacyModal = this.$('privacy-modal');
    this.vaultModal = this.$('vault-modal');
    this.vaultSaveBtn = this.$('save-vault-btn');
    this.vaultSaveStatus = this.$('vault-save-status');
    this.vaultReviewNotice = this.$('vault-review-notice');
    this.vaultReviewConfirm = this.$('vault-review-confirm');
    this.vaultReviewReveal = this.$('vault-review-reveal');
    this.confirmNoteText = this.$('confirm-note-text');
    this.confirmReviewTitle = this.$('confirm-review-title');
    this.settingsModal = this.$('settings-modal');
    this.pdfFileInput = this.$('pdf-sheet-file');
    this.pdfFilename = this.$('pdf-sheet-filename');
    this.pdfExtractBtn = this.$('pdf-extract-btn');
    this.pdfCopyBtn = this.$('pdf-copy-btn');
    this.pdfDownloadBtn = this.$('pdf-download-btn');
    this.pdfStatus = this.$('pdf-sheet-status');
    this.pdfPreviewWrap = this.$('pdf-preview-wrap');
    this.pdfPreviewNote = this.$('pdf-preview-note');
    this.pdfPreviewTable = this.$('pdf-preview-table');
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

    this.userInputSkipBtn?.addEventListener('click', () => this.skipUserInput());
    this.userInputSubmitBtn?.addEventListener('click', () => this.submitUserInput());

    this.$('privacy-pill').addEventListener('click', () => this.openModal(this.privacyModal));
    this.$('close-privacy-btn').addEventListener('click', () => this.closeModal(this.privacyModal));
    this.$('privacy-sheet-close-btn').addEventListener('click', () => this.closeModal(this.privacyModal));

    this.$('vault-btn').addEventListener('click', () => this.openVault());
    this.$('close-vault-btn').addEventListener('click', () => this.closeModal(this.vaultModal));
    this.$('save-vault-btn').addEventListener('click', () => this.saveVault());
    this.vaultReviewConfirm.addEventListener('change', () => {
      this.vaultSaveBtn.disabled = !this.vaultLoaded || this.vaultSaving ||
        (this.vaultReviewRequired && !this.vaultReviewConfirm.checked);
    });
    this.vaultReviewReveal.addEventListener('change', () => this.setVaultReviewReveal(this.vaultReviewReveal.checked));
    this.$('vault-add-custom-btn').addEventListener('click', () => this.addCustomVaultField());
    this.$('vault-doc-add-btn')?.addEventListener('click', () => this.addVaultDocumentRow());

    this.$('settings-btn').addEventListener('click', () => this.openSettings());
    this.$('close-settings-btn').addEventListener('click', () => this.closeModal(this.settingsModal));
    this.$('save-settings-btn').addEventListener('click', () => this.saveSettings());
    this.$('export-error-log-btn').addEventListener('click', (event) => this.downloadErrorLog(event.currentTarget));

    this.$('theme-btn').addEventListener('click', () => this.toggleTheme());

    this.pdfFileInput.addEventListener('change', () => this.selectPdfFile());
    this.pdfExtractBtn.addEventListener('click', () => this.extractSelectedPdf());
    this.pdfCopyBtn.addEventListener('click', () => this.copyPdfRows());
    this.pdfDownloadBtn.addEventListener('click', () => this.downloadPdfCsv());
  }

  queryChips() { return Array.from(document.querySelectorAll('.chip')); }

  selectPdfFile() {
    const file = this.pdfFileInput.files?.[0] || null;
    this.pdfFile = file;
    this.pdfRows = [];
    this.pdfFilename.textContent = file?.name || 'No file selected';
    this.pdfExtractBtn.disabled = !file;
    this.pdfCopyBtn.disabled = true;
    this.pdfDownloadBtn.disabled = true;
    this.pdfPreviewWrap.hidden = true;
    this.pdfPreviewTable.replaceChildren();
    this.setPdfStatus(file ? 'Ready to process locally. The PDF will not be sent to the agent.' : 'Select a PDF to begin.');
  }

  async extractSelectedPdf() {
    if (!this.pdfFile) return;
    const file = this.pdfFile;
    this.pdfExtractBtn.disabled = true;
    this.pdfFileInput.disabled = true;
    this.pdfCopyBtn.disabled = true;
    this.pdfDownloadBtn.disabled = true;
    this.pdfRows = [];
    this.pdfPreviewWrap.hidden = true;
    this.setPdfStatus('Opening PDF locally…', 'working');
    try {
      const result = await extractPdfTableRows(file, {
        onProgress: ({ page, total, phase }) => {
          this.setPdfStatus(`${phase} · page ${page} of ${total}`, 'working');
        }
      });
      this.pdfRows = result.rows;
      this.renderPdfPreview();
      this.pdfCopyBtn.disabled = false;
      this.pdfDownloadBtn.disabled = false;
      const method = result.usedOcr ? ' Local OCR was used for scanned pages.' : '';
      const pageNote = result.truncated ? ` Processed the first ${result.processedPages} of ${result.pageCount} pages.` : '';
      // Say what was left out rather than silently pasting a ragged rectangle:
      // a dropped line is usually a title or a page number, and the user is
      // the only one who can tell whether that mattered to them.
      const droppedNote = result.droppedLines
        ? ` ${result.droppedLines} non-tabular line${result.droppedLines === 1 ? '' : 's'} (titles or page numbers) were left out.`
        : '';
      const widthNote = result.columnCount
        ? ` ${result.columnCount} columns detected.`
        : ' No column grid was detected — the page may be prose rather than a table.';
      this.setPdfStatus(`Extracted ${result.rows.length} rows.${widthNote} Review them, then copy or download.${method}${pageNote}${droppedNote}`, 'success');
    } catch (error) {
      const known = new Set([
        'Choose a PDF file first.',
        'Choose a PDF file.',
        'This PDF is larger than the 20 MB local processing limit.',
        'Extension PDF assets are unavailable.',
        'This PDF has no pages.',
        'Local PDF rendering is unavailable.',
        'No readable text or tables were found in this PDF.'
      ]);
      const safeMessage = known.has(error?.message)
        ? error.message
        : 'Could not read this PDF. It may be encrypted, damaged, or unsupported.';
      this.setPdfStatus(safeMessage, 'error');
    } finally {
      this.pdfExtractBtn.disabled = !this.pdfFile;
      this.pdfFileInput.disabled = false;
    }
  }

  renderPdfPreview() {
    const previewRows = this.pdfRows.slice(0, 15);
    const columns = Math.min(10, Math.max(1, ...previewRows.map((row) => row.length)));
    const fragment = document.createDocumentFragment();
    for (const row of previewRows) {
      const tr = document.createElement('tr');
      for (let index = 0; index < columns; index += 1) {
        const cell = document.createElement('td');
        cell.textContent = row[index] || '';
        tr.appendChild(cell);
      }
      fragment.appendChild(tr);
    }
    this.pdfPreviewTable.replaceChildren(fragment);
    this.pdfPreviewNote.textContent = `Previewing ${previewRows.length} of ${this.pdfRows.length} extracted rows. Check the columns before copying.`;
    this.pdfPreviewWrap.hidden = false;
  }

  setPdfStatus(message, state = 'idle') {
    this.pdfStatus.textContent = message;
    this.pdfStatus.dataset.state = state;
  }

  async copyPdfRows() {
    if (!this.pdfRows.length) return;
    const text = this.pdfRows.map((row) => row.map(spreadsheetSafeCell).join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.setPdfStatus('Rows copied. Switch to Google Sheets, choose the first cell, and paste.', 'success');
    } catch {
      this.setPdfStatus('Could not access the clipboard. Download CSV and import it into Google Sheets.', 'error');
    }
  }

  downloadPdfCsv() {
    if (!this.pdfRows.length) return;
    const csv = this.pdfRows.map((row) => row.map((value) => {
      const safe = spreadsheetSafeCell(value).replace(/"/g, '""');
      return `"${safe}"`;
    }).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileStem(this.pdfFile?.name)}-tables.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.setPdfStatus('CSV downloaded locally. Import it into Google Sheets when ready.', 'success');
  }

  send(type, payload, cb) {
    try {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) {
          log.warn('Message to the background failed.', { type, notice: chrome.runtime.lastError.message });
          cb?.(null);
          return;
        }
        cb?.(res);
      });
    } catch (err) {
      log.exception('Message to the background threw', err, { type });
      cb?.(null);
    }
  }

  /** Promise form of send(), for the document-save sequence. */
  sendAsync(type, payload) {
    return new Promise((resolve) => this.send(type, payload, resolve));
  }

  listen() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === MessageType.AGENT_STATUS_UPDATE) this.onUpdate(msg.payload);
    });
    // Background-side settings changes must reflect here: settings are also
    // mirrored in chrome.storage.local (task manager) and the panel's
    // localStorage copy can go stale without this listener.
    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.privagent_settings?.newValue) {
          this.reflectSettings(changes.privagent_settings.newValue);
        }
      });
    }
  }

  pollStatus() {
    this.send(MessageType.GET_AGENT_STATUS, undefined, (res) => {
      if (res?.task && res.task.state !== AgentState.IDLE) {
        this.task = res.task;
        this.lastPrompt = res.task.prompt || this.lastPrompt;
        this.renderAll();
        if (res.task.state === AgentState.FAILED) this.showError(res.task.error, res.task.hint);
        else if (res.task.state === AgentState.COMPLETED) this.showDone({ result: res.task.result });
        else if (res.task.state === AgentState.CANCELLED) this.showStopped();
      }
      if (res?.settings) this.reflectSettings(res.settings);
    });
  }

  // ---- actions ----
  async activeTabId() {
    try {
      let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || /^(?:chrome|moz)-extension:\/\//i.test(String(tab.url || ''))) {
        [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
      if (tab?.id && !/^(?:chrome|moz)-extension:\/\//i.test(String(tab.url || ''))) {
        return tab.id;
      }
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const nonExt = tabs.find(t => !/^(?:chrome|moz)-extension:\/\//i.test(String(t.url || '')));
      if (nonExt) return nonExt.id;
      const allTabs = await chrome.tabs.query({});
      const anyNonExt = allTabs.find(t => !/^(?:chrome|moz)-extension:\/\//i.test(String(t.url || '')));
      if (anyNonExt) return anyNonExt.id;
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
    this.send(MessageType.START_TASK, { prompt, tabId }, (res) => {
      this.busy = false;
      if (!res?.success) {
        this.showError(
          res?.error || 'PrivAgent could not start this task.',
          res?.hint || 'The extension background did not respond. Reload the extension and retry.'
        );
      }
    });
  }

  togglePause() {
    const willPause = this.pauseBtn.textContent.trim() === 'Pause';
    this.pauseBtn.textContent = willPause ? 'Resume' : 'Pause';
    this.send(willPause ? MessageType.PAUSE_TASK : MessageType.RESUME_TASK);
  }

  stop() {
    this.send(MessageType.CANCEL_TASK);
    this.closeModal(this.confirmModal);
    this.closeModal(this.userInputModal);
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
    const pending = this.currentConfirmationData || {};
    this.currentConfirmationData = null;
    this.closeModal(this.confirmModal);
    this.send(MessageType.USER_CONFIRM_ACTION, {
      approved,
      taskId: pending.taskId,
      confirmationId: pending.confirmationId
    });
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
      this.clearVlmScreenshotPreviews();
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
      case 'USER_INPUT_REQUIRED': this.showUserInput(data); break;
      case 'TASK_COMPLETED': this.showDone(data); break;
      case 'TASK_FAILED': this.showError(data?.error, data?.hint); break;
      case 'TASK_CANCELLED': this.showStopped(); break;
      case 'VLM_SCREENSHOT_DISPATCHED': this.addVlmScreenshotPreview(data); break;
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
    if (t?.pendingConfirmation) this.showConfirmation(t.pendingConfirmation);
    if (t?.pendingUserInput) this.showUserInput(t.pendingUserInput);
    this.activityCount.textContent = t?.steps?.length ? `${t.steps.length} step${t.steps.length === 1 ? '' : 's'}` : '';
    if (!t || state === AgentState.IDLE) {
      this.emptyState.hidden = false;
      this.setControls('idle');
    } else {
      this.emptyState.hidden = true;
    }
    if (state === AgentState.COMPLETED || state === AgentState.FAILED || state === AgentState.CANCELLED) {
      this.stopElapsed();
      this.setControls(state === AgentState.COMPLETED ? 'done' : state === AgentState.FAILED ? 'failed' : 'idle');
    } else if (t && state !== AgentState.IDLE) {
      this.setControls('running');
      this.pauseBtn.textContent = state === AgentState.PAUSED ? 'Resume' : 'Pause';
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
    ['Vault values until entered', 'Documents until approved attachment', 'Original screenshots', 'Form answers before site submission'].forEach((s) => {
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
      ? `${current} value${current === 1 ? '' : 's'} kept local`
      : 'Filters active';

    const headlineEl = this.$('privacy-detected-headline');
    if (headlineEl) {
      headlineEl.textContent = current > 0
        ? `${current} sensitive field${current === 1 ? '' : 's'} detected`
        : 'No recognized sensitive fields detected';
    }

    const statusTextEl = this.$('privacy-status-text');
    if (statusTextEl) {
      statusTextEl.textContent = 'Best-effort filters active';
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
          const badge = el('span', isCred ? 'privacy-badge-local' : 'privacy-badge-protected', isCred ? 'Value kept local' : 'Filtered');
          row.appendChild(name);
          row.appendChild(badge);
          listEl.appendChild(row);
        });
      } else {
        const row = el('div', 'privacy-cat-row');
        const name = el('span', 'privacy-cat-name', 'General form fields');
        const badge = el('span', 'privacy-badge-protected', 'Checked');
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
      this.llmCalls.textContent = calls === 0 ? '0 backend requests' : `${calls} backend request${calls === 1 ? '' : 's'}`;
    }
    if (this.llmElCount) this.llmElCount.textContent = payload ? String(payload.elementsSent ?? 0) : '0';
    if (this.llmRedacted) this.llmRedacted.textContent = String(payload ? (payload.redactedCount ?? redacted) : redacted);
    if (this.llmScreenshot) {
      const screenshotLabels = { withheld: 'Withheld', masked: 'Masked', checked: 'Checked', skipped: 'Skipped' };
      this.llmScreenshot.textContent = !payload ? '—'
        : screenshotLabels[payload.screenshotStatus] || 'Unknown';
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
      this.llmPreview.textContent = 'No backend requests yet. Start a task to see what leaves this device.';
      return;
    }
    const lines = [];
    lines.push(`sanitized_task_sent: "${payload ? payload.taskSent : String(t?.prompt || '').slice(0, 140)}"`);
    const contextSent = payload
      ? `${payload.elementsSent} sanitized elements, page text excerpts, and task state`
      : 'none (task interpretation request)';
    lines.push(`page_context_sent: ${contextSent}`);
    lines.push(`sensitive fields redacted: ${payload ? payload.redactedCount : redacted}`);
    lines.push(`screenshot: ${payload ? payload.screenshot : 'not sent'}`);
    const timings = t?.lastStepTimings;
    if (timings) {
      lines.push(`last_step_ms: ${timings.total_ms ?? '—'}`);
      const stageSummary = Object.entries(timings)
        .filter(([name]) => name !== 'total_ms')
        .map(([name, duration]) => `${name}=${duration}`)
        .join(', ');
      if (stageSummary) lines.push(`stage_ms: ${stageSummary}`);
    }
    const traces = payload?.modelTrace;
    if (traces?.vision || traces?.reasoning) {
      const describe = (trace) => {
        if (!trace) return 'not run';
        const source = trace.source || 'unknown';
        const identity = [trace.provider, trace.model].filter(Boolean).join(' / ');
        const planner = trace.planner ? ` (${trace.planner})` : '';
        const label = source === 'remote' ? 'REAL_VLM screenshot summary'
          : source === 'dom_heuristic' ? 'DOM heuristic fallback (no usable VLM result)'
            : source === 'dom_only' ? 'DOM-only fallback (remote VLM not used or unavailable)'
              : source;
        return `${label}${identity ? `: ${identity}` : ''}${planner}`;
      };
      lines.push(`vision: ${describe(traces.vision)}`);
      lines.push(`reasoning: ${describe(traces.reasoning)}`);
    }
    if (payload?.localVision) {
      const local = payload.localVision;
      lines.push(`local_vision: ${local.model} completed in ${local.analysisMs} ms (load ${local.modelLoadMs} ms, inference ${local.inferenceMs} ms)`);
      lines.push(`local_masks: ${local.peopleMasked} people, ${local.ocrRegionsMasked} OCR PII regions (${(local.ocrCategoriesMasked || []).join(', ') || 'none'})`);
      lines.push(`client_assets: ${local.modelAssetBytes ? `${(local.modelAssetBytes / 1048576).toFixed(1)} MiB` : 'size unavailable'}; heap ${local.heapUsedBytes ? `${(local.heapUsedBytes / 1048576).toFixed(1)} MiB` : 'not exposed by browser'}`);
    }
    lines.push(`tokens: ${(payload?.tokens || [...tokenSet]).join(', ') || 'none'} (values resolve in browser; document names may be sent to planner)`);
    lines.push('policy: outbound payload checked for known sensitive patterns; unknown PII may be missed');
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
    this.currentConfirmationData = data;
    this.closeModal(this.userInputModal);
    this.$('confirm-reason').textContent = data.reason || 'This action needs your approval.';
    const reviewBox = this.$('confirm-review-box');
    const reviewText = this.$('confirm-review-text');
    const action = data.action;
    const fields = action.action === 'FILL_FORM_PLAN' && Array.isArray(action.value?.fields)
      ? action.value.fields
      : [];
    const upload = action.action === 'UPLOAD' || isDocumentToken(action.value_source);
    this.$('confirm-title').textContent = upload
      ? 'Approve document attachment'
      : fields.length ? 'Review form fill' : 'Confirm Action';
    const fieldNames = [...new Set(fields.map((field) => String(field?.label || field?.semantic_type || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean))];
    const formReview = fields.length
      ? `${fieldNames.length ? `Fields: ${fieldNames.slice(0, 8).join(', ')}${fieldNames.length > 8 ? ', …' : ''}. ` : ''}${fields.length} form field${fields.length === 1 ? '' : 's'} will be filled. Values are hidden in this review.`
      : '';
    const reviewSummary = (typeof data.reviewSummary === 'string' ? data.reviewSummary.trim() : '') || formReview;
    if (reviewText) reviewText.textContent = reviewSummary;
    if (reviewBox) reviewBox.hidden = !reviewSummary;
    if (this.confirmReviewTitle) this.confirmReviewTitle.textContent = fields.length
      ? 'Fields included (values hidden)'
      : 'Latest extracted review evidence';
    this.$('confirm-action-verb').textContent = action.action || 'ACTION';
    this.$('confirm-action-target').textContent = fields.length
      ? `Current form · ${fields.length} field${fields.length === 1 ? '' : 's'}`
      : action.target?.label || action.target?.element_id || action.target?.url || 'Page element';
    const source = typeof action.value_source === 'string' ? action.value_source : '';
    this.$('confirm-data-local').textContent = upload
      ? `${source || 'Stored document'} · the page can read the file after attachment`
      : fields.length
        ? `Values are written to this page; the site can receive them if submitted.`
        : source
          ? `${source} is resolved in this browser and written to the page.`
          : (data.privacySummary?.dataKeptLocal || 'No saved value is disclosed by this action.');
    if (this.confirmNoteText) {
      this.confirmNoteText.textContent = upload
        ? 'The planner receives the document name only. The page may read or upload the file after it is attached.'
        : fields.length
          ? 'This approves filling the listed form fields only. Form submission requires its own approval.'
          : 'Values entered into a webpage are visible to that site. Review the page before approving any submission.';
    }
    this.openModal(this.confirmModal);
    this.$('modal-approve-btn').textContent = upload ? 'Attach document' : fields.length ? 'Fill these fields' : 'Confirm & Proceed';
    this.$('modal-approve-btn').focus();
  }

  showUserInput(data) {
    if (!data) return;
    this.currentAskData = data;
    this.closeModal(this.confirmModal);
    const prompt = data.prompt || 'Please provide clarification for the agent to continue:';
    if (this.userInputPrompt) this.userInputPrompt.textContent = prompt;

    const fields = Array.isArray(data.ambiguousFields) ? data.ambiguousFields : [];
    if (this.userInputCount) this.userInputCount.textContent = fields.length
      ? `${fields.length} field${fields.length === 1 ? '' : 's'}`
      : 'Reply';
    if (this.userInputStatus) {
      this.userInputStatus.textContent = '';
      this.userInputStatus.dataset.error = 'false';
    }
    if (this.userInputFieldsContainer) this.userInputFieldsContainer.replaceChildren();

    if (fields.length > 0) {
      if (this.userInputSingleContainer) this.userInputSingleContainer.hidden = true;
      if (this.userInputFieldsContainer) this.userInputFieldsContainer.hidden = false;

      fields.forEach((field, index) => {
        const item = el('div', 'user-input-field-item');
        const header = el('div', 'user-input-field-header');
        const labelText = field.label || field.field_id || 'Field';
        const inputId = `user-answer-${index + 1}`;
        const label = el('label', 'user-input-field-label', labelText);
        label.htmlFor = inputId;
        header.appendChild(label);

        if (field.semantic_type) {
          const badge = el('span', 'mono-token', field.semantic_type);
          header.appendChild(badge);
        }
        item.appendChild(header);

        // Input element
        const inputType = String(field.input_type || 'text').toLowerCase();
        let answerInput;
        if (inputType === 'checkbox') {
          const checkWrap = el('label', 'user-input-answer-check');
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.id = inputId;
          input.dataset.fieldId = field.field_id;
          input.className = 'user-input-field-input-box';
          checkWrap.appendChild(input);
          checkWrap.appendChild(el('span', null, 'Yes'));
          item.appendChild(checkWrap);
        } else if (field.element_type === 'select' && Array.isArray(field.options) && field.options.length > 0) {
          const select = document.createElement('select');
          select.id = inputId;
          select.className = 'user-input-field-input user-input-field-input-box';
          select.dataset.fieldId = field.field_id;
          const defaultOpt = document.createElement('option');
          defaultOpt.value = '';
          defaultOpt.textContent = '-- Select an option --';
          select.appendChild(defaultOpt);
          field.options.forEach(opt => {
            const o = document.createElement('option');
            const value = typeof opt === 'string' ? opt : (opt?.value ?? opt?.text ?? opt?.label ?? '');
            const text = typeof opt === 'string' ? opt : (opt?.text ?? opt?.label ?? opt?.value ?? '');
            o.value = String(value);
            o.textContent = String(text);
            select.appendChild(o);
          });
          item.appendChild(select);
        } else {
          const multiLine = field.element_type === 'textarea' || inputType === 'textarea';
          answerInput = document.createElement(multiLine ? 'textarea' : 'input');
          answerInput.id = inputId;
          if (!multiLine) {
            const supportedInputTypes = new Set(['text', 'email', 'tel', 'number', 'date', 'datetime-local', 'time', 'url', 'search', 'password']);
            answerInput.type = supportedInputTypes.has(inputType) ? inputType : 'text';
          } else {
            answerInput.rows = 3;
          }
          answerInput.className = 'user-input-field-input user-input-field-input-box';
          answerInput.placeholder = String(field.placeholder || `Enter ${labelText}...`).slice(0, 160);
          answerInput.dataset.fieldId = field.field_id;
          if (answerInput.type === 'password') answerInput.autocomplete = 'new-password';
          item.appendChild(answerInput);
        }

        // Vault save toggle
        const semantic = String(field.semantic_type || '').toLowerCase();
        if (field.semantic_type && !['comments', 'message', 'other'].includes(semantic)) {
          const saveWrap = el('label', 'user-input-save-vault');
          const saveCheck = document.createElement('input');
          saveCheck.type = 'checkbox';
          saveCheck.className = 'user-input-save-vault-check';
          saveCheck.dataset.fieldId = field.field_id;
          saveCheck.dataset.semanticType = field.semantic_type;
          saveCheck.checked = false;
          saveWrap.appendChild(saveCheck);
          saveWrap.appendChild(el('span', null, 'Also save this answer in the Local Vault (optional)'));
          item.appendChild(saveWrap);
        }

        this.userInputFieldsContainer.appendChild(item);
      });
    } else {
      if (this.userInputFieldsContainer) this.userInputFieldsContainer.hidden = true;
      if (this.userInputSingleContainer) {
        this.userInputSingleContainer.hidden = false;
        if (this.userInputSingleText) this.userInputSingleText.value = '';
      }
    }

    this.openModal(this.userInputModal);
    const firstInput = this.userInputModal.querySelector('input:not([type="checkbox"]), select, textarea');
    if (firstInput) firstInput.focus();
  }

  submitUserInput() {
    const answers = {};
    const saveToVault = [];
    const fields = Array.isArray(this.currentAskData?.ambiguousFields) ? this.currentAskData.ambiguousFields : [];

    if (fields.length > 0) {
      const inputs = this.userInputModal.querySelectorAll('.user-input-field-input-box');
      inputs.forEach(inp => {
        const fid = inp.dataset.fieldId;
        if (!fid) return;
        let val;
        if (inp.type === 'checkbox') {
          val = inp.checked ? 'yes' : 'no';
        } else {
          val = inp.value.trim();
        }
        if (val) answers[fid] = val;
      });

      if (!Object.keys(answers).length) {
        if (this.userInputStatus) {
          this.userInputStatus.textContent = 'Enter at least one answer, or choose Skip.';
          this.userInputStatus.dataset.error = 'true';
        }
        const firstAnswer = this.userInputFieldsContainer?.querySelector('.user-input-field-input-box');
        firstAnswer?.focus();
        return;
      }

      const vaultChecks = this.userInputModal.querySelectorAll('.user-input-save-vault-check:checked');
      vaultChecks.forEach(chk => {
        const fid = chk.dataset.fieldId;
        const sem = chk.dataset.semanticType;
        const val = answers[fid];
        if (val && sem) {
          const vaultKey = vaultKeyForSemantic(sem);
          if (vaultKey) saveToVault.push({ key: vaultKey, value: val });
        }
      });
    } else {
      const freeText = this.userInputSingleText?.value?.trim() || '';
      if (freeText) {
        answers['response'] = freeText;
      }
      if (!Object.keys(answers).length) {
        if (this.userInputStatus) {
          this.userInputStatus.textContent = 'Enter a response, or choose Skip.';
          this.userInputStatus.dataset.error = 'true';
        }
        this.userInputSingleText?.focus();
        return;
      }
    }

    this.closeModal(this.userInputModal);
    this.send(MessageType.USER_PROVIDE_INPUT, {
      cancelled: false,
      answers,
      saveToVault,
      taskId: this.currentAskData?.taskId,
      requestId: this.currentAskData?.requestId
    });
  }

  skipUserInput() {
    this.closeModal(this.userInputModal);
    this.send(MessageType.USER_PROVIDE_INPUT, {
      cancelled: false,
      skipped: true,
      answers: {},
      saveToVault: [],
      taskId: this.currentAskData?.taskId,
      requestId: this.currentAskData?.requestId
    });
  }

  showDone(data) {
    this.setControls('done');
    this.closeModal(this.confirmModal);
    this.closeModal(this.userInputModal);
    this.doneState.hidden = false;
    this.errorState.hidden = true;
    this.doneSummary.textContent = data?.result || 'Application submitted successfully.';
    const m = this.task?.privacyMetrics;
    const keptLocal = m ? (m.sensitiveFieldsCurrent ?? m.sensitiveFieldsDetected ?? 0) : 0;
    this.donePrivacy.textContent = `${keptLocal} known sensitive value${keptLocal === 1 ? '' : 's'} resolved in browser · document names may be sent to planner`;
    this.stopElapsed();
  }

  showError(error, hint) {
    this.setControls('failed');
    this.closeModal(this.confirmModal);
    this.closeModal(this.userInputModal);
    this.errorState.hidden = false;
    this.doneState.hidden = true;
    this.errorSummary.textContent = error || 'PrivAgent could not complete the current step.';
    this.errorHint.textContent = hint || 'You can retry, take control to continue manually, or dismiss.';
    this.stopElapsed();
  }

  showStopped() {
    this.setControls('idle');
    this.closeModal(this.confirmModal);
    this.closeModal(this.userInputModal);
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
  closeAllModals() { [this.confirmModal, this.userInputModal, this.privacyModal, this.vaultModal, this.settingsModal].forEach((m) => { if (m) m.hidden = true; }); }

  async openVault() {
    const generation = ++this.vaultLoadGeneration;
    this.vaultLoaded = false;
    this.vaultReviewRequired = false;
    this.vaultReviewNotice.hidden = true;
    this.vaultReviewConfirm.checked = false;
    this.vaultReviewReveal.checked = false;
    this.setVaultReviewReveal(false);
    this.vaultSaveBtn.textContent = 'Save changes';
    this.setVaultControlsDisabled(true);
    this.setVaultSaveStatus('Loading encrypted vault…');
    this.renderVaultDocuments([]);
    this.openModal(this.vaultModal);
    const [vaultResponse, documentsResponse] = await Promise.all([
      this.sendAsync(MessageType.GET_VAULT),
      this.sendAsync(MessageType.GET_VAULT_DOCUMENTS)
    ]);
    if (generation !== this.vaultLoadGeneration) return;
    if (!vaultResponse?.vault || !Array.isArray(documentsResponse?.documents)) {
      this.setVaultSaveStatus('Vault could not be loaded. Close and reopen the panel to retry; saving is disabled.', true);
      return;
    }
    const storageError = vaultResponse.storageError || documentsResponse.storageError;
    if (storageError) {
      this.setVaultSaveStatus(`Vault unavailable: ${storageError} Saving is disabled.`, true);
      return;
    }
    {
      this.vaultReviewRequired = vaultResponse.reviewRequired === true;
      const v = this.vaultReviewRequired
        ? (vaultResponse.pendingReview || {})
        : vaultResponse.vault;
      this.$('vault-aadhaar').value = typeof v.LOCAL_AADHAAR === 'string' ? v.LOCAL_AADHAAR : '';
      this.$('vault-pan').value = typeof v.LOCAL_PAN === 'string' ? v.LOCAL_PAN : '';
      this.$('vault-name').value = typeof v.LOCAL_FULL_NAME === 'string' ? v.LOCAL_FULL_NAME : '';
      this.$('vault-dob').value = typeof v.LOCAL_DOB === 'string' ? v.LOCAL_DOB : '';
      this.$('vault-phone').value = typeof v.LOCAL_PHONE === 'string' ? v.LOCAL_PHONE : '';
      this.$('vault-email').value = typeof v.LOCAL_EMAIL === 'string' ? v.LOCAL_EMAIL : '';
      this.$('vault-address').value = typeof v.LOCAL_ADDRESS === 'string' ? v.LOCAL_ADDRESS : '';
      this.$('vault-city').value = typeof v.LOCAL_CITY === 'string' ? v.LOCAL_CITY : '';
      this.$('vault-state').value = typeof v.LOCAL_STATE === 'string' ? v.LOCAL_STATE : '';
      this.$('vault-zip').value = typeof v.LOCAL_ZIP === 'string' ? v.LOCAL_ZIP : '';
      this.$('vault-country').value = typeof v.LOCAL_COUNTRY === 'string' ? v.LOCAL_COUNTRY : '';
      this.$('vault-gender').value = typeof v.LOCAL_GENDER === 'string' ? v.LOCAL_GENDER : '';
      this.$('vault-credit-card').value = typeof v.LOCAL_CREDIT_CARD === 'string' ? v.LOCAL_CREDIT_CARD : '';
      this.$('vault-cvv').value = typeof v.LOCAL_CVV === 'string' ? v.LOCAL_CVV : '';
      this.$('vault-terms').value = typeof v.LOCAL_TERMS === 'string' ? v.LOCAL_TERMS : '';
      this.$('vault-profile').value = typeof v.LOCAL_PROFILE === 'string' ? v.LOCAL_PROFILE : '';
      this.$('vault-password').value = typeof v.LOCAL_PASSWORD === 'string' ? v.LOCAL_PASSWORD : '';
      this.$('vault-ssn').value = typeof v.LOCAL_SSN === 'string' ? v.LOCAL_SSN : '';
      this.$('vault-sin').value = typeof v.LOCAL_SIN === 'string' ? v.LOCAL_SIN : '';
      this.$('vault-nin').value = typeof v.LOCAL_NIN === 'string' ? v.LOCAL_NIN : '';
      this.$('vault-nhs').value = typeof v.LOCAL_NHS === 'string' ? v.LOCAL_NHS : '';
      this.$('vault-iban').value = typeof v.LOCAL_IBAN === 'string' ? v.LOCAL_IBAN : '';
      const customFields = this.$('vault-custom-fields');
      customFields.replaceChildren();
      for (const [key, value] of Object.entries(v)) {
        if (/^LOCAL_CUSTOM_[A-Z0-9_]{1,48}$/.test(key)) this.addCustomVaultField(key, value);
      }
      this.renderVaultDocuments(documentsResponse.documents);
    }
    this.vaultReviewNotice.hidden = !this.vaultReviewRequired;
    if (this.vaultReviewRequired) {
      this.vaultSaveBtn.textContent = 'Review and save values';
    }
    this.vaultLoaded = true;
    this.setVaultControlsDisabled(false);
    this.setVaultSaveStatus(this.vaultReviewRequired
      ? 'Old values remain encrypted and unavailable to the agent until you review and save them.'
      : 'Vault loaded. Changes are encrypted when saved.');
  }

  setVaultControlsDisabled(disabled) {
    const dialog = this.vaultModal?.querySelector('.vault-modal-dialog');
    dialog?.querySelectorAll('input, textarea, select, #vault-add-custom-btn, #vault-doc-add-btn, #save-vault-btn, .vault-doc-field button')
      .forEach((control) => { control.disabled = disabled; });
    const save = this.vaultSaveBtn || this.$('save-vault-btn');
    if (save) save.disabled = disabled || this.vaultSaving || !this.vaultLoaded ||
      (this.vaultReviewRequired && !this.vaultReviewConfirm?.checked);
  }

  setVaultReviewReveal(reveal) {
    this.vaultModal?.querySelectorAll('[data-vault-review-mask="true"]').forEach((input) => {
      input.type = reveal ? 'text' : 'password';
    });
  }

  renderVaultDocuments(documents) {
    const list = this.$('vault-doc-list');
    if (!list) return;
    list.replaceChildren();
    for (const document of documents) {
      list.appendChild(this.vaultDocumentRow(document.name, document.fileName, document.mimeType, document.byteLength));
    }
    this.setVaultDocStatus(documents.length
      ? `${documents.length} document${documents.length === 1 ? '' : 's'} stored on this device.`
      : 'No documents stored yet.');
  }

  vaultDocumentRow(existingName = '', existingFile = '', existingMime = '', existingBytes = null) {
    const field = document.createElement('div');
    field.className = 'vault-field vault-doc-field';

    const header = document.createElement('div');
    header.className = 'vault-label-row';
    const name = document.createElement('input');
    name.type = 'text';
    name.autocomplete = 'off';
    name.placeholder = 'Document name, e.g. aadhar';
    name.value = existingName ? existingName.replace(/^LOCAL_DOCUMENT_/, '').replace(/_/g, ' ') : '';
    name.dataset.docName = 'true';
    name.dataset.originalVaultDoc = existingName || '';
    name.setAttribute('aria-label', existingName ? `Stored document name: ${name.value}` : 'Document name');
    name.readOnly = Boolean(existingName);
    const token = document.createElement('code');
    token.className = 'mono-token';
    token.textContent = existingName || 'LOCAL_DOCUMENT_…';
    if (!existingName) {
      name.addEventListener('input', () => {
        const slug = this.vaultDocumentToken(name.value);
        token.textContent = slug || 'LOCAL_DOCUMENT_…';
      });
    }
    header.append(name, token);

    const file = document.createElement('input');
    file.type = 'file';
    const fileLabel = document.createElement('label');
    fileLabel.className = 'muted small';
    const fileLabelId = `vault-doc-file-${++this.vaultDocumentRowId}`;
    file.id = fileLabelId;
    fileLabel.htmlFor = fileLabelId;
    fileLabel.textContent = 'Choose a document';
    file.dataset.docFile = 'true';
    file.dataset.originalVaultDoc = existingName || '';
    if (existingFile) file.dataset.existingFile = existingFile;
    const summary = document.createElement('p');
    summary.className = 'muted small';
    summary.textContent = existingName
      ? `${existingFile || 'stored file'}${existingBytes ? ` · ${formatBytes(existingBytes)}` : ''}`
      : 'Choose a file (max 8 MB). It is encrypted at rest; the website can read it after you approve attachment.';

    if (existingName) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        remove.disabled = true;
        this.send(MessageType.DELETE_VAULT_DOCUMENT, { name: existingName }, (res) => {
          if (res?.deleted) {
            this.setVaultDocStatus('Document removed from this device.');
            field.remove();
          } else {
            remove.disabled = false;
            this.setVaultDocStatus(res?.error || 'The document could not be removed.', true);
          }
        });
      });
      field.append(header, summary, remove);
      return field;
    }

    field.append(header, fileLabel, file, summary);
    return field;
  }

  addVaultDocumentRow() {
    this.$('vault-doc-list')?.appendChild(this.vaultDocumentRow());
  }

  /** Mirror the backend's token grammar so an invalid name is never sent. */
  vaultDocumentToken(inputValue) {
    const slug = String(inputValue || '').toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '').slice(0, 48);
    return slug ? `LOCAL_DOCUMENT_${slug}` : null;
  }

  setVaultDocStatus(message, isError = false) {
    const status = this.$('vault-doc-status');
    if (!status) return;
    status.textContent = message;
    status.dataset.error = isError ? 'true' : 'false';
  }

  setVaultSaveStatus(message, isError = false) {
    if (!this.vaultSaveStatus) return;
    this.vaultSaveStatus.textContent = message;
    this.vaultSaveStatus.dataset.error = isError ? 'true' : 'false';
  }

  async saveVaultDocuments() {
    const rows = [...(this.$('vault-doc-list')?.querySelectorAll('.vault-doc-field') || [])];
    const pending = rows.filter((row) => row.querySelector('input[type="file"]')?.files?.[0]);
    if (!pending.length) return true;
    this.setVaultDocStatus('Encrypting and storing…');
    const pendingNames = new Set();
    const storedNames = new Set(rows.map((row) =>
      row.querySelector('[data-original-vault-doc]')?.dataset.originalVaultDoc
    ).filter(Boolean));
    for (const row of pending) {
      const nameInput = row.querySelector('[data-doc-name]');
      const fileInput = row.querySelector('input[type="file"]');
      const file = fileInput?.files?.[0];
      if (!file) continue;
      const name = this.vaultDocumentToken(nameInput?.value);
      if (!name) {
        this.setVaultDocStatus('Give each document a name, e.g. aadhar.', true);
        return false;
      }
      if (pendingNames.has(name)) {
        this.setVaultDocStatus(`Use a different name for each new document (${name}).`, true);
        return false;
      }
      if (storedNames.has(name)) {
        this.setVaultDocStatus(`${name} is already stored. Remove it first or choose a different name.`, true);
        return false;
      }
      pendingNames.add(name);
      if (!file.size) {
        this.setVaultDocStatus('That file is empty, so it cannot be stored.', true);
        return false;
      }
      if (file.size > 8 * 1024 * 1024) {
        this.setVaultDocStatus('That file is larger than the 8 MB vault limit.', true);
        return false;
      }
    }
    for (const row of pending) {
      const nameInput = row.querySelector('[data-doc-name]');
      const fileInput = row.querySelector('input[type="file"]');
      const file = fileInput?.files?.[0];
      if (!file) continue;
      const name = this.vaultDocumentToken(nameInput?.value);
      const data = await readFileAsBase64(file);
      const stored = await this.sendAsync(MessageType.STORE_VAULT_DOCUMENT, {
        name, data, fileName: file.name, mimeType: file.type || 'application/octet-stream'
      });
      if (!stored?.success) {
        this.setVaultDocStatus(stored?.error || 'The document could not be stored.', true);
        return false;
      }
      row.replaceWith(this.vaultDocumentRow(name, stored.document?.fileName || file.name,
        stored.document?.mimeType || file.type, stored.document?.byteLength || file.size));
      this.setVaultDocStatus('Document stored on this device.');
    }
    return true;
  }

  addCustomVaultField(key = '', value = '') {
    const customFields = this.$('vault-custom-fields');
    const field = document.createElement('label');
    field.className = 'vault-field';
    const header = document.createElement('div');
    header.className = 'vault-label-row';
    const label = document.createElement('input');
    label.type = 'text';
    label.autocomplete = 'off';
    label.dataset.vaultName = 'true';
    label.placeholder = 'Value name, e.g. Passport';
    label.value = key ? key.replace(/^LOCAL_CUSTOM_/, '').replace(/_/g, ' ') : '';
    const token = document.createElement('code');
    token.className = 'mono-token';
    token.textContent = key || 'LOCAL_CUSTOM_…';
    header.append(label, token);
    const input = document.createElement('input');
    input.type = 'password';
    input.dataset.vaultReviewMask = 'true';
    input.autocomplete = 'off';
    input.dataset.originalVaultKey = key;
    input.value = typeof value === 'string' ? value : '';
    input.placeholder = 'Stored only in this browser';
    label.addEventListener('input', () => {
      const slug = label.value.toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
      token.textContent = slug ? `LOCAL_CUSTOM_${slug}` : 'LOCAL_CUSTOM_…';
    });
    field.append(header, input);
    customFields.append(field);
    if (this.vaultReviewReveal?.checked) this.setVaultReviewReveal(true);
  }

  async saveVault() {
    if (!this.vaultLoaded || this.vaultSaving) return;
    if (this.vaultReviewRequired && !this.vaultReviewConfirm.checked) {
      this.setVaultSaveStatus('Review the displayed values and check the confirmation box before enabling them.', true);
      return;
    }
    const updates = [
      ['LOCAL_AADHAAR', this.$('vault-aadhaar').value],
      ['LOCAL_PAN', this.$('vault-pan').value],
      ['LOCAL_FULL_NAME', this.$('vault-name').value],
      ['LOCAL_DOB', this.$('vault-dob').value],
      ['LOCAL_PHONE', this.$('vault-phone').value],
      ['LOCAL_EMAIL', this.$('vault-email').value],
      ['LOCAL_ADDRESS', this.$('vault-address').value],
      ['LOCAL_CITY', this.$('vault-city').value],
      ['LOCAL_STATE', this.$('vault-state').value],
      ['LOCAL_ZIP', this.$('vault-zip').value],
      ['LOCAL_COUNTRY', this.$('vault-country').value],
      ['LOCAL_GENDER', this.$('vault-gender').value],
      ['LOCAL_CREDIT_CARD', this.$('vault-credit-card').value],
      ['LOCAL_CVV', this.$('vault-cvv').value],
      ['LOCAL_TERMS', this.$('vault-terms').value],
      ['LOCAL_PROFILE', this.$('vault-profile').value],
      ['LOCAL_PASSWORD', this.$('vault-password').value],
      ['LOCAL_SSN', this.$('vault-ssn').value],
      ['LOCAL_SIN', this.$('vault-sin').value],
      ['LOCAL_NIN', this.$('vault-nin').value],
      ['LOCAL_NHS', this.$('vault-nhs').value],
      ['LOCAL_IBAN', this.$('vault-iban').value],
      ...Array.from(this.$('vault-custom-fields').querySelectorAll('input[data-original-vault-key]'))
        .flatMap((input) => {
          const label = input.parentElement.querySelector('input[data-vault-name]')?.value || '';
          const slug = label.toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48);
          if (!slug) return [];
          const key = `LOCAL_CUSTOM_${slug}`;
          const oldKey = input.dataset.originalVaultKey;
          return oldKey && oldKey !== key ? [[oldKey, ''], [key, input.value]] : [[key, input.value]];
        })
    ];
    this.vaultSaving = true;
    this.setVaultControlsDisabled(true);
    this.setVaultSaveStatus(this.vaultReviewRequired ? 'Saving reviewed vault values…' : 'Saving vault values…');
    try {
      if (this.vaultReviewRequired) {
        const response = await this.sendAsync(MessageType.CONFIRM_VAULT_REVIEW, {
          values: Object.fromEntries(updates)
        });
        if (!response?.success) throw new Error(response?.error || 'Reviewed vault values could not be saved.');
        this.vaultReviewRequired = false;
        this.vaultReviewNotice.hidden = true;
        this.vaultSaveBtn.textContent = 'Save changes';
      } else {
        for (const [key, value] of updates) {
          const response = await this.sendAsync(MessageType.UPDATE_VAULT, { key, value });
          if (!response?.success) throw new Error(response?.error || `Could not save ${key}.`);
        }
      }
      const documentsSaved = await this.saveVaultDocuments();
      if (!documentsSaved) throw new Error('Correct the document details above, then save again.');
      this.setVaultSaveStatus('Vault saved on this device.');
      this.closeModal(this.vaultModal);
    } catch (error) {
      this.setVaultSaveStatus(error?.message || 'Vault could not be saved.', true);
    } finally {
      this.vaultSaving = false;
      this.setVaultControlsDisabled(false);
    }
  }

  applySettingsToUI() {
    try {
      const raw = localStorage.getItem('privagent_settings');
      if (raw) this.reflectSettings(JSON.parse(raw));
    } catch { /* ignore */ }
  }

  reflectSettings(s) {
    if (!s) return;
    try {
      const cached = { ...s };
      delete cached.backendToken;
      localStorage.setItem('privagent_settings', JSON.stringify(cached));
    } catch { /* ignore */ }
    this.$('settings-backend').value = s.backendUrl || '';
    this.$('settings-backend-token').value = s.backendToken || '';
    this.$('settings-maxsteps').value = s.maxSteps || '';
    if (this.$('settings-allow-remote')) this.$('settings-allow-remote').checked = s.allowRemoteBackend === true;
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
    // A rejected backend URL must be visible; updateSettings throws with the
    // reason and the modal stays open so the value can be corrected.
    const settings = {
      backendUrl: this.$('settings-backend').value.trim(),
      backendToken: this.$('settings-backend-token').value.trim(),
      maxSteps: Math.min(50, Math.max(1, parseInt(this.$('settings-maxsteps').value, 10) || 25)),
      alwaysConfirm: this.$('settings-confirm').checked,
      showDebug: this.$('settings-debug').checked,
      allowRemoteBackend: this.$('settings-allow-remote')?.checked === true
    };
    this.reflectSettings(settings);
    this.send(MessageType.UPDATE_SETTINGS, settings, (res) => {
      if (res && res.success === false) {
        this.$('settings-error')?.removeAttribute('hidden');
        const box = this.$('settings-error');
        if (box) box.textContent = res.error || 'Settings could not be saved.';
        return;
      }
      this.$('settings-error')?.setAttribute('hidden', '');
      this.closeModal(this.settingsModal);
    });
  }

  applyTheme() {
    try {
      const t = localStorage.getItem('privagent_theme') || 'light';
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

  clearVlmScreenshotPreviews() {
    this.vlmScreenshotPreviews = [];
    if (this.llmScreenshotPreviewList) this.llmScreenshotPreviewList.replaceChildren();
    if (this.llmScreenshotPreviewCard) {
      this.llmScreenshotPreviewCard.hidden = true;
      this.llmScreenshotPreviewCard.open = false;
    }
    this.renderLatestRedactedShot();
  }

  /**
   * The newest redacted image, shown in the Privacy Shield without needing to
   * expand anything. It is the same data URL that was attached to the request,
   * not a re-render of the live page, so what is on screen here is exactly
   * what the vision model received.
   */
  renderLatestRedactedShot() {
    const image = this.$('redacted-shot-image');
    const frame = this.$('redacted-shot-frame');
    const empty = this.$('redacted-shot-empty');
    const status = this.$('redacted-shot-status');
    if (!image || !frame || !empty || !status) return;
    const latest = this.vlmScreenshotPreviews?.[0] || null;
    const history = this.$('redacted-shot-history-list');
    const count = this.$('redacted-shot-history-count');

    if (!latest) {
      image.removeAttribute('src');
      frame.hidden = true;
      empty.hidden = false;
      status.textContent = 'No image sent yet';
      status.dataset.state = 'idle';
      if (history) history.replaceChildren();
      if (count) count.textContent = '0';
      return;
    }

    image.src = latest.screenshot;
    frame.hidden = false;
    empty.hidden = true;
    const label = latest.redactionStatus === 'masked'
      ? 'Masked before sending'
      : latest.redactionStatus === 'checked'
        ? 'Sent, no known regions to mask'
        : 'Privacy status unavailable';
    status.textContent = latest.step ? `Step ${latest.step} · ${label}` : label;
    status.dataset.state = latest.redactionStatus;

    const older = this.vlmScreenshotPreviews.slice(1);
    if (count) count.textContent = String(older.length);
    if (history) {
      history.replaceChildren();
      for (const preview of older) {
        const item = el('figure', 'redacted-shot-thumb');
        const thumb = document.createElement('img');
        thumb.loading = 'lazy';
        thumb.decoding = 'async';
        thumb.alt = preview.step ? `Redacted screenshot from step ${preview.step}` : 'Earlier redacted screenshot';
        thumb.src = preview.screenshot;
        item.append(thumb, el('figcaption', 'redacted-shot-thumb-cap',
          preview.step ? `Step ${preview.step}` : 'Earlier'));
        history.appendChild(item);
      }
    }
  }

  addVlmScreenshotPreview(data = {}) {
    const currentTaskId = this.task?.id;
    if (currentTaskId && data.task_id && currentTaskId !== data.task_id) return;
    const screenshot = data.sanitized_screenshot;
    const safeDataUrl = typeof screenshot === 'string' && screenshot.length <= MAX_VLM_SCREENSHOT_PREVIEW_CHARS &&
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(screenshot)
        ? screenshot
        : null;
    const wasSent = data.sent !== false;
    if (wasSent && !safeDataUrl) {
      log.warn('Ignored an invalid or oversized VLM screenshot preview.');
      return;
    }

    this.vlmScreenshotPreviews.unshift({
      step: Number.isInteger(data.step) && data.step > 0 ? data.step : null,
      sent: wasSent,
      redactionStatus: ['masked', 'checked', 'withheld', 'skipped', 'unavailable'].includes(data.redaction_status)
        ? data.redaction_status
        : 'unknown',
      screenshot: safeDataUrl
    });
    this.vlmScreenshotPreviews = this.vlmScreenshotPreviews.slice(0, MAX_VLM_SCREENSHOT_PREVIEWS);
    this.renderLatestRedactedShot();
    const previewChars = () => this.vlmScreenshotPreviews.reduce(
      (sum, preview) => sum + (preview.screenshot ? preview.screenshot.length : 0), 0
    );
    while (this.vlmScreenshotPreviews.length > 1 &&
      previewChars() > MAX_VLM_SCREENSHOT_PREVIEW_TOTAL_CHARS) {
      this.vlmScreenshotPreviews.pop();
    }
    this.renderVlmScreenshotPreviews();
    if (this.llmScreenshotPreviewCard) {
      this.llmScreenshotPreviewCard.hidden = false;
      this.llmScreenshotPreviewCard.open = true;
    }
  }

  renderVlmScreenshotPreviews() {
    if (!this.llmScreenshotPreviewList) return;
    this.llmScreenshotPreviewList.replaceChildren();
    for (const preview of this.vlmScreenshotPreviews) {
      const item = el('article', 'llm-screenshot-preview-item');
      if (!preview.sent) {
        // A step where the agent deliberately sent no image. Showing this is
        // what makes the panel honest: an empty list used to be ambiguous
        // between "nothing was sent", "nothing happened", and "broken".
        const reason = preview.redactionStatus === 'withheld'
          ? 'Withheld by local privacy checks — a neutral placeholder was sent instead of pixels.'
          : preview.redactionStatus === 'skipped'
            ? 'Not needed — the structured DOM evidence was sufficient, so no screenshot was captured or sent.'
            : 'No image could be captured or passed local privacy checks, so nothing was sent.';
        item.appendChild(el('div', 'llm-screenshot-preview-heading',
          `${preview.step ? `Step ${preview.step} · ` : ''}Nothing sent to the VLM`));
        item.appendChild(el('p', 'llm-screenshot-preview-note', reason));
        this.llmScreenshotPreviewList.appendChild(item);
        continue;
      }
      const label = preview.redactionStatus === 'masked'
        ? 'Sent to the VLM · known sensitive regions masked'
        : preview.redactionStatus === 'checked'
          ? 'Sent to the VLM · checked, no known regions to mask'
          : 'Sent to the VLM · privacy status unavailable';
      item.appendChild(el('div', 'llm-screenshot-preview-heading',
        `${preview.step ? `Step ${preview.step} · ` : ''}${label}`));
      const image = document.createElement('img');
      image.className = 'llm-screenshot-preview-image';
      image.alt = `Sanitized screenshot attached to the VLM request${preview.step ? ` at step ${preview.step}` : ''}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = preview.screenshot;
      item.appendChild(image);
      this.llmScreenshotPreviewList.appendChild(item);
    }
  }

  toggleTheme() {
    const cur = document.documentElement.dataset.theme || 'light';
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
    const exportButton = el('button', 'btn btn-secondary', 'Download error log (.jsonl)');
    exportButton.type = 'button';
    exportButton.title = 'Errors, warnings and info traces from the side panel, service worker and content scripts.';
    exportButton.addEventListener('click', () => this.downloadErrorLog(exportButton));
    this.debugBody.appendChild(exportButton);
    if (!t) { this.debugBody.appendChild(el('p', 'muted small', 'No task data yet.')); return; }
    const rows = [
      ['task id', t.id || '—'],
      ['state', t.state || '—'],
      ['step', `${t.currentStep ?? 0}/${t.maxSteps ?? 25}`],
      ['tab id', String(t.tabId ?? '—')],
      ['server calls', String(t.privacyMetrics?.serverCallsCount ?? 0)],
      ['last step time', `${t.lastStepTimings?.total_ms ?? '—'} ms`],
      ['local vision time', `${t.privacyMetrics?.localVisionLatencyMs ?? 0} ms total`],
      ['OCR regions masked', String(t.privacyMetrics?.localOcrPiiRegions ?? 0)],
      ['people masked', String(t.privacyMetrics?.localPeopleMasked ?? 0)],
      ['sensitive fields', String(t.privacyMetrics?.sensitiveFieldsDetected ?? 0)],
      ['pending confirm', t.pendingConfirmation ? 'yes' : 'no']
    ];
    for (const [k, v] of rows) {
      const row = el('div', 'row');
      row.appendChild(el('span', null, k));
      row.appendChild(el('span', null, v));
      this.debugBody.appendChild(row);
    }
    const visionButton = el('button', 'btn btn-secondary', 'Download local vision labels');
    visionButton.type = 'button';
    visionButton.disabled = !(t.visionSamples || []).length;
    visionButton.addEventListener('click', () => this.downloadVisionEvaluation());
    this.debugBody.appendChild(visionButton);
    const taskTraceButton = el('button', 'btn btn-secondary', 'Download task timing trace');
    taskTraceButton.type = 'button';
    taskTraceButton.disabled = !(t.steps || []).length && !t.terminalStepTimings;
    taskTraceButton.addEventListener('click', () => this.downloadTaskTimingTrace());
    this.debugBody.appendChild(taskTraceButton);
  }

  /**
   * Write the merged log to a .jsonl file.
   *
   * A Manifest V3 extension cannot write to the filesystem, so the log lives in
   * chrome.storage and this is the only way to get it out as a file. Entries
   * from every surface are merged and time-ordered, because the service
   * worker's buffer does not survive its own suspension.
   */
  async downloadErrorLog(button) {
    // Trimmed: the settings-modal markup is indented, and restoring the raw
    // textContent would leave the button label padded with newlines.
    const original = (button?.textContent || '').trim();
    if (button) button.disabled = true;
    if (button) button.textContent = 'Collecting…';
    try {
      const entries = await collectLogEntries();
      if (!entries.length) {
        log.info('No log entries to export yet.');
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      downloadText(
        buildLogExport(entries, { surface: 'sidepanel' }),
        `privagent-error-log-${stamp}.jsonl`
      );
      log.info('Exported the error log.', { entries: entries.length });
    } catch (error) {
      log.exception('Could not export the error log', error);
    } finally {
      if (button) {
        button.textContent = original;
        button.disabled = false;
      }
    }
  }

  downloadTaskTimingTrace() {
    const task = this.task;
    if (!task) return;
    const now = Date.now();
    const reasoningModels = new Set();
    const visionModels = new Set();
    const finalTrace = task.lastLLMPayload?.modelTrace || {};
    if (finalTrace.reasoning?.model) reasoningModels.add(finalTrace.reasoning.model);
    if (finalTrace.vision?.model) visionModels.add(finalTrace.vision.model);
    const steps = (task.steps || []).map((step) => {
      const trace = step.diagnostic?.model_trace || {};
      if (trace.reasoning?.model) reasoningModels.add(trace.reasoning.model);
      if (trace.vision?.model) visionModels.add(trace.vision.model);
      return {
        step: step.stepNumber,
        action: step.action?.action || null,
        success: step.success !== false,
        timings_ms: step.diagnostic?.timing_ms || null,
        model_sources: {
          reasoning: trace.reasoning?.source || null,
          vision: trace.vision?.source || null
        }
      };
    });
    const elapsedMs = Math.max(0, (task.endTime || now) - (task.startTime || now));
    const humanWaitMs = [
      ...steps.map((step) => step.timings_ms),
      task.terminalStepTimings
    ].reduce((total, timings) => total + (timings?.user_wait_ms || 0) + (timings?.confirmation_wait_ms || 0), 0);
    const run = {
      task_id: task.id,
      case_id: null,
      intent: task.taskIntent || null,
      status: task.state,
      success: task.state === AgentState.COMPLETED ? true
        : [AgentState.FAILED, AgentState.CANCELLED].includes(task.state) ? false : null,
      reviewed_success: null,
      elapsed_ms: elapsedMs,
      agent_elapsed_ms: Math.max(0, elapsedMs - humanWaitMs),
      human_wait_ms: humanWaitMs,
      remote_calls: task.privacyMetrics?.serverCallsCount ?? null,
      terminal_step_timings_ms: task.terminalStepTimings || null,
      reasoning_models: [...reasoningModels],
      vision_models: [...visionModels],
      steps
    };
    const blob = new Blob([`${JSON.stringify(run)}\n`], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${task.id || 'browser-agent'}-task-timing.jsonl`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log.info('Exported the task timing trace.', { steps: steps.length });
  }

  downloadVisionEvaluation() {
    const task = this.task;
    if (!task?.visionSamples?.length) return;
    const taskLatency = Number.isFinite(task.endTime) ? task.endTime - task.startTime : null;
    const lines = task.visionSamples.map((sample, index) => JSON.stringify({
      sample_id: `${task.id || 'task'}-${sample.step}`,
      truth_required: true,
      objects: { truth: [], predicted: sample.objects || [] },
      pii: { truth: [], predicted: sample.pii || [] },
      redactions: { truth: [], predicted: sample.redactions || [] },
      end_to_end_latency_ms: index === task.visionSamples.length - 1 ? taskLatency : null,
      client_heap_bytes: sample.clientHeapBytes,
      client_asset_bytes: sample.clientAssetBytes,
      local_vision_latency_ms: sample.localVisionLatencyMs
    }));
    const blob = new Blob([`${lines.join('\n')}\n`], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${task.id || 'privacy-agent'}-vision-evaluation.jsonl`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log.info('Exported the local vision labels.', { samples: task.visionSamples.length });
  }
}

/**
 * Trigger a file download from generated text.
 *
 * Shared by all three exports so they agree on the JSONL MIME type and on
 * revoking the object URL: a revoked-too-early URL makes the download fail
 * silently in Firefox, and a leaked one pins the whole export in memory.
 */
function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function spreadsheetSafeCell(value) {
  const cell = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/[\t\r\n]+/g, ' ').trim();
  // Treat PDF text as data when pasted into a spreadsheet. This prevents a
  // cell beginning with a formula marker from executing as a Sheets formula.
  return /^[\s]*[=+\-@]/.test(cell) ? `'${cell}` : cell;
}

function safeFileStem(filename) {
  const stem = String(filename || 'pdf').replace(/\.pdf$/i, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return stem || 'pdf';
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

document.addEventListener('DOMContentLoaded', () => { window.privAgentApp = new SidePanelApp(); });
