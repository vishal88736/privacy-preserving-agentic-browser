/**
 * GPT-OSS 120B Reasoning Client
 * Connects to the server-hosted reasoning endpoint (/reason), passes
 * the sanitized unified observation, and receives the structured action plan.
 */

import { ServerDefaults, ActionType, SymbolicSecretSource, RiskLevel } from '../shared/constants.js';
import { validateReasonPayload } from '../shared/schemas.js';
import { defaultPolicyEngine } from '../privacy/policy-engine.js';
import { defaultActionParser } from './action-parser.js';

export class GPTOSSClient {
  constructor(baseUrl = ServerDefaults.BACKEND_BASE_URL) {
    this.baseUrl = baseUrl;
    this.policyEngine = defaultPolicyEngine;
    this.actionParser = defaultActionParser;
  }

  /**
   * Dispatches task reasoning request to backend
   */
  async planNextStep(task, fusedObservation, taskHistory = []) {
    const payload = {
      task,
      fused_observation: fusedObservation,
      task_history: taskHistory,
      timestamp: Date.now()
    };

    // 1. Validate payload
    validateReasonPayload(payload);

    // 2. Scan outbound data to ensure no plaintext secrets are leaking
    this.policyEngine.enforceOutboundSafety(payload);

    try {
      const response = await fetch(`${this.baseUrl}${ServerDefaults.REASON_ENDPOINT}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`Reasoning server returned status: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      if (typeof data.action === 'object') {
        return {
          thought: data.thought || 'Planning next action based on visual and DOM perception',
          action: data.action,
          isTerminal: data.is_terminal || data.action.action === 'DONE'
        };
      }
      return this.actionParser.parse(data.raw_response || JSON.stringify(data));
    } catch (err) {
      console.warn(`[GPTOSSClient] Remote reasoning call failed (${err.message}). Using local rule-based planner.`);
      return this._localPlannerFallback(task, fusedObservation, taskHistory);
    }
  }

  /**
   * Deterministic local planner fallback for offline demo / automated testing
   */
  _localPlannerFallback(task, fusedObservation, taskHistory) {
    const lowerTask = task.toLowerCase();
    const elements = fusedObservation.elements || [];

    // Check if previous action was high risk submit and succeeded
    const lastAction = taskHistory.length > 0 ? taskHistory[taskHistory.length - 1]?.action : null;
    if (lastAction?.action === ActionType.SUBMIT) {
      return {
        thought: 'Application submitted successfully. Task complete.',
        action: {
          action: ActionType.DONE,
          risk: RiskLevel.LOW,
          requires_confirmation: false
        },
        isTerminal: true
      };
    }

    // Task Type 1: Document Upload
    if (lowerTask.includes('upload') || lowerTask.includes('document')) {
      const uploadField = elements.find(el => el.dom?.type === 'file' || el.interaction?.uploadable);
      if (uploadField) {
        // Check if we already uploaded in history
        const alreadyUploaded = taskHistory.some(h => h.action?.action === ActionType.UPLOAD);
        if (!alreadyUploaded) {
          return {
            thought: `Identified document upload field "${uploadField.dom?.label || 'Upload'}". Requesting local upload of Aadhaar PDF.`,
            action: {
              action: ActionType.UPLOAD,
              target: { element_id: uploadField.id, label: uploadField.dom?.label || 'Upload Field' },
              value_source: SymbolicSecretSource.LOCAL_DOCUMENT,
              risk: RiskLevel.HIGH,
              requires_confirmation: true
            },
            isTerminal: false
          };
        }
      }
    }

    // Task Type 2: Form filling (Aadhaar, Profile, Government application)
    if (lowerTask.includes('fill') || lowerTask.includes('form') || lowerTask.includes('aadhaar') || lowerTask.includes('profile')) {
      // Find the first unfilled interactive input field
      const unfilledField = elements.find(el => {
        if (!el.dom || el.dom.tag !== 'input') return false;
        if (el.dom.type === 'submit' || el.dom.type === 'button') return false;
        // Check if we already filled this field in history
        return !taskHistory.some(h => h.action?.target?.element_id === el.id);
      });

      if (unfilledField) {
        let valueSource = unfilledField.dom.value_source || SymbolicSecretSource.LOCAL_PROFILE;
        const fieldName = (unfilledField.dom.label || unfilledField.dom.name || '').toLowerCase();
        
        if (fieldName.includes('aadhaar')) valueSource = SymbolicSecretSource.LOCAL_AADHAAR;
        else if (fieldName.includes('pan')) valueSource = SymbolicSecretSource.LOCAL_PAN;
        else if (fieldName.includes('name')) valueSource = SymbolicSecretSource.LOCAL_FULL_NAME;
        else if (fieldName.includes('dob') || fieldName.includes('birth')) valueSource = SymbolicSecretSource.LOCAL_DOB;
        else if (fieldName.includes('phone') || fieldName.includes('mobile')) valueSource = SymbolicSecretSource.LOCAL_PHONE;
        else if (fieldName.includes('email')) valueSource = SymbolicSecretSource.LOCAL_EMAIL;

        return {
          thought: `Filling field "${unfilledField.dom.label || unfilledField.id}" using local symbolic credential: ${valueSource}`,
          action: {
            action: ActionType.TYPE,
            target: { element_id: unfilledField.id, label: unfilledField.dom.label || 'Input' },
            value_source: valueSource,
            risk: unfilledField.dom.sensitive ? RiskLevel.HIGH : RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: false
        };
      }

      // If all fields filled, locate Submit button
      const submitBtn = elements.find(el => 
        (el.dom?.tag === 'button' || el.dom?.type === 'submit') &&
        /submit|apply|proceed|continue/i.test(el.dom?.label || el.visual?.description || '')
      );

      if (submitBtn) {
        return {
          thought: `All required form fields are filled. Ready to submit application.`,
          action: {
            action: ActionType.SUBMIT,
            target: { element_id: submitBtn.id, label: submitBtn.dom?.label || 'Submit Button' },
            risk: RiskLevel.HIGH,
            requires_confirmation: true
          },
          isTerminal: false
        };
      }
    }

    // Task Type 3: Flight Search
    if (lowerTask.includes('flight') || lowerTask.includes('delhi') || lowerTask.includes('pune')) {
      const originField = elements.find(el => /from|origin/i.test(el.dom?.label || el.dom?.placeholder || ''));
      const destField = elements.find(el => /to|destination/i.test(el.dom?.label || el.dom?.placeholder || ''));
      const searchBtn = elements.find(el => /search|find flights/i.test(el.dom?.label || ''));

      if (originField && !taskHistory.some(h => h.action?.target?.element_id === originField.id)) {
        return {
          thought: 'Entering flight departure city: Pune',
          action: {
            action: ActionType.TYPE,
            target: { element_id: originField.id, label: 'Origin' },
            value: 'Pune',
            risk: RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: false
        };
      }

      if (destField && !taskHistory.some(h => h.action?.target?.element_id === destField.id)) {
        return {
          thought: 'Entering flight destination city: Delhi',
          action: {
            action: ActionType.TYPE,
            target: { element_id: destField.id, label: 'Destination' },
            value: 'Delhi',
            risk: RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: false
        };
      }

      if (searchBtn && !taskHistory.some(h => h.action?.target?.element_id === searchBtn.id)) {
        return {
          thought: 'Clicking search button to compare flights',
          action: {
            action: ActionType.CLICK,
            target: { element_id: searchBtn.id, label: 'Search Flights' },
            risk: RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: false
        };
      }
    }

    // Default terminal state
    return {
      thought: 'No additional steps required or task completed.',
      action: {
        action: ActionType.DONE,
        risk: RiskLevel.LOW,
        requires_confirmation: false
      },
      isTerminal: true
    };
  }
}

export const defaultGPTOSSClient = new GPTOSSClient();
