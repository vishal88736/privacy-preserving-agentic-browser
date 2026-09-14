/**
 * Background Message Router
 * Handles IPC messages between Side Panel UI and Agent Controller.
 */

import { MessageType } from '../shared/messages.js';
import { agentController } from './agent-controller.js';
import { taskManager } from './task-manager.js';
import { defaultLocalVault } from '../privacy/local-vault.js';

export function setupMessageRouter() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, payload } = message;

    switch (type) {
      case MessageType.START_TASK:
        agentController.startTask(payload.prompt, payload.tabId);
        sendResponse({ success: true, task: taskManager.getTask() });
        break;

      case MessageType.PAUSE_TASK:
        agentController.pauseTask();
        sendResponse({ success: true });
        break;

      case MessageType.RESUME_TASK:
        agentController.resumeTask();
        sendResponse({ success: true });
        break;

      case MessageType.CANCEL_TASK:
        agentController.cancelTask();
        sendResponse({ success: true });
        break;

      case MessageType.USER_CONFIRM_ACTION:
        agentController.handleUserConfirmation(payload.approved);
        sendResponse({ success: true });
        break;

      case MessageType.GET_AGENT_STATUS:
        sendResponse({
          task: taskManager.getTask(),
          vaultSummary: defaultLocalVault.getAvailableKeysSummary()
        });
        break;

      case MessageType.GET_VAULT:
        sendResponse({
          vault: defaultLocalVault.getAllSecretsForUI()
        });
        break;

      case MessageType.UPDATE_VAULT:
        defaultLocalVault.updateSecret(payload.key, payload.value).then(() => {
          sendResponse({ success: true });
        });
        return true;

      default:
        break;
    }
  });

  // Broadcast agent updates to all open side panels
  agentController.subscribe((event, data) => {
    chrome.runtime.sendMessage({
      type: MessageType.AGENT_STATUS_UPDATE,
      payload: { event, data, task: taskManager.getTask() }
    }).catch(() => {
      // Ignored if sidepanel is currently closed
    });
  });
}
