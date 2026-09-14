/**
 * Side Panel Main Controller
 * Connects the UI to background agent controller and local vault.
 */

import { MessageType } from '../shared/messages.js';
import { AgentState } from '../shared/constants.js';

class SidePanelApp {
  constructor() {
    this.currentTask = null;
    this.initElements();
    this.bindEvents();
    this.listenForUpdates();
    this.pollInitialStatus();
  }

  initElements() {
    // Inputs & Buttons
    this.taskPrompt = document.getElementById('task-prompt');
    this.startBtn = document.getElementById('start-task-btn');
    this.pauseBtn = document.getElementById('pause-task-btn');
    this.cancelBtn = document.getElementById('cancel-task-btn');
    this.quickTags = document.querySelectorAll('.quick-tag');

    // Status Banner
    this.statusBanner = document.getElementById('status-banner');
    this.stateText = document.getElementById('agent-state-text');
    this.substatusText = document.getElementById('agent-substatus-text');
    this.stepCounter = document.getElementById('step-counter');

    // Privacy Metrics
    this.metricSensitive = document.getElementById('metric-sensitive-count');
    this.metricServerCalls = document.getElementById('metric-server-calls');
    this.localItemsList = document.getElementById('local-items-list');

    // Activity Feed
    this.activityFeed = document.getElementById('activity-feed');

    // Confirmation Modal
    this.confirmModal = document.getElementById('confirmation-modal');
    this.confirmReason = document.getElementById('confirm-reason');
    this.confirmActionVerb = document.getElementById('confirm-action-verb');
    this.confirmActionTarget = document.getElementById('confirm-action-target');
    this.confirmDataLocal = document.getElementById('confirm-data-local');
    this.modalApproveBtn = document.getElementById('modal-approve-btn');
    this.modalRejectBtn = document.getElementById('modal-reject-btn');

    // Vault Modal
    this.vaultBtn = document.getElementById('vault-btn');
    this.vaultModal = document.getElementById('vault-modal');
    this.closeVaultBtn = document.getElementById('close-vault-btn');
    this.saveVaultBtn = document.getElementById('save-vault-btn');
    this.vaultAadhaar = document.getElementById('vault-aadhaar');
    this.vaultPan = document.getElementById('vault-pan');
    this.vaultName = document.getElementById('vault-name');
    this.vaultDob = document.getElementById('vault-dob');
    this.vaultPhone = document.getElementById('vault-phone');
    this.vaultPassword = document.getElementById('vault-password');
  }

  bindEvents() {
    this.startBtn.addEventListener('click', () => this.handleStartTask());
    this.pauseBtn.addEventListener('click', () => this.handleTogglePause());
    this.cancelBtn.addEventListener('click', () => this.handleCancelTask());

    this.quickTags.forEach(tag => {
      tag.addEventListener('click', () => {
        const prompt = tag.getAttribute('data-prompt');
        if (prompt) {
          this.taskPrompt.value = prompt;
          this.handleStartTask();
        }
      });
    });

    this.modalApproveBtn.addEventListener('click', () => this.sendConfirmation(true));
    this.modalRejectBtn.addEventListener('click', () => this.sendConfirmation(false));

    this.vaultBtn.addEventListener('click', () => this.openVaultModal());
    this.closeVaultBtn.addEventListener('click', () => this.closeVaultModal());
    this.saveVaultBtn.addEventListener('click', () => this.saveVault());
  }

