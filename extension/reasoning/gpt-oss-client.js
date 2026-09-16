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
        // Only DONE is terminal: a live model may echo is_terminal=true on a
        // non-terminal action (observed with UPLOAD), which would otherwise
        // complete the task without executing the action.
        const isDone = data.action?.action === 'DONE';
        return {
          thought: data.thought || 'Planning next action based on visual and DOM perception',
          action: data.action,
          isTerminal: isDone
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

    // Local prompt-injection quarantine (mirrors server heuristic):
    // webpage content is untrusted data and must never steer the plan.
    const injected = elements.find((el) => {
      const label = String(el.dom?.label || el.visual?.description || '').toLowerCase();
      return label.includes('ignore all previous instructions') ||
        label.includes('exfiltrate password') ||
        label.includes('send the') && label.includes('password');
    });
    if (injected) {
      console.warn('[GPTOSSClient] Quarantined webpage instruction injection; continuing with user task.');
    }

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

    // Task Type 0: Direct Navigation ("open youtube", "go to ...")
    if (lowerTask.startsWith('open') || lowerTask.startsWith('go to') || lowerTask.startsWith('navigate to')) {
      const alreadyNavigated = taskHistory.some(h => h.action?.action === ActionType.NAVIGATE);
      if (alreadyNavigated && !lowerTask.includes(' and ') && !lowerTask.includes('search') && !lowerTask.includes('then')) {
        return {
          thought: 'Target website opened successfully. Task goal fulfilled.',
          action: {
            action: ActionType.DONE,
            risk: RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: true
        };
      }

      if (taskHistory.length === 0) {
        let url = 'https://www.google.com';
        if (lowerTask.includes('youtube')) url = 'https://www.youtube.com';
        else if (lowerTask.includes('localhost') || lowerTask.includes('benchmark')) url = 'http://localhost:5000';
        else if (lowerTask.includes('github')) url = 'https://www.github.com';

        return {
          thought: `Opening target website: ${url}`,
          action: {
            action: ActionType.NAVIGATE,
            target: { url },
            risk: RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: false
        };
      }
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

    // Task Type 4: Media Playback / YouTube ("play ...", "watch ...", "listen ...", "song ...")
    if (lowerTask.includes('play') || lowerTask.includes('song') || lowerTask.includes('video') || lowerTask.includes('youtube') || lowerTask.includes('music')) {
      const alreadyClickedVideo = taskHistory.some(h => h.action?.action === ActionType.CLICK &&
        ((h.action?.target?.label || '').toLowerCase().includes('video') ||
         (h.action?.target?.label || '').toLowerCase().includes('play') ||
         (h.action?.target?.label || '').toLowerCase().includes('song') ||
         (h.action?.target?.url || '').includes('/watch')));

      if (alreadyClickedVideo) {
        return {
          thought: 'Selected video is playing. Task goal fulfilled.',
          action: {
            action: ActionType.DONE,
            risk: RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: true
        };
      }

      // Check if video link is present on page
      const videoLink = elements.find(el => (el.dom?.href && el.dom.href.includes('/watch')) ||
        (el.dom?.id && el.dom.id.includes('video-title')) ||
        /video|song|watch/i.test(el.dom?.label || ''));

      if (videoLink) {
        const vLabel = videoLink.dom?.label || 'Play Video';
        return {
          thought: `Found video result "${vLabel}". Playing video.`,
          action: {
            action: ActionType.CLICK,
            target: { element_id: videoLink.id, label: vLabel },
            risk: RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: false
        };
      }

      const searchInput = elements.find(el => el.dom?.tag === 'input' && (/search|find/i.test(el.dom?.placeholder || '') || el.dom?.name === 'search_query' || el.dom?.id === 'search'));
      const searchBtn = elements.find(el => /search/i.test(el.dom?.label || '') || el.dom?.id === 'search-icon-legacy');

      let cleanQuery = lowerTask;
      for (const w of ['play', 'watch', 'listen to', 'search for', 'on youtube', 'song of', 'song by']) {
        cleanQuery = cleanQuery.replace(w, '');
      }
      cleanQuery = cleanQuery.trim() || 'karan aujla popular song';

      const typedSearch = taskHistory.some(h => h.action?.action === ActionType.TYPE && h.action?.target?.element_id === searchInput?.id);

      if (searchInput && !typedSearch) {
        return {
          thought: `Entering search query "${cleanQuery}" into search field.`,
          action: {
            action: ActionType.TYPE,
            target: { element_id: searchInput.id, label: 'Search' },
            value: cleanQuery,
            risk: RiskLevel.LOW,
            requires_confirmation: false
          },
          isTerminal: false
        };
      }

      if (searchBtn && typedSearch && !taskHistory.some(h => h.action?.target?.element_id === searchBtn.id)) {
        return {
          thought: 'Submitting search query to display video results.',
          action: {
            action: ActionType.CLICK,
            target: { element_id: searchBtn.id, label: 'Search' },
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
