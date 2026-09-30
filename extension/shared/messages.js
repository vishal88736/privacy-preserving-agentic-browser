/**
 * Internal Chrome Extension Message Types and Factories
 */

export const MessageType = Object.freeze({
  // Side Panel <-> Background
  START_TASK: 'START_TASK',
  PAUSE_TASK: 'PAUSE_TASK',
  RESUME_TASK: 'RESUME_TASK',
  CANCEL_TASK: 'CANCEL_TASK',
  USER_CONFIRM_ACTION: 'USER_CONFIRM_ACTION',
  USER_INPUT_REQUIRED: 'USER_INPUT_REQUIRED',
  USER_PROVIDE_INPUT: 'USER_PROVIDE_INPUT',
  GET_AGENT_STATUS: 'GET_AGENT_STATUS',
  AGENT_STATUS_UPDATE: 'AGENT_STATUS_UPDATE',
  PRIVACY_EVENT: 'PRIVACY_EVENT',
  UPDATE_VAULT: 'UPDATE_VAULT',
  GET_VAULT: 'GET_VAULT',
  CONFIRM_VAULT_REVIEW: 'CONFIRM_VAULT_REVIEW',
  // Named vault documents (Aadhaar, PAN, passport …). `data` is base64 because
  // runtime messages are JSON-serialized. Bytes stay within extension
  // components during storage and planning. After a HIGH-risk confirmation,
  // the background sends them to its content script to attach to the current
  // site's file input; the page can then read the file. Bytes and file labels
  // are not included in reasoning/model network payloads.
  GET_VAULT_DOCUMENTS: 'GET_VAULT_DOCUMENTS',
  STORE_VAULT_DOCUMENT: 'STORE_VAULT_DOCUMENT',
  DELETE_VAULT_DOCUMENT: 'DELETE_VAULT_DOCUMENT',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  LOCAL_VISION_ANALYZE: 'LOCAL_VISION_ANALYZE',

  // Content Script -> Background (diagnostics only, one-way)
  LOG_EVENT: 'LOG_EVENT',

  // Background <-> Content Script
  EXTRACT_DOM: 'EXTRACT_DOM',
  EXTRACT_DOM_RESPONSE: 'EXTRACT_DOM_RESPONSE',
  EXECUTE_ACTION: 'EXECUTE_ACTION',
  EXECUTE_ACTION_RESPONSE: 'EXECUTE_ACTION_RESPONSE',
  HIGHLIGHT_ELEMENT: 'HIGHLIGHT_ELEMENT',
  SHOW_VISUAL_CURSOR: 'SHOW_VISUAL_CURSOR',
  CLEAR_OVERLAYS: 'CLEAR_OVERLAYS',
  CHECK_PAGE_STABILITY: 'CHECK_PAGE_STABILITY'
});

export function createMessage(type, payload = {}) {
  return {
    type,
    payload,
    timestamp: Date.now()
  };
}