  async getActiveTabId() {
    if (typeof chrome !== 'undefined' && chrome.tabs?.query) {
      let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      }
      return tab?.id || null;
    }
    return 1;
  }

  async handleStartTask() {
    const prompt = this.taskPrompt.value.trim();
    if (!prompt) return;

    const tabId = await this.getActiveTabId();
    if (!tabId) {
      alert('Could not find active browser tab to control.');
      return;
    }

    this.startBtn.style.display = 'none';
    this.pauseBtn.style.display = 'inline-flex';
    this.cancelBtn.style.display = 'inline-flex';
    this.activityFeed.innerHTML = '';

    chrome.runtime.sendMessage({
      type: MessageType.START_TASK,
      payload: { prompt, tabId }
    });
  }

  handleTogglePause() {
    if (this.pauseBtn.innerText === 'Pause') {
      this.pauseBtn.innerText = 'Resume';
      chrome.runtime.sendMessage({ type: MessageType.PAUSE_TASK });
    } else {
      this.pauseBtn.innerText = 'Pause';
      chrome.runtime.sendMessage({ type: MessageType.RESUME_TASK });
    }
  }

  handleCancelTask() {
    chrome.runtime.sendMessage({ type: MessageType.CANCEL_TASK });
    this.resetControls();
  }

  sendConfirmation(approved) {
    this.confirmModal.style.display = 'none';
    chrome.runtime.sendMessage({
      type: MessageType.USER_CONFIRM_ACTION,
      payload: { approved }
    });
  }

  resetControls() {
    this.startBtn.style.display = 'inline-flex';
    this.pauseBtn.style.display = 'none';
    this.cancelBtn.style.display = 'none';
    this.pauseBtn.innerText = 'Pause';
  }

  listenForUpdates() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === MessageType.AGENT_STATUS_UPDATE) {
        this.processStatusUpdate(message.payload);
      }
    });
  }

  pollInitialStatus() {
    chrome.runtime.sendMessage({ type: MessageType.GET_AGENT_STATUS }, (response) => {
      if (response && response.task) {
        this.currentTask = response.task;
        this.updateUIFromTask(response.task);
      }
    });
  }

  processStatusUpdate({ event, data, task }) {
    this.currentTask = task;
    this.updateUIFromTask(task);

    switch (event) {
      case 'STATE_CHANGED':
        this.updateStateBanner(data.state, data.step);
        break;

      case 'PRIVACY_UPDATED':
        this.updatePrivacyMetrics(data);
        break;

      case 'CONFIRMATION_REQUIRED':
        this.showConfirmationModal(data);
        break;

      case 'STEP_COMPLETED':
        this.appendActivityStep(data);
        break;

      case 'TASK_COMPLETED':
        this.stateText.innerText = 'COMPLETED';
        this.substatusText.innerText = data.result || 'Task completed successfully.';
        this.statusBanner.className = 'status-banner state-completed';
        this.resetControls();
        break;

      case 'TASK_FAILED':
        this.stateText.innerText = 'FAILED';
        this.substatusText.innerText = data.error || 'Task execution failed.';
        this.statusBanner.className = 'status-banner state-waiting';
        this.resetControls();
        break;

      case 'TASK_CANCELLED':
        this.stateText.innerText = 'CANCELLED';
        this.substatusText.innerText = 'Task stopped by user.';
        this.statusBanner.className = 'status-banner state-idle';
        this.resetControls();
        break;
    }
  }

  updateUIFromTask(task) {
    if (!task) return;
    this.updateStateBanner(task.state, task.currentStep);
    this.updatePrivacyMetrics(task.privacyMetrics);
  }

  updateStateBanner(state, step) {
    this.stateText.innerText = state;
    if (step !== undefined) {
      this.stepCounter.innerText = `Step ${step}`;
    }

    // Set styling and detail messages
    const stateMap = {
      [AgentState.IDLE]: { class: 'state-idle', text: 'Ready for instructions.' },
      [AgentState.UNDERSTANDING_TASK]: { class: 'state-planning', text: 'Decomposing task goal...' },
      [AgentState.OBSERVING]: { class: 'state-observing', text: 'Capturing DOM and visual layout...' },
      [AgentState.SANITIZING]: { class: 'state-sanitizing', text: 'Scrubbing PII & masking screenshot...' },
      [AgentState.VISUAL_ANALYSIS]: { class: 'state-observing', text: 'Server VLM processing visual state...' },
      [AgentState.PLANNING]: { class: 'state-planning', text: 'Reasoning next action (GPT-OSS 120B)...' },
      [AgentState.VALIDATING_ACTION]: { class: 'state-planning', text: 'Checking local safety policy...' },
      [AgentState.WAITING_FOR_USER]: { class: 'state-waiting', text: 'Awaiting human authorization...' },
      [AgentState.EXECUTING]: { class: 'state-executing', text: 'Resolving secrets & executing action...' },
      [AgentState.VERIFYING]: { class: 'state-observing', text: 'Verifying interaction outcome...' },
      [AgentState.COMPLETED]: { class: 'state-completed', text: 'Goal achieved.' },
      [AgentState.FAILED]: { class: 'state-waiting', text: 'Error encountered.' }
    };

    const info = stateMap[state] || { class: 'state-idle', text: state };
    this.statusBanner.className = `status-banner ${info.class}`;
    this.substatusText.innerText = info.text;
  }

  updatePrivacyMetrics(metrics) {
    if (!metrics) return;
    this.metricSensitive.innerText = metrics.sensitiveFieldsDetected || 0;
    this.metricServerCalls.innerText = metrics.serverCallsCount || 0;
  }

  showConfirmationModal(data) {
    const { action, reason, privacySummary } = data;
    this.confirmReason.innerText = reason;
    this.confirmActionVerb.innerText = action.action;
    this.confirmActionTarget.innerText = action.target?.label || action.target?.element_id || 'Page Element';
    this.confirmDataLocal.innerText = privacySummary?.dataKeptLocal || 'Protected in Local Vault';
    this.confirmModal.style.display = 'flex';
  }

  appendActivityStep(data) {
    const item = document.createElement('div');
    item.className = 'feed-item';

    const riskClass = data.action?.risk === 'HIGH' ? 'badge-high' : (data.action?.risk === 'MEDIUM' ? 'badge-medium' : 'badge-low');

    item.innerHTML = `
      <div class="feed-header">
        <span class="feed-step-num">STEP ${data.stepNumber}</span>
        <span class="feed-action-badge ${riskClass}">${data.action?.action || 'ACTION'}</span>
      </div>
      <p class="feed-thought">${data.thought}</p>
      <div class="feed-details">
        Target: ${data.action?.target?.label || data.action?.target?.element_id || 'Viewport'}
        ${data.action?.value_source ? ` • Source: <span class="highlight-green">${data.action.value_source}</span>` : ''}
      </div>
    `;

    // Remove empty notice if present
    const emptyNotice = this.activityFeed.querySelector('.empty-feed');
    if (emptyNotice) emptyNotice.remove();

    this.activityFeed.appendChild(item);
    this.activityFeed.scrollTop = this.activityFeed.scrollHeight;
  }

  openVaultModal() {
    chrome.runtime.sendMessage({ type: MessageType.GET_VAULT }, (res) => {
      if (res && res.vault) {
        this.vaultAadhaar.value = res.vault.LOCAL_AADHAAR || '';
        this.vaultPan.value = res.vault.LOCAL_PAN || '';
        this.vaultName.value = res.vault.LOCAL_FULL_NAME || '';
        this.vaultDob.value = res.vault.LOCAL_DOB || '';
        this.vaultPhone.value = res.vault.LOCAL_PHONE || '';
        this.vaultPassword.value = res.vault.LOCAL_PASSWORD || '';
      }
      this.vaultModal.style.display = 'flex';
    });
  }

  closeVaultModal() {
    this.vaultModal.style.display = 'none';
  }

  async saveVault() {
    const updates = [
      { key: 'LOCAL_AADHAAR', value: this.vaultAadhaar.value },
      { key: 'LOCAL_PAN', value: this.vaultPan.value },
      { key: 'LOCAL_FULL_NAME', value: this.vaultName.value },
      { key: 'LOCAL_DOB', value: this.vaultDob.value },
      { key: 'LOCAL_PHONE', value: this.vaultPhone.value },
      { key: 'LOCAL_PASSWORD', value: this.vaultPassword.value }
    ];

    for (const update of updates) {
      await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: MessageType.UPDATE_VAULT,
          payload: update
        }, resolve);
      });
    }

    this.closeVaultModal();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new SidePanelApp();
});
