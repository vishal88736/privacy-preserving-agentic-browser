/**
 * Agent Controller
 * Orchestrates the autonomous iterative agent loop:
 * OBSERVE -> SANITIZE -> VISUAL_ANALYSIS -> REASON -> SAFETY_GATE -> ACT -> VERIFY
 *
 * Reliability: bounded retries, per-step error isolation, verification,
 * overlay cleanup, settings-aware execution. Privacy boundary preserved:
 * only sanitized DOM + redacted screenshots leave the device.
 *
 * L1: Post-navigation DOM re-stabilization
 * L2: Improved stuck-loop detection with sliding window
 * L5: Post-action stability wait before next observation
 * L6: Reset consecutiveFailures on subgoal advance
 * L12: Injection quarantine now scans context text and visible_text
 */

import { AgentState, ActionType, RiskLevel } from '../shared/constants.js';
import { MessageType } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';
import { taskManager } from './task-manager.js';
import { defaultDOMSanitizer } from '../privacy/dom-sanitizer.js';
import { defaultPolicyEngine } from '../privacy/policy-engine.js';
import { defaultLocalVault } from '../privacy/local-vault.js';
import { sanitizeTelemetry } from '../privacy/telemetry-sanitizer.js';
import { defaultScreenshotSanitizer } from '../privacy/screenshot-sanitizer.js';
import { defaultScreenshotService } from '../perception/screenshot.js';
import { defaultVLMClient } from '../perception/vlm-client.js';
import { defaultObservationFusion } from '../perception/observation-fusion.js';
import { defaultGPTOSSClient } from '../reasoning/gpt-oss-client.js';
import { defaultRiskGate } from '../executor/risk-gate.js';
import { defaultActionValidator } from '../executor/action-validator.js';
import { defaultActionExecutor } from '../executor/action-executor.js';
import { defaultLocalValueResolver } from '../executor/local-value-resolver.js';
import { AgentLoopState, AgentLoopStateMachine } from '../agent/state-machine.js';
import { actionVerificationSummary, defaultActionVerifier } from '../agent/verifier/action-verifier.js';
import { createDefaultPlannerChain } from '../reasoning/providers/planner-provider.js';
import { TaskState } from '../reasoning/task-understanding.js';
import { defaultPageStateModeler } from '../perception/page-state-modeler.js';
import {
  PageCapability,
  classifyPageCapability,
  getNavigationGoal,
  getSiteHomepage,
  validateNavigationUrl,
  urlsMatchForVerification
} from '../navigation/navigation.js';

const log = createLogger({ scope: 'AgentController', surface: 'background' });

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_IDENTICAL_ACTIONS = 3;
const MAX_VERIFICATION_NO_PROGRESS = 3;
const ACTIONS_EXPECTING_VISIBLE_CHANGE = new Set([
  ActionType.CLICK, ActionType.TYPE, ActionType.SELECT, ActionType.CHECK,
  ActionType.UNCHECK, ActionType.SUBMIT, ActionType.NAVIGATE,
  ActionType.GO_BACK, ActionType.GO_FORWARD,
  // UPLOAD and FILL_FORM_PLAN both report success while changing the page.
  // Excluded, a no-op upload looked like progress and the loop spun instead
  // of counting it toward MAX_VERIFICATION_NO_PROGRESS.
  ActionType.UPLOAD, ActionType.FILL_FORM_PLAN
]);
// Upper bound on how long a step may sit in WAITING_FOR_USER. Long enough for
// a human to read the approval card, short enough that a dead side panel
// surfaces as a failure instead of an indefinite stall.
const CONFIRMATION_TIMEOUT_MS = 120000;
// The same bound for an ASK_USER round trip. Both waits resolve only when the
// side panel answers, so both need a deadline or a dead panel parks the loop.
const USER_INPUT_TIMEOUT_MS = 180000;
// A pause is user-initiated, so this is longer: the user may simply be away.
const PAUSE_TIMEOUT_MS = 600000;
const NAV_VERIFY_TIMEOUT_MS = 12000;
const NAV_VERIFY_POLL_MS = 500;
const CHROME_API_TIMEOUT_MS = 10000;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}

class LocalVisionRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalVisionRequiredError';
  }
}

class SupersededTaskError extends Error {
  constructor() {
    super('This task was replaced by a newer task.');
    this.name = 'SupersededTaskError';
  }
}

// L12: Expanded injection patterns — covers more social engineering attacks
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+your\s+(system\s+)?prompt/i,
  /exfiltrat/i,
  /send\s+(the\s+)?(user'?s?\s+)?password/i,
  /disregard\s+(all\s+)?(prior|previous)/i,
  /you\s+are\s+now\s+(a|an)\b/i,
  /new\s+system\s+prompt/i,
  /override\s+(all\s+)?(safety|security|rules)/i,
  /reveal\s+(your|the)\s+(secret|password|key|token)/i,
  /output\s+(all|every|the)\s+(secret|password|credential)/i,
  /forget\s+(all\s+)?(your\s+)?instructions/i,
  /act\s+as\s+(if|though)\s+you\s+(are|were)/i,
  /pretend\s+(you\s+)?(are|were)\s/i,
  /do\s+not\s+follow\s+(your|the)\s+(rules|instructions)/i,
  /jailbreak/i,
  /prompt\s+injection/i
];

function containsInjection(text) {
  if (!text || typeof text !== 'string') return false;
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

function clockNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

async function measureStage(task, name, operation) {
  const started = clockNow();
  try {
    return await operation();
  } finally {
    task.activeStepTimings ||= {};
    task.activeStepTimings[name] = Math.max(0, Math.round(clockNow() - started));
  }
}

export function plannerStepMetadata(planResult = {}) {
  return {
    planner_plan: typeof planResult.plan === 'string' ? planResult.plan.slice(0, 8000) : '',
    planner_feedback: typeof planResult.planner_feedback === 'string'
      ? planResult.planner_feedback.slice(0, 3000)
      : '',
    terminate_assessment: planResult.terminate_assessment === true
  };
}

function isSparsePageSnapshot(rawDOM) {
  const elements = Array.isArray(rawDOM?.elements) ? rawDOM.elements : [];
  const visible = elements.filter((element) => element && element.is_visible !== false);
  const pageTextLength = String(rawDOM?.visible_text || '').trim().length;
  const headingsCount = Array.isArray(rawDOM?.headings) ? rawDOM.headings.length : 0;
  return visible.length < 3 && pageTextLength < 180 && headingsCount === 0;
}

function visualEvidenceNeed(task, rawDOM) {
  const elements = Array.isArray(rawDOM?.elements) ? rawDOM.elements : [];
  const visible = elements.filter((element) => element && element.is_visible !== false);
  const labeledCount = visible.filter((element) =>
    [element.label, element.ariaLabel, element.accessible_name, element.name, element.placeholder, element.title, element.text]
      .some((value) => typeof value === 'string' && value.trim())
  ).length;
  const prompt = String(task?.prompt || '');
  const explicitVisualRequest = /\b(visual(?:ly)?|image|picture|photo|color|colour|logo|icon|chart|graph|diagram|screenshot|appearance)\b/i.test(prompt) ||
    /\b(?:on|to|at|the)\s+(?:far\s+)?(?:left|right|above|below)\b|\b(?:left|right)\s+of\b|\b(?:above|below)\s+(?:the|a|an|it|that)\b/i.test(prompt);
  const sparseDOM = isSparsePageSnapshot(rawDOM);
  const poorlyLabeledDOM = visible.length >= 4 && labeledCount / visible.length < 0.45;
  return {
    needed: Boolean(rawDOM?.opaqueVisualSurface) || explicitVisualRequest || sparseDOM || poorlyLabeledDOM,
    visualQuery: explicitVisualRequest ? String(task?.prompt || '').slice(0, 500) : null
  };
}

export function latestConfirmationReview(steps) {
  const latest = Array.isArray(steps) && steps.length ? steps[steps.length - 1] : null;
  if (latest?.action?.action !== ActionType.EXTRACT || latest.success !== true ||
      typeof latest.result?.extractedText !== 'string') return '';
  return defaultDOMSanitizer.sanitizeUserPrompt(latest.result.extractedText).slice(0, 3500);
}

// Normalized intent across the local seed (lowercase, e.g. 'search_and_select',
// 'fill_form') and the backend interpreter (UPPERCASE, e.g. 'PLAY', 'FILL_FORM').
function normalizedIntent(task) {
  const raw = String(task?.taskState?.intent || task?.taskIntent || '').toLowerCase();
  if (!raw || raw === 'unknown' || raw === 'act') return '';
  if (raw === 'search_and_select') return 'SEARCH';
  return raw.toUpperCase();
}

function taskRequires(task, verb) {
  const required = task?.taskState?.required_actions || [];
  if (Array.isArray(required) && required.map((a) => String(a).toUpperCase()).includes(verb)) return true;
  return false;
}

function promptAsksPlay(task) {
  return /\b(play|watch|stream)\b/i.test(String(task?.prompt || ''));
}

function explicitlyRequestsYouTubeShorts(task) {
  const prompt = String(task?.prompt || task?.taskState?.original_query || '');
  return /\b(?:youtube\s+)?shorts\b|\byoutube\s+short\b|\bshort[- ]form\s+(?:video|content)\b/i.test(prompt);
}

function isYouTubeUrl(value) {
  try {
    return /(^|\.)youtube\.com$/i.test(new URL(String(value)).hostname);
  } catch {
    return /youtube\.com/i.test(String(value || ''));
  }
}

function isYouTubeShortsUrl(value) {
  try {
    const url = new URL(String(value));
    return isYouTubeUrl(url.href) && /^\/shorts(?:\/|$)/i.test(url.pathname);
  } catch {
    return /youtube\.com\/shorts(?:\/|[?#]|$)/i.test(String(value || ''));
  }
}

function isFullLengthYouTubeVideoUrl(value) {
  try {
    const url = new URL(String(value));
    return isYouTubeUrl(url.href) && /^\/watch\/?$/i.test(url.pathname) && url.searchParams.has('v');
  } catch {
    return /youtube\.com\/watch(?:\?|$)/i.test(String(value || ''));
  }
}

function wantsFullLengthYouTubeVideo(task, observation) {
  const intent = normalizedIntent(task);
  const wantsMedia = intent === 'PLAY' || taskRequires(task, 'PLAY') ||
    (!intent && promptAsksPlay(task));
  if (!wantsMedia || explicitlyRequestsYouTubeShorts(task)) return false;
  const pageUrl = observation?.page?.url || task?.pageState?.url || '';
  return isYouTubeUrl(pageUrl) || /\byoutube\b/i.test(String(task?.prompt || ''));
}

/**
 * Media fast-path: no approval card before a play click.
 *
 * Playing a video is reversible (pause/close) and fully visible, so when the
 * user explicitly asked to play something and the local safety gate itself
 * rates the click LOW, the planner's advisory requires_confirmation ("if
 * unsure, ask") is dropped. The gate stays binding: anything it rates HIGH /
 * CRITICAL or flags requiresConfirmation (a "buy now"-titled video, a form
 * submit, an upload) still asks exactly as before.
 */
export function isConfidentMediaPlay(task, action, riskAssessment, fusedTarget) {
  if (!action || action.action !== ActionType.CLICK) return false;
  if (!riskAssessment || riskAssessment.requiresConfirmation) return false;
  if (riskAssessment.risk !== RiskLevel.LOW) return false;
  if (!fusedTarget) return false;
  const intent = String(task?.taskState?.intent || '').toLowerCase();
  if (intent === 'play') return true;
  return promptAsksPlay(task);
}

function actionTargetIds(action) {
  if (Array.isArray(action?.targetIds)) return action.targetIds.filter((id) => typeof id === 'string');
  if (Array.isArray(action?.value?.fields)) {
    return action.value.fields.map((field) => field?.field_id).filter((id) => typeof id === 'string');
  }
  const elementId = action?.target?.element_id || action?.targetId;
  return typeof elementId === 'string' ? [elementId] : [];
}

function observationElement(observation, elementId) {
  return (observation?.elements || []).find((element) => element?.id === elementId) || null;
}

/**
 * Map an observed element's tag/type onto the executor's control-type
 * vocabulary. The planner's `ambiguousFields` metadata is optional, so a user
 * answer defaulted to TEXT and was then rejected by the executor's own
 * control-type check ("expected TEXT, found DATE") — which silently discarded
 * the user's date on any native date input. Deriving the type from the
 * element the observation actually saw keeps the answer applicable.
 * Returns null when the element is unknown.
 */
export function observedControlType(tag, type, role = '', isContentEditable = false) {
  const t = String(tag || '').toLowerCase();
  const ty = String(type || '').toLowerCase();
  const r = String(role || '').toLowerCase();
  if (!t && !ty && !r && !isContentEditable) return null;
  if (t === 'select') return 'SELECT';
  if (ty === 'checkbox' || r === 'checkbox') return 'CHECKBOX';
  if (ty === 'radio' || r === 'radio') return 'RADIO';
  if (t === 'textarea' || isContentEditable || r === 'textbox') return 'TEXTAREA';
  if (ty === 'email') return 'EMAIL';
  if (ty === 'tel') return 'PHONE';
  if (ty === 'number') return 'NUMBER';
  if (['date', 'datetime-local', 'month', 'week'].includes(ty)) return 'DATE';
  if (['time'].includes(ty)) return 'TEXT';
  if (t === 'input' || t === 'textarea' || t === 'select') return 'TEXT';
  return null;
}

function clarificationFieldMetadata(fields, observation) {
  return (Array.isArray(fields) ? fields : []).map((field) => {
    const observed = (observation?.elements || []).find((element) =>
      (element?.id || element?.element_id || element?.el_id) === field?.field_id
    );
    const dom = observed?.dom || observed || {};
    const tag = dom.tag || dom.element_type || '';
    const type = dom.type || dom.input_type || '';
    const metadata = {
      field_id: field.field_id,
      label: String(dom.label || observed?.label || field.field_id || 'Protected field').slice(0, 120),
      semantic_type: field.semantic_type || dom.semantic_type || 'SENSITIVE',
      input_type: String(type || 'text').slice(0, 40),
      element_type: String(tag || 'input').slice(0, 40),
      placeholder: String(dom.placeholder || '').slice(0, 120),
      control_type: field.control_type || observedControlType(tag, type, dom.role, dom.is_contenteditable === true) || 'TEXT'
    };
    if (Array.isArray(dom.options)) metadata.options = dom.options.slice(0, 40);
    return metadata;
  });
}

function formGroupForAction(action, observation) {
  const groups = new Set();
  for (const elementId of actionTargetIds(action)) {
    const element = observationElement(observation, elementId);
    const groupId = element?.form_group_id || element?.dom?.form_id || null;
    if (groupId) groups.add(groupId);
  }
  return groups.size === 1 ? [...groups][0] : null;
}

function formForGroup(observation, groupId) {
  if (!groupId) return null;
  return (observation?.form_state?.forms || []).find((form) => form?.form_group_id === groupId) || null;
}

function normalizedFieldPhrase(text) {
  return String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function fieldLabelInObservation(observation, fieldId) {
  const element = observationElement(observation, fieldId);
  return String(
    element?.dom?.label || element?.dom?.ariaLabel || element?.dom?.accessible_name ||
    element?.dom?.placeholder || element?.label || element?.accessible_name || ''
  ).replace(/\s+/g, ' ').trim();
}

function fieldExplicitlyRequested(task, label) {
  const wanted = normalizedFieldPhrase(label);
  const prompt = normalizedFieldPhrase(task?.prompt);
  if (wanted.length < 3 || !prompt) return false;
  return (` ${prompt} `).includes(` ${wanted} `);
}

/** Select one relevant form instead of treating every form on the page as the task target. */
function targetFormForCompletion(task, observation, verificationContext = null) {
  const touched = formTouchedByVerifiedStep(task, observation, verificationContext);
  if (touched?.form) return touched.form;
  const forms = observation?.form_state?.forms || [];
  if (forms.length === 1) return forms[0];

  // A previous grounded form action or saved user answers identify the form
  // even when the last action was a WAIT/SCROLL or the executor reported a
  // field-level failure.
  for (const step of [...(task?.steps || [])].reverse()) {
    const action = step?.action || {};
    if (!isFormMutationAction(action.action) && !Array.isArray(step?.result?.resolvedFieldIds)) continue;
    const ids = [...new Set([
      ...actionTargetIds(action),
      ...(Array.isArray(step?.result?.resolvedFieldIds) ? step.result.resolvedFieldIds : [])
    ])];
    const groups = new Set(ids.map((id) => {
      const element = observationElement(observation, id);
      return element?.form_group_id || element?.dom?.form_id || null;
    }).filter(Boolean));
    if (groups.size === 1) return formForGroup(observation, [...groups][0]);
  }

  // If the prompt names fields, use them to distinguish between multiple
  // independent forms. Ambiguous pages fall back to planner judgment rather
  // than letting unrelated required fields block or complete the task.
  const requestedGroups = new Set();
  for (const form of forms) {
    if ((form.fields || []).some((field) => fieldExplicitlyRequested(task, fieldLabelInObservation(observation, field.id)))) {
      requestedGroups.add(form.form_group_id);
    }
  }
  return requestedGroups.size === 1
    ? forms.find((form) => form.form_group_id === [...requestedGroups][0]) || null
    : null;
}

function verifiedStep(task, observation, verificationContext) {
  const verification = verificationContext?.verification;
  if (verification?.verified !== true ||
      verification.observation_id !== observation?.observation_id ||
      verificationContext?.execution?.success !== true) return null;
  const step = (task?.steps || []).find((candidate) =>
    candidate?.stepNumber === verificationContext.stepNumber
  );
  if (!step || step.success !== true) return null;
  return { step, verification, beforeObservation: verificationContext.beforeObservation };
}

function isFormMutationAction(action) {
  return [ActionType.TYPE, ActionType.SELECT, ActionType.CHECK, ActionType.UNCHECK, ActionType.FILL_FORM_PLAN]
    .includes(String(action || '').toUpperCase());
}

function taskExplicitlyAvoidsSubmission(prompt) {
  return /\b(?:do\s+not|don't|never|without)\s+(?:ever\s+)?(?:submit|send|apply|post)\b/i.test(String(prompt || ''));
}

function formTouchedByVerifiedStep(task, observation, verificationContext) {
  const verified = verifiedStep(task, observation, verificationContext);
  if (!verified || verified.verification.visible_state_changed !== true ||
      !isFormMutationAction(verified.step.action?.action)) return null;
  const groupId = formGroupForAction(verified.step.action, verified.beforeObservation);
  const form = formForGroup(observation, groupId);
  return form ? { form, groupId, verified } : null;
}

function hasPositiveSubmitConfirmation(observation, beforeObservation) {
  const confirmationPattern = /\b(?:thank you|thanks for (?:submitting|contacting)|submission (?:received|successful|complete)|submitted successfully|we (?:have )?received your|your (?:application|request|response|submission|order|booking) (?:has been )?(?:submitted|received|recorded|confirmed|placed)|response (?:has been )?recorded|order confirmed|booking confirmed|successfully (?:submitted|registered|sent)|message sent|form submitted)\b/i;
  const getEvidence = (source) => {
    const headings = Array.isArray(source?.headings) ? source.headings : [];
    return [
      source?.page?.title,
      ...headings.map((heading) => heading?.text),
      source?.visible_text
    ].filter((value) => typeof value === 'string').join(' ');
  };
  return confirmationPattern.test(getEvidence(observation)) &&
    !confirmationPattern.test(getEvidence(beforeObservation));
}

function mediaStartedSince(beforeObservation, afterObservation) {
  const beforeMedia = beforeObservation?.local_media_state?.media || [];
  const afterMedia = afterObservation?.local_media_state?.media || [];
  return afterMedia.some((media) => {
    if (!media || media.paused !== false || media.ended === true) return false;
    const previous = beforeMedia.find((item) => item?.ordinal === media.ordinal && item?.tag === media.tag);
    return !previous || previous.paused !== false || previous.ended === true;
  });
}

/**
 * Is any observed player currently playing, regardless of transitions?
 *
 * mediaStartedSince misses real playback when ordinal/tag alignment shifts
 * between observations (results-page preview slot vs watch-page player) or
 * the arrival observation already shows playing. The click + visible-change
 * + title conditions in taskGoalStatus still guard against certifying an
 * unrelated autoplay, so this only widens the transition signal, never the
 * goal on its own.
 */
export function mediaCurrentlyPlaying(observation) {
  const media = observation?.local_media_state?.media || [];
  return media.some((item) => Boolean(item) && item.paused === false && item.ended !== true);
}

function playControlWasClicked(verified) {
  const action = verified?.step?.action;
  if (String(action?.action || '').toUpperCase() !== ActionType.CLICK) return false;
  const targetId = actionTargetIds(action)[0];
  const target = observationElement(verified.beforeObservation, targetId);
  const labels = [
    target?.accessible_name,
    target?.label,
    target?.text,
    target?.title,
    target?.dom?.accessible_name,
    target?.dom?.label,
    target?.dom?.text,
    target?.dom?.title
  ].filter((value) => typeof value === 'string');
  const playControlLabel = /^\s*(?:play|resume)(?:\s+(?:(?:the\s+)?video|media|playback|button|trailer|episode))?[\s.!…]*$/i;
  // YouTube and most HTML5 players append the keyboard shortcut to the
  // accessible name ("Play (k)", "Pause (k)", "Play [k]"). The strict label
  // regex rejects the parentheses, so a click on the real Play button was
  // never recognized as a play trigger and PLAY tasks could never complete
  // from the watch page. Strip one trailing "(…)" / "[…]" hint before matching.
  const normalizePlayControlLabel = (value) => String(value || '')
    .replace(/\s*[[(].*?[\])]\s*$/, '')
    .trim();
  if (targetId && labels.some((label) => playControlLabel.test(normalizePlayControlLabel(label)))) return true;
  // Also treat clicking a video link, thumbnail, or media item on a video site as a play trigger
  const tag = String(target?.tag || target?.dom?.tag || '').toLowerCase();
  const role = String(target?.role || target?.dom?.role || '').toLowerCase();
  const idStr = String(targetId || '').toLowerCase();
  const isVideoLinkOrCard = tag === 'video' || tag === 'a' || role === 'link' ||
    idStr.includes('video') || idStr.includes('thumb') || idStr.includes('render');
  return Boolean(targetId && isVideoLinkOrCard);
}

function requestedMediaMatchesPage(task, observation) {
  const state = task?.taskState || {};
  const requested = [state.search_query, state.target?.entity]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ');
  const generic = new Set([
    'a', 'an', 'the', 'on', 'to', 'for', 'of', 'and', 'play', 'watch', 'stream', 'listen',
    'video', 'song', 'music', 'youtube', 'open', 'find', 'search', 'latest', 'official',
    'from', 'by', 'with', 'in', 'new', 'me', 'please', 'all', 'top'
  ]);
  const terms = [...new Set(requested.toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter((term) => term.length > 2 && !generic.has(term));
  if (!terms.length) return true;
  const pageIdentity = [
    observation?.page?.title,
    ...(observation?.headings || []).map((heading) => heading?.text)
  ].filter((value) => typeof value === 'string').join(' ').toLowerCase();
  return terms.some((term) => new RegExp(`\\b${term}\\b`, 'i').test(pageIdentity));
}

// General goal check across intents. Each branch needs positive page evidence,
// never the mere absence of work — without evidence we return null and let the
// planner (DONE), the user, or the existing stuck/no-progress breakers decide.
// Safety-critical flows (LOGIN, BOOK/payment, UPLOAD, DOWNLOAD) are
// intentionally model-only and never auto-completed here.
export function taskGoalStatus(task, fusedObservation, verificationContext = null) {
  if (!task || !fusedObservation) return null;
  if ([AgentState.COMPLETED, AgentState.FAILED, AgentState.CANCELLED].includes(task.state)) return null;
  const intent = normalizedIntent(task);

  // PLAY / watch / stream: require a verified click on an observed play control,
  // a playback transition after that click, and a page identity matching the
  // requested item. A pre-existing ad/background player is not enough.
  if (intent === 'PLAY' || taskRequires(task, 'PLAY') || (!intent && promptAsksPlay(task))) {
    // A YouTube Short does not satisfy a request to play a video unless the
    // user specifically asked for Shorts. Let the planner return to results
    // and choose a regular watch-page result instead of completing here.
    if (wantsFullLengthYouTubeVideo(task, fusedObservation) &&
        isYouTubeShortsUrl(fusedObservation?.page?.url)) return null;
    const verified = verifiedStep(task, fusedObservation, verificationContext);
    if (verified && playControlWasClicked(verified) &&
        verified.verification.visible_state_changed === true &&
        (mediaStartedSince(verified.beforeObservation, fusedObservation) ||
          mediaCurrentlyPlaying(fusedObservation)) &&
        requestedMediaMatchesPage(task, fusedObservation)) {
      return { satisfied: true, message: 'The requested media is now playing.' };
    }
    return null;
  }

  // NAVIGATE: current page already matches the requested destination.
  if (intent === 'NAVIGATE') {
    const remainingActions = (task?.taskState?.required_actions || [])
      .map((action) => String(action).toUpperCase())
      .filter((action) => action !== 'NAVIGATE');
    if (remainingActions.length) return null;
    try {
      const goal = getNavigationGoal(task.prompt);
      const currentUrl = fusedObservation?.page?.url || '';
      if (goal?.url && currentUrl && urlsMatchForVerification(goal.url, currentUrl)) {
        return { satisfied: true, message: `Navigated to ${currentUrl}.` };
      }
    } catch { /* fall through to planner */ }
    return null;
  }

  // FILL_FORM: fields filled (submission guarded) or submitted (submit requested).
  if (intent === 'FILL_FORM' || intent === 'LOGIN') {
    if (intent === 'LOGIN') return null; // credential flows stay model-only.
    const verified = verifiedStep(task, fusedObservation, verificationContext);
    if (String(verified?.step?.action?.action || '').toUpperCase() === ActionType.SUBMIT &&
        verified.verification.visible_state_changed === true &&
        hasPositiveSubmitConfirmation(fusedObservation, verified.beforeObservation)) {
      const groupId = formGroupForAction(verified.step.action, verified.beforeObservation);
      const beforeForm = formForGroup(verified.beforeObservation, groupId);
      if (Number(beforeForm?.completion?.filled) > 0 && Number(beforeForm?.completion?.required_empty) === 0) {
        return { satisfied: true, message: 'The page confirmed that the form was submitted.' };
      }
    }
    return null;
  }

  // EXTRACT cannot be inferred from a non-empty extraction: that may be an
  // unrelated page dump. Let the planner identify the requested fact.

  return null;
}

/**
 * Labels of required form fields that are still empty, for fill tasks.
 *
 * The planner only ever sees sanitized counts, so it can report DONE over a
 * form that is visibly unfilled. This re-derives the same fact locally from the
 * element list, and returns [] for every other task type (the count fields
 * above are only meaningful while a form is being filled).
 */
export function unmetRequiredFields(task, fusedObservation, verificationContext = null) {
  if (!task || !fusedObservation) return [];
  const intent = normalizedIntent(task);
  if (intent !== 'FILL_FORM') return [];
  const formState = fusedObservation.form_state || {};
  const targetForm = targetFormForCompletion(task, fusedObservation, verificationContext);
  // With multiple forms and no grounded target, do not scan the whole page and
  // mistake an unrelated sign-in/newsletter form for the user's requested one.
  // A `form_state` with no `forms` list is a single-form observation, so its
  // top-level `fields` are the right scope.
  const fields = targetForm?.fields || (
    formState.forms === undefined || formState.forms?.length === 1
      ? formState.fields || []
      : []
  );
  if (!fields.length) return [];
  const labels = new Map(fields.map((field) => [
    field.id,
    fieldLabelInObservation(fusedObservation, field.id).slice(0, 60)
  ]));
  return fields
    .filter((field) => field?.state === 'EMPTY' && isUnmetField(task, field, labels.get(field.id)))
    .map((field) => labels.get(field.id) || field.semantic_type || field.id)
    .slice(0, 8);
}

/**
 * Whether an empty field blocks a claimed completion.
 *
 * `required` is authoritative when the page states it, in BOTH directions: a
 * field the page marks optional is optional, and the recognised-name heuristic
 * must not override that. The heuristic exists only for the common case where
 * the page states nothing at all -- most real forms, and every page in
 * test-server/pages, declare no `required` attribute, so required_empty was
 * permanently 0, this guard never fired, and the agent would submit a
 * half-filled form and report DONE.
 */
function isUnmetField(task, field, label) {
  if (field?.state !== 'EMPTY') return false;
  if (field?.required === true) return true;
  if (field?.required === false) return false;
  return fieldExplicitlyRequested(task, label) || isRecognisedProfileField(label, field);
}

/**
 * Field labels that are unambiguously part of an identity/contact form.
 *
 * Used only to decide whether an EMPTY field blocks completion, so the list is
 * deliberately narrow: it names the fields a user asking to "fill this form"
 * always means, and nothing that could plausibly be optional.
 */
const RECOGNISED_PROFILE_FIELD = /^(?:full[\s_-]?name|first[\s_-]?name|last[\s_-]?name|surname|middle[\s_-]?name|full[\s_-]?name[\s_-]?\(.*\)|email[\s_-]?address|e[\s_-]?mail|phone[\s_-]?number|mobile[\s_-]?number|telephone|contact[\s_-]?number|date[\s_-]?of[\s_-]?birth|dob|birth[\s_-]?date|address|street[\s_-]?address|house[\s_-]?no|flat[\s_-]?no|city|town|state|district|pin[\s_-]?code|zip[\s_-]?code|postal[\s_-]?code|country|nationality|aadhaar|aadhar|uid[\s_-]?(?:ai)?|pan|passport[\s_-]?no|voter[\s_-]?id|dl[\s_-]?no|licence[\s_-]?no|gender|username|user[\s_-]?name|password|date[\s_-]?of[\s_-]?issue|expiry(?:[\s_-]?date)?)$/i;

function isRecognisedProfileField(label, field) {
  const text = String(label || '').trim();
  if (text) {
    // Strip any parenthetical qualifier the page added, e.g. "First Name (React-like)".
    const base = text.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (RECOGNISED_PROFILE_FIELD.test(base)) return true;
  }
  return RECOGNISED_PROFILE_FIELD.test(String(field?.semantic_type || '').trim());
}

export class AgentController {
  constructor({ plannerProvider = createDefaultPlannerChain(defaultGPTOSSClient) } = {}) {
    this.activeTabId = null;
    this.isPaused = false;
    this.isCancelled = false;
    this.listeners = new Set();
    this.pendingUserConfirmationResolver = null;
    this.pendingUserInputResolver = null;
    // Raw payload of the most recent approval answer (site address +
    // remember choice). Read once by the off-list navigation gate; the
    // boolean approval itself still travels through the resolver.
    this.lastConfirmationResponse = null;
    this.runToken = 0;
    this.pauseResolver = null;
    if (this._pauseExpiryTimer) { clearTimeout(this._pauseExpiryTimer); this._pauseExpiryTimer = null; }
    this.pausedFromState = null;
    this.plannerProvider = plannerProvider;
    this.loopMachines = new WeakMap();
  }

  _createLoopMachine(task) {
    const machine = new AgentLoopStateMachine((state) => {
      task.agentLoopState = state;
      taskManager.persist();
    });
    this.loopMachines.set(task, machine);
    machine.transition(AgentLoopState.OBSERVE);
    return machine;
  }

  _transitionLoop(task, machine, state) {
    if (machine && machine.state !== state && ![AgentLoopState.DONE, AgentLoopState.BLOCKED].includes(machine.state)) {
      machine.transition(state);
    }
    if (task) task.agentLoopState = machine?.state || state;
    return machine?.state || state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, data) {
    taskManager.persist();
    // UI events are another storage/display boundary. Do not expose raw model
    // thoughts, inline action values, page errors, or extracted text merely
    // because they arrived through a notification instead of task history.
    const safeData = sanitizeTelemetry(data);
    for (const listener of this.listeners) {
      try {
        listener(event, safeData);
      } catch (err) {
        log.exception('Listener notification threw', err);
      }
    }
  }

  async startTask(userPrompt, tabId) {
    // The prompt sanitizer and outbound policy both consult configured vault
    // values. Do not process or expose a task until storage decryption settles.
    await Promise.all([taskManager.ready, defaultLocalVault.ready]);
    const previousTask = taskManager.getTask();
    // Invalidate any previous loop. Disarm its pending user prompts first so
    // the superseded loop's await resolves and it exits via the token check
    // instead of hanging as a zombie promise or cancelling this new task.
    this.runToken++;
    const token = this.runToken;
    this.activeTabId = tabId;
    this.isPaused = false;
    this.isCancelled = false;
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = null;
    if (this._pauseExpiryTimer) { clearTimeout(this._pauseExpiryTimer); this._pauseExpiryTimer = null; }
    }
    this.pausedFromState = null;
    if (previousTask && ![AgentState.COMPLETED, AgentState.FAILED, AgentState.CANCELLED].includes(previousTask.state)) {
      taskManager.cancelTask(previousTask);
    }
    if (this.pendingUserConfirmationResolver) {
      const staleResolve = this.pendingUserConfirmationResolver;
      this.pendingUserConfirmationResolver = null;
      this.lastConfirmationResponse = null;
      staleResolve(false);
    }
    if (this.pendingUserInputResolver) {
      const staleResolve = this.pendingUserInputResolver;
      this.pendingUserInputResolver = null;
      staleResolve({ cancelled: true });
    }
    taskManager.clearPendingConfirmation();
    taskManager.clearPendingUserInput();

    // Apply current settings to network clients (privacy: same sanitized payloads, new host only)
    const settings = taskManager.settings || {};
    if (settings.backendUrl) {
      const base = String(settings.backendUrl).replace(/\/+$/, '');
      defaultVLMClient.baseUrl = base;
      defaultGPTOSSClient.baseUrl = base;
    }
    defaultVLMClient.authToken = String(settings.backendToken || '');
    defaultGPTOSSClient.authToken = String(settings.backendToken || '');

    // Sanitize user prompt to prevent leakage of PII entered directly in the task bar
    const sanitizedPrompt = defaultDOMSanitizer.sanitizeUserPrompt(userPrompt);

    const task = taskManager.createTask(sanitizedPrompt, tabId);
    // Tag ownership so a stale loop can tell its own task from a newer one.
    task.runToken = token;
    task.taskState = new TaskState(sanitizedPrompt);
    task.taskIntent = task.taskState.intent || null;
    if (settings.maxSteps) task.maxSteps = settings.maxSteps;
    this.notify('TASK_STARTED', task);

    taskManager.updateState(AgentState.UNDERSTANDING_TASK, 'Interpreting task goal...', task);
    this.notify('STATE_CHANGED', { state: AgentState.UNDERSTANDING_TASK });

    // Seed task state from the backend interpreter. The keyword interpreter
    // that used to do this locally is gone: intent classification is the
    // planner's job now. On a backend failure interpretTask reports an
    // unknown intent instead of guessing, and the loop below surfaces that.
    const interpretation = await defaultGPTOSSClient.interpretTask(sanitizedPrompt);
    task.taskState.updateFromModel(interpretation);
    if (interpretation.remoteCallAttempted) {
      taskManager.updatePrivacyMetrics({ serverCallsCount: 1 }, task);
    }
    log.info('TASK_INTERPRETED', { task_state: task.taskState.toPayload() });

    if (interpretation.authRejected) {
      taskManager.failTask(
        'The extension is not authenticated with the backend. Open Settings and paste the BACKEND_SHARED_SECRET value from your .env into "Backend access token", then save.',
        task
      );
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
      return;
    }

    if (interpretation.privacyBlocked) {
      taskManager.updatePrivacyMetrics({ privacyBlocks: 1 }, task);
      const blockMessage = typeof interpretation.privacyBlockMessage === 'string' &&
        interpretation.privacyBlockMessage.startsWith('Outbound policy blocked payload:')
        ? interpretation.privacyBlockMessage
        : 'Privacy protection blocked this AI request. Remove or rephrase the sensitive content, then try again.';
      taskManager.failTask(blockMessage, task);
      this.clearOverlays(task.tabId);
      this.notify('PRIVACY_UPDATED', task.privacyMetrics);
      this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
      return;
    }

    taskManager.updateState(AgentState.UNDERSTANDING_TASK, `Goal: ${task.taskState.goal}`, task);
    this.notify('STATE_CHANGED', { state: AgentState.UNDERSTANDING_TASK, goal: task.taskState.goal });

    this.runLoop(token).catch(err => {
      if (err?.name === 'SupersededTaskError' || taskManager.getTask() !== task) return;
      log.exception('Agent loop encountered an unhandled error', err);
      taskManager.failTask(err?.message || 'Unexpected agent error', task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: taskManager.getTask()?.error, hint: taskManager.getTask()?.hint });
    });
  }

  _assertTaskOwner(task, token) {
    if (token !== this.runToken || taskManager.getTask() !== task || task?.runToken !== token) {
      throw new SupersededTaskError();
    }
  }

  async _awaitOwned(task, token, promise) {
    const result = await promise;
    this._assertTaskOwner(task, token);
    if (this.isPaused) await this._waitWhilePaused(task, token);
    this._assertTaskOwner(task, token);
    return result;
  }

  async _waitWhilePaused(task, token) {
    while (this.isPaused) {
      // Bounded, for the same reason the confirmation and ASK_USER waits are.
      // A pause is resumed by the panel, but a closed or crashed panel leaves
      // this promise pending forever and the task never reaches a terminal
      // state. Expiring reports an honest failure instead of parking.
      const resumed = await Promise.race([
        this._awaitOwned(task, token, new Promise((resolve) => { this.pauseResolver = resolve; })),
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve('__timeout__'), PAUSE_TIMEOUT_MS);
          // Do not let the timer itself pin the MV3 worker for the full window.
          this._pauseExpiryTimer = timer;
        })
      ]);
      this._pauseExpiryTimer = null;
      if (resumed === '__timeout__') {
        throw new Error('The task stayed paused with no response from the side panel.');
      }
      this._assertTaskOwner(task, token);
    }
  }

  async _analyzeScreenshotLocally(screenshot, viewport, expectedSensitiveCounts) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        callback(value);
      };
      // Keep this below Chrome's single-event five-minute ceiling and short
      // enough that a local model cannot leave a task waiting indefinitely.
      timeout = setTimeout(() => finish(reject, new LocalVisionRequiredError('Local visual analysis timed out.')), 20000);
      try {
        chrome.runtime.sendMessage({
          type: MessageType.LOCAL_VISION_ANALYZE,
          payload: { screenshot, viewport, expectedSensitiveCounts }
        }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            finish(reject, new LocalVisionRequiredError('Open the agent side panel to run local screenshot analysis.'));
          } else if (!response?.success || response.analysis?.completed !== true) {
            log.error('Local vision failed', { error: response?.error });
            finish(reject, new LocalVisionRequiredError(response?.error ? `Local vision failed: ${response.error}` : 'Local screenshot analysis did not complete.'));
          } else {
            finish(resolve, response.analysis);
          }
        });
      } catch {
        finish(reject, new LocalVisionRequiredError('The extension could not start local screenshot analysis.'));
      }
    });
  }

  async runLoop(token) {
    const task = taskManager.getTask();

    while (task.state !== AgentState.COMPLETED && task.state !== AgentState.FAILED && task.state !== AgentState.CANCELLED) {
      if (token !== this.runToken || this.isCancelled) {
        // A newer task took over (or an explicit cancel already ran). Cancel
        // the task only if this loop still owns the CURRENT task — cancelling
        // unconditionally would kill the newer task that just started.
        const current = taskManager.getTask();
        if (current && current.runToken === token && current.state !== AgentState.CANCELLED) {
          taskManager.cancelTask(current);
          this.clearOverlays(current.tabId);
          this.notify('TASK_CANCELLED', current);
        }
        break;
      }

      if (this.isPaused) {
        await this._waitWhilePaused(task, token);
        continue;
      }

      if (task.currentStep >= task.maxSteps && !task.pendingVerification) {
        taskManager.failTask('Maximum step limit reached without achieving goal', task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        break;
      }

      if ((task.consecutiveFailures || 0) >= MAX_CONSECUTIVE_FAILURES) {
        const lastError = task.steps?.length ? task.steps[task.steps.length - 1].error : 'The agent could not find the target element — the page may have changed.';
        taskManager.failTask(lastError || 'The task encountered too many consecutive errors.', task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        break;
      }

      // L2: Improved stuck-loop detection
      // A successful browser dispatch always earns one fresh observation and
      // verification before loop-level repetition checks can stop the task.
      //
      // The step's own verification record is the signal for that, NOT
      // `pendingVerification`. Every successful dispatch sets a fresh
      // pendingVerification, so at the top of the next iteration it is always
      // present and `!task.pendingVerification` was never true again after the
      // first step — the repetition check below was unreachable. That is how a
      // single document upload repeated twelve times in a row on an unchanged
      // page instead of being stopped after three.
      const lastStep = (task.steps || [])[task.steps.length - 1];
      // `post_action_verification` is attached to a step during the observation
      // of the NEXT iteration, so at the top of iteration K the last step is
      // K-1 and is not yet verified. Gating on it therefore made this branch
      // unreachable on every iteration -- the only live breakers were
      // MAX_CONSECUTIVE_FAILURES and the no-progress counter, and a repeating
      // SUCCESSFUL action was never stopped. Break on repetition directly; the
      // success requirement keeps a legitimately retried failing action alive
      // for MAX_CONSECUTIVE_FAILURES to handle with a better message.
      const repeatedSuccessfulStep = (task.steps || []).length >= MAX_IDENTICAL_ACTIONS
        && (task.steps || []).slice(-MAX_IDENTICAL_ACTIONS).every((step) => step.success === true);
      if ((repeatedSuccessfulStep || lastStep?.diagnostic?.post_action_verification) && this._isStuckInLoop(task)) {
        log.warn('REPLAN: no progress detected; the agent is stuck in a loop.');
        taskManager.failTask('The agent repeated the same step without making progress.', task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        break;
      }

      try {
        const shouldContinue = await this._awaitOwned(task, token, this.runSingleStep(task, token));
        if (!shouldContinue) break;
      } catch (stepErr) {
        if (stepErr?.name === 'SupersededTaskError' || token !== this.runToken || taskManager.getTask() !== task) break;
        // Deterministic privacy failure: retrying cannot help (same redacted
        // input would be blocked again). Fail fast with a user-safe message.
        if (stepErr && stepErr.name === 'OutboundPolicyViolationError') {
          this._transitionLoop(task, this.loopMachines.get(task), AgentLoopState.BLOCKED);
          log.error('Outbound privacy block; aborting the task.', { violation: stepErr.message });
          taskManager.failTask(stepErr.message, task);
          this.clearOverlays(task.tabId);
          this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
          break;
        }
        if (stepErr && stepErr.name === 'LocalVisionRequiredError') {
          this._transitionLoop(task, this.loopMachines.get(task), AgentLoopState.BLOCKED);
          taskManager.failTask('Local screenshot analysis is unavailable. No screenshot was sent to the server.', task);
          this.clearOverlays(task.tabId);
          this.notify('TASK_FAILED', { error: task.error, hint: stepErr.message });
          break;
        }
        // Fail fast on restricted URLs and the extension's own panel tab
        if (stepErr?.message?.includes('Chrome does not permit extensions on internal') ||
            stepErr?.message?.includes('browser internal page') ||
            stepErr?.message?.includes('cannot run inside its own panel tab')) {
          this._transitionLoop(task, this.loopMachines.get(task), AgentLoopState.BLOCKED);
          taskManager.failTask(stepErr.message, task);
          this.clearOverlays(task.tabId);
          this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
          break;
        }
        this._transitionLoop(task, this.loopMachines.get(task), AgentLoopState.REPLAN);
        log.exception('Step failed; recovering by re-observing', stepErr);
        await this._awaitOwned(task, token, measureStage(task, 'step_error_recovery_wait_ms', () => this.sleep(700)));
        taskManager.recordStep({
          thought: `Step encountered a problem (${stepErr?.message || 'Unknown error'}); re-analyzing the page.`,
          action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
          success: false,
          error: String(stepErr?.message || stepErr).slice(0, 200)
        }, task);
        this.notify('STEP_FAILED', {
          stepNumber: task.currentStep,
          thought: `Step encountered a problem (${stepErr?.message || 'Unknown error'}); re-analyzing the page.`,
          action: { action: ActionType.WAIT },
          success: false
        });
      }
    }
  }

  /**
   * Runs one OBSERVE→VERIFY cycle. Returns false when the loop should stop.
   * `token` is the owning loop's run token; a mismatch after an await means a
   * newer task took over and this step must not act on (or cancel) it.
   */
  async runSingleStep(task, token = this.runToken) {
    if (task.runToken == null) task.runToken = token;
    this._assertTaskOwner(task, token);
    task.activeStepStartedAt = clockNow();
    task.activeStepTimings = {};
    // Check current tab URL and classify what this page allows.
    let currentTab = null;
    try {
      currentTab = await this._awaitOwned(task, token, measureStage(task, 'tab_lookup_ms', () =>
        withTimeout(chrome.tabs.get(task.tabId), CHROME_API_TIMEOUT_MS, 'The browser tab did not respond in time.')));
    } catch (e) {
      if (e?.name === 'SupersededTaskError') throw e;
      log.exception('Could not get tab info; continuing without it', e);
    }
    this._assertTaskOwner(task, token);

    const currentUrl = currentTab?.url || '';
    const capability = classifyPageCapability(currentUrl);
    // The task state is seeded from /interpret at startup, so an intent is
    // always present on the live path. Unknown means the planner will decide.
    const taskIntent = task.taskState?.intent || 'unknown';
    log.info('TASK', { intent: taskIntent });
    try {
      log.info('PAGE', { capability, url: defaultDOMSanitizer.sanitizeUrl(currentUrl) || capability });
    } catch {
      log.info('PAGE', { capability });
    }

    // Capability-aware bootstrap BEFORE any DOM observation: pure NAVIGATE
    // tasks never need content-script extraction (internal pages have none),
    // and compound tasks from internal pages navigate to the site first.
    // Never navigates the extension's own panel tab away.
    const bootstrap = await this._awaitOwned(task, token, this._maybeHandleNavigationBootstrap(task, currentTab, capability, token));
    if (bootstrap?.handled) return bootstrap.shouldContinue;

    if (capability !== PageCapability.AUTOMATABLE_WEB) {
      // Never inject content scripts into browser/extension internals.
      if (capability === PageCapability.EXTENSION_INTERNAL) {
        throw new Error('The agent cannot run inside its own panel tab. Please click on the webpage first, then start the task.');
      }
      throw new Error(`This page cannot be automated (browser internal page: ${capability}). Open a website first, then start the task again.`);
    }

    const loop = this._createLoopMachine(task);

    // L1/L5: Wait for page to stabilize before observing (handles SPA transitions, AJAX)
    await this._awaitOwned(task, token, measureStage(task, 'stability_wait_ms', () => this._waitForPageStability(task.tabId)));

    // STEP 1: OBSERVE
    taskManager.updateState(AgentState.OBSERVING, 'Reading page structure and layout…', task);
    this.notify('STATE_CHANGED', { state: AgentState.OBSERVING, step: task.currentStep + 1 });

    const observationStarted = clockNow();
    const domResponse = await this._awaitOwned(task, token, measureStage(task, 'dom_capture_ms', () => this._extractDOM(task.tabId)));

    if (!domResponse?.success) {
      throw new Error(`Failed to observe tab: ${domResponse?.error || 'Target page not responding'}. If on a new tab, navigate to a website first.`);
    }

    let rawDOM = domResponse.data;
    // A nearly-empty interactive surface usually means the page is mid-SPA
    // transition (blank frame between routes). Wait and re-extract up to a few
    // times, keeping the fullest snapshot, before planning against a stale or
    // empty view. Planning against a single blank frame makes the planner
    // emit NAVIGATE for a page that is already loading; each NAVIGATE reloads
    // the tab, so the next observation is blank again and the task can never
    // progress past navigation (seen on YouTube).
    if (isSparsePageSnapshot(rawDOM)) {
      for (let attempt = 0; attempt < 6 && isSparsePageSnapshot(rawDOM); attempt++) {
        await this._awaitOwned(task, token, measureStage(task, 'dom_retry_wait_ms', () => this.sleep(600)));
        const reextract = await this._awaitOwned(task, token, measureStage(task, 'dom_retry_ms', () => this._extractDOM(task.tabId)));
        if (reextract?.success && Array.isArray(reextract.data?.elements) &&
            reextract.data.elements.length > (rawDOM.elements || []).length) {
          rawDOM = reextract.data;
        }
      }
    }
    // The tab URL from chrome.tabs is authoritative for which page this is. A
    // mid-load extraction can report about:blank with no elements for a tab
    // that is really still loading its site; planning against the blank URL
    // reads as "nowhere yet" and triggers another NAVIGATE (and another
    // reload). Backfill the known tab URL so the planner sees a loading
    // YouTube page and waits instead of re-navigating.
    if ((!rawDOM.url || rawDOM.url === 'about:blank') && currentUrl &&
        !/^(about|chrome|edge|moz-extension|chrome-extension):/i.test(currentUrl)) {
      rawDOM = { ...rawDOM, url: currentUrl };
    }
    const expectedSensitiveCounts = defaultDOMSanitizer.getUnlocatedSensitiveCounts(rawDOM);
    const visualNeed = visualEvidenceNeed(task, rawDOM);
    let screenshotResponse = { dataUrl: null, captured: false, skipped: true };
    if (visualNeed.needed) {
      screenshotResponse = await this._awaitOwned(task, token, measureStage(task, 'screenshot_capture_ms', async () => {
        try {
          const tab = await withTimeout(chrome.tabs.get(task.tabId), CHROME_API_TIMEOUT_MS, 'The browser tab did not respond in time.');
          this._assertTaskOwner(task, token);
          return await defaultScreenshotService.captureTab(tab?.windowId ?? null, task.tabId);
        } catch (error) {
          if (error?.name === 'SupersededTaskError') throw error;
          return defaultScreenshotService.captureTab(null, task.tabId);
        }
      }));
      if (screenshotResponse?.captured === false || !screenshotResponse?.dataUrl) {
        log.warn('Screenshot capture failed; continuing from the sanitized DOM only.');
      }
    }
    task.activeStepTimings.observation_ms = Math.max(0, Math.round(clockNow() - observationStarted));
    // Screenshots stay local and are captured only when the live DOM is
    // insufficient, an opaque visual surface exists, or the task asks for
    // visual evidence.
    const screenshotAvailable = Boolean(screenshotResponse?.dataUrl) && screenshotResponse?.captured !== false;

    // Screenshot pixels are sent only to the extension side panel for local
    // object detection and OCR. If capture or analysis is unavailable, remote
    // visual inference stays off and the task continues from sanitized DOM.
    let localVision = null;
    if (screenshotAvailable) {
      try {
        localVision = await this._awaitOwned(task, token, measureStage(task, 'local_vision_ms', () =>
          this._analyzeScreenshotLocally(screenshotResponse.dataUrl, rawDOM.viewport, expectedSensitiveCounts)
        ));
      } catch (visionErr) {
        if (visionErr?.name === 'SupersededTaskError') throw visionErr;
        if (visionErr?.name !== 'LocalVisionRequiredError') throw visionErr;
        log.warn('Local visual analysis unavailable; continuing from the sanitized DOM only.');
      }
    }

    // STEP 2: LOCAL PRIVACY SANITIZATION (Client-Side Boundary)
    taskManager.updateState(AgentState.SANITIZING, 'Redacting sensitive fields locally…', task);
    this.notify('STATE_CHANGED', { state: AgentState.SANITIZING });

    const sanitizedPage = await this._awaitOwned(task, token, measureStage(task, 'dom_sanitization_ms', async () => ({
      ...defaultDOMSanitizer.sanitizeElements(rawDOM.elements),
      extras: defaultDOMSanitizer.sanitizePageExtras(rawDOM)
    })));
    const { sanitizedElements, sensitiveCount, detectedCategories } = sanitizedPage;
    const extras = sanitizedPage.extras;
    const { privacy_coverage: localPrivacyCoverage, ...remoteSafeDOM } = rawDOM;
    const screenshotPrivacyAudit = {
      // The content extractor marks coverage only if it completed its bounded
      // control scan and did not truncate the page-text audit. An elements
      // array alone is not evidence that the screenshot was fully covered.
      coverageEstablished: localPrivacyCoverage?.established === true,
      // Local OCR compares category counts with the DOM's value-free audit
      // counts. Any unmatched occurrence sets forceWithhold below.
      unlocatedSensitiveText: defaultDOMSanitizer.hasUnlocatedSensitiveText(rawDOM),
      opaqueVisualSurface: Boolean(rawDOM.opaqueVisualSurface),
      maskedCount: sensitiveCount + (localVision ? localVision.piiRegions.length + localVision.people.length : 0),
      localVisionCompleted: localVision?.completed === true,
      forceWithhold: localVision ? localVision.safeToTransmitAfterRedaction !== true : true
    };

    const sanitizedDOM = {
      ...remoteSafeDOM,
      // Keep current-page context useful while stripping query values and
      // pattern-shaped PII from URL/title fields before any server request.
      url: defaultDOMSanitizer.sanitizeUrl(rawDOM.url),
      title: defaultDOMSanitizer.sanitizeUserPrompt(rawDOM.title || ''),
      elements: sanitizedElements,
      headings: extras.headings,
      result_items: extras.result_items,
      visible_text: extras.visible_text,
      scroll: extras.scroll,
      local_media_state: extras.local_media_state,
      // This contains labels, counts, confidence and geometry only. OCR text is
      // intentionally discarded by the local engine and never reaches IPC.
      local_vision_context: localVision ? {
        model: localVision.model,
        model_revision: localVision.modelRevision,
        people_masked: localVision.people.length,
        pii_regions_masked: localVision.piiRegions.length,
        pii_categories_masked: localVision.piiCategories,
        unresolved_sensitive_categories: localVision.unlocatedSensitiveCategories,
        detected_objects: localVision.objectDetections.slice(0, 30),
        person_regions: localVision.people.map((person) => ({ bbox: person.bbox, confidence: person.confidence })),
        analysis_ms: localVision.totalMs,
        model_load_ms: localVision.modelLoadMs,
        inference_ms: localVision.inferenceMs,
        asset_bytes: localVision.assetBytes
      } : null
    };

    const localMaskElements = localVision ? [
      ...sanitizedElements.map(e => ({ ...e, method: 'dom' })),
      ...localVision.piiRegions.map((region) => ({ bbox: [region.box.x, region.box.y, region.box.width, region.box.height], sensitive: true, semantic_type: region.textCategory, method: 'ocr' })),
      ...localVision.people.map((person) => ({ bbox: person.bbox, sensitive: true, semantic_type: 'PERSON', method: 'local_vision' }))
    ] : sanitizedElements.map(e => ({ ...e, method: 'dom' }));

    // A screenshot is captured only for visual tasks or when the live DOM is
    // insufficient. It must pass local redaction before any remote VLM call.
    const redactedScreenshot = screenshotAvailable
      ? await this._awaitOwned(task, token, measureStage(task, 'screenshot_redaction_ms', () => defaultScreenshotSanitizer.redactScreenshot(
          screenshotResponse.dataUrl,
          localMaskElements,
          rawDOM.viewport,
          screenshotPrivacyAudit
      )))
      : null;
    const canUseRemoteVision = Boolean(redactedScreenshot) &&
      defaultScreenshotSanitizer.lastRedactionStatus !== 'withheld';
    // Computed once, outside the best-effort transparency block below, because
    // the side panel's "what did you send" list needs the same verdict.
    const screenshotStatus = !visualNeed.needed
      ? 'skipped'
      : redactedScreenshot
        ? (defaultScreenshotSanitizer.lastRedactionStatus || 'unknown')
        : 'unavailable';

    if (screenshotAvailable && localVision) {
      task.visionSamples ||= [];
      task.visionSamples.push({
        step: task.currentStep + 1,
        objects: localVision.objectDetections,
        pii: localVision.piiRegions.map(({ box, textCategory }) => ({ bbox: [box.x, box.y, box.width, box.height], category: textCategory })),
        redactions: localMaskElements.filter((region) => region.sensitive && Array.isArray(region.bbox)).map((region) => ({
          bbox: region.bbox,
          category: region.semantic_type || 'SENSITIVE'
        })),
        localVisionLatencyMs: localVision.totalMs,
        clientHeapBytes: localVision.heapUsedBytes,
        clientAssetBytes: localVision.assetBytes
      });
    }

    taskManager.updatePrivacyMetrics({
      sensitiveFieldsDetected: sensitiveCount,
      secretsKeptLocal: sensitiveCount,
      redactedRegionsCount: sensitiveCount + (localVision ? localVision.piiRegions.length + localVision.people.length : 0),
      localVisionLatencyMs: localVision?.totalMs || 0,
      localModelAssetBytes: localVision?.assetBytes,
      localOcrPiiRegions: localVision?.piiRegions.length || 0,
      localPeopleMasked: localVision?.people.length || 0,
      detectedCategories: [...new Set([
        ...detectedCategories,
        ...(localVision?.piiCategories || []),
        ...(localVision?.people.length ? ['PERSON'] : [])
      ])]
    }, task);
    // Transparency: record exactly what leaves the device for the "What is
    // sent to the AI" panel. Never includes vault plaintext — only counts,
    // symbolic tokens, redacted samples and the sanitized task text.
    try {
      const tokens = Array.from(new Set(
        (sanitizedElements || []).map((e) => e.value_source).filter(Boolean)
      )).slice(0, 12);
      const sampleElements = (sanitizedElements || []).slice(0, 3).map((e) => ({
        id: e.id,
        tag: e.tag,
        label: String(e.label || e.placeholder || e.name || '').slice(0, 40),
        value: e.value,
        value_source: e.value_source || null
      }));
      task.lastLLMPayload = {
        taskSent: String(task.prompt || '').slice(0, 140),
        elementsSent: (sanitizedElements || []).length,
        redactedCount: sensitiveCount,
        detectedCategories: detectedCategories || [],
        localVision: localVision ? {
          model: localVision.model,
          analysisMs: localVision.totalMs,
          modelLoadMs: localVision.modelLoadMs,
          inferenceMs: localVision.inferenceMs,
          modelAssetBytes: localVision.assetBytes,
          peopleMasked: localVision.people.length,
          ocrRegionsMasked: localVision.piiRegions.length,
          ocrCategoriesMasked: localVision.piiCategories,
          heapUsedBytes: localVision.heapUsedBytes
        } : undefined,
        tokens,
        screenshotStatus,
        screenshot: screenshotStatus === 'withheld'
          ? 'withheld (neutral placeholder)'
          : screenshotStatus === 'masked'
            ? 'masked known sensitive regions'
            : screenshotStatus === 'checked'
              ? 'processed; no known sensitive regions to mask'
              : screenshotStatus === 'skipped'
                ? 'skipped; structured DOM evidence was sufficient'
              : 'unavailable on this page; no image was sent',
        sampleElements,
        modelTrace: { vision: null, reasoning: null },
        timestamp: Date.now()
      };
    } catch { /* transparency is best-effort */ }
    this.notify('PRIVACY_UPDATED', task.privacyMetrics);

    // STEP 3: SERVER VLM PERCEPTION (sanitized data only, when visual evidence is needed)
    taskManager.updateState(AgentState.VISUAL_ANALYSIS, 'Interpreting the visual layout…', task);
    this.notify('STATE_CHANGED', { state: AgentState.VISUAL_ANALYSIS });

    const visualObservation = canUseRemoteVision
      ? await this._awaitOwned(task, token, measureStage(task, 'vlm_request_ms', () => defaultVLMClient.processVisuals(
          task.id,
          redactedScreenshot,
          sanitizedDOM,
          {
            viewport: rawDOM.viewport,
            // Sanitized copy: the raw title never leaves the device.
            title: sanitizedDOM.title,
            url: defaultDOMSanitizer.sanitizeUrl(rawDOM.url),
            visual_query: visualNeed.visualQuery,
            privacy_redaction_summary: {
              dom_regions: sensitiveCount,
              ocr_regions: localVision?.piiRegions.length || 0,
              people_regions: localVision?.people.length || 0,
              screenshot_withheld: defaultScreenshotSanitizer.lastRedactionStatus === 'withheld',
              unresolved_sensitive_categories: localVision?.unlocatedSensitiveCategories || []
            },
            // Attestation for the bytes actually attached to this request. The
            // outbound policy engine blocks the image unless this record says
            // redaction covered it and local visual analysis audited it, so a
            // silent upstream redaction failure cannot reach the wire.
            redaction_audit: {
              status: defaultScreenshotSanitizer.lastRedactionStatus || 'unknown',
              coverage: screenshotPrivacyAudit.coverageEstablished ? 'complete' : 'unknown',
              withheld: defaultScreenshotSanitizer.lastRedactionStatus === 'withheld',
              local_model_completed: screenshotPrivacyAudit.localVisionCompleted === true,
              ocr_completed: localVision ? true : false,
              regions: localMaskElements.filter(r => r.sensitive && Array.isArray(r.bbox)).map(r => ({
                category: r.semantic_type || 'SENSITIVE',
                x: Number((r.bbox[0]).toFixed(3)),
                y: Number((r.bbox[1]).toFixed(3)),
                width: Number((r.bbox[2]).toFixed(3)),
                height: Number((r.bbox[3]).toFixed(3)),
                method: r.method || 'dom'
              })),
              detected_categories: [...new Set([
                ...detectedCategories,
                ...(localVision?.piiCategories || []),
                ...(localVision?.people.length ? ['PERSON'] : [])
              ])]
            }
          },
          {
            onDispatch: ({ sanitizedScreenshot }) => this.notify('VLM_SCREENSHOT_DISPATCHED', {
              task_id: task.id,
              step: task.currentStep + 1,
              sent: true,
              redaction_status: defaultScreenshotSanitizer.lastRedactionStatus,
              sanitized_screenshot: sanitizedScreenshot
            })
          }
        )))
      // No screenshot exists to send: continue from the sanitized DOM only
      // instead of failing the task.
      : defaultVLMClient.domOnlyObservation(
          sanitizedDOM,
          visualNeed.needed
            ? 'The screenshot could not be captured or passed local privacy checks; no image was sent.'
            : 'Visual inference was skipped because structured DOM evidence was sufficient.'
        );

    // Transparency for every step that did not put an image on the wire.
    //
    // The panel's list used to be populated only by the dispatch callback, so
    // it stayed empty on every step the agent handled from the DOM alone —
    // which is most of them. An empty panel reads as "nothing was ever sent"
    // or "this feature is broken", when the truth is usually that the
    // structured DOM was sufficient and no image left the device. Record the
    // outcome on every non-dispatch step so the panel always answers
    // "what did you send?" honestly.
    if (!canUseRemoteVision) {
      this.notify('VLM_SCREENSHOT_DISPATCHED', {
        task_id: task.id,
        step: task.currentStep + 1,
        sent: false,
        redaction_status: screenshotStatus === 'withheld' ? 'withheld' : (screenshotStatus || 'unknown'),
        sanitized_screenshot: null
      });
    }

    if (task.lastLLMPayload) {
      task.lastLLMPayload.modelTrace ||= { vision: null, reasoning: null };
      task.lastLLMPayload.modelTrace.vision = visualObservation?.model_trace || {
        component: 'vision', source: visualObservation?._source || 'unknown', provider: null, model: null
      };
    }

    if (visualObservation.remoteCallAttempted) {
      taskManager.updatePrivacyMetrics({ serverCallsCount: 1 }, task);
    }
    if (visualObservation?.privacyBlocked) {
      taskManager.updatePrivacyMetrics({ privacyBlocks: 1 }, task);
    }

    const objectSummary = localVision ? localVision.objectDetections.slice(0, 12).map((item) => item.label).join(', ') : '';
    const localVisionNote = localVision
      ? `Local ${localVision.model} and OCR checks completed in ${localVision.totalMs} ms; detected objects: ${objectSummary || 'none'}. Masked ${localVision.people.length} people and ${localVision.piiRegions.length} OCR-identified sensitive regions. OCR text was discarded locally.`
      : !visualNeed.needed
        ? 'Screenshot and visual inference were skipped because the structured DOM supplied usable page evidence.'
        : 'Local screenshot analysis was unavailable on this page; continuing from the sanitized DOM only. No screenshot was sent.';
    const remoteVisionNote = redactedScreenshot && !canUseRemoteVision
      ? 'Remote visual inference was skipped because local privacy checks withheld the screenshot.'
      : '';
    visualObservation.spatial_layout = [visualObservation.spatial_layout, localVisionNote, remoteVisionNote].filter(Boolean).join(' ');
    visualObservation.visual_state = [visualObservation.visual_state, localVisionNote, remoteVisionNote].filter(Boolean).join(' ');

    // STEP 4: OBSERVATION FUSION + injection quarantine
    // Named `fused` inside the callback rather than `fusedObservation`: the
    // destructured binding below is hoisted into this scope, so shadowing it
    // meant the outer one was a TDZ read for anything that reached it.
    const { fusedObservation, pageState } = await this._awaitOwned(task, token, measureStage(task, 'fusion_and_page_state_ms', async () => {
      const fused = defaultObservationFusion.fuse(
        sanitizedElements,
        visualObservation,
        {
          domain: defaultDOMSanitizer.sanitizeUrl(rawDOM.url),
          url: defaultDOMSanitizer.sanitizeUrl(rawDOM.url),
          // Sanitized copy: the raw title never leaves the device.
          title: sanitizedDOM.title,
          viewport: rawDOM.viewport,
          scroll: extras.scroll,
          headings: extras.headings,
          result_items: extras.result_items,
          visible_text: extras.visible_text,
          local_media_state: extras.local_media_state,
          local_vision_context: sanitizedDOM.local_vision_context,
          snapshot_id: rawDOM.snapshot_id,
          mutation_revision: rawDOM.mutation_revision
        }
      );
      this.quarantineInjectedElements(fused);

      if (!task.taskState) task.taskState = new TaskState(task.prompt);
      return { fusedObservation: fused, pageState: defaultPageStateModeler.modelPageState(fused, task.taskState) };
    }));

    // STEP 4.5: TASK-CONDITIONAL PAGE STATE MODELING
    const observationId = fusedObservation.observation_id;
    if (!observationId || !Number.isInteger(fusedObservation.mutation_revision)) {
      throw new Error('The page observation is missing its freshness token. Re-observation is required before planning.');
    }
    loop.bindObservation(observationId);
    task.observationContext = {
      snapshotId: observationId,
      mutationRevision: fusedObservation.mutation_revision
    };
    this._transitionLoop(task, loop, AgentLoopState.UNDERSTAND);
    task.pageState = pageState;
    this._transitionLoop(task, loop, AgentLoopState.GROUND);
    // Retained for the ASK_USER answer path, which runs a step later and must
    // gate the user's own answer against the same observation the prompt was
    // built from rather than re-deriving one.
    task.lastFusedObservation = fusedObservation;
    this._lastFusedObservation = fusedObservation;
    log.info('PAGE_OBSERVED', { page_state: pageState });

    // This is the first point after execution where a fresh DOM has been
    // fused and task-grounded. Verify the previous action against that new
    // observation before asking the planner for the next action.
    const pendingVerification = task.pendingVerification;
    let verificationContext = null;
    if (pendingVerification) {
      taskManager.updateState(AgentState.VERIFYING, 'Checking the new page state…', task);
      const verification = defaultActionVerifier.verify({
        action: pendingVerification.action,
        execution: pendingVerification.execution,
        beforeObservation: pendingVerification.beforeObservation,
        afterObservation: fusedObservation
      });
      verificationContext = {
        stepNumber: pendingVerification.stepNumber,
        execution: pendingVerification.execution,
        beforeObservation: pendingVerification.beforeObservation,
        verification
      };
      task.lastVerification = verification;
      const verifiedAction = pendingVerification.action?.action;
      if (verification.verified && !verification.visible_state_changed &&
          ACTIONS_EXPECTING_VISIBLE_CHANGE.has(verifiedAction)) {
        task.verificationNoProgress = (task.verificationNoProgress || 0) + 1;
        verification.replan_required = true;
        verification.no_progress_count = task.verificationNoProgress;
      } else if (verification.visible_state_changed) {
        task.verificationNoProgress = 0;
      }
      const previousStep = (task.steps || []).find((step) => step.stepNumber === pendingVerification.stepNumber);
      if (previousStep) {
        previousStep.diagnostic = {
          ...(previousStep.diagnostic || {}),
          post_action_verification: verification
        };
      }
      delete task.pendingVerification;
    // NOTE: a loop used to sit here that deleted `step.diagnostic` from every
    // step lacking `post_action_verification`. Every FAILED step is recorded
    // with a diagnostic containing model_trace/task_state/page_state but no
    // verification key, so it erased the forensics for exactly the steps worth
    // debugging. It also collapsed every failed step's state fingerprint to
    // "undefined::undefined::undefined::0::", which made the alternating-pattern
    // breaker fire on any fail/other/fail/other sequence. Step size is bounded
    // elsewhere (MAX_STEPS); there is no need to destroy evidence here.
    taskManager.persist();
    // No STEP_VERIFIED notify here. The side panel has no case for it and no
    // renderer for a verification summary, so emitting it only added a message
    // the panel discarded. Verification is still recorded on
    // step.diagnostic.post_action_verification and persisted with the task.
    log.debug('STEP_VERIFIED', {
      stepNumber: pendingVerification.stepNumber,
      visibleStateChanged: verification?.visible_state_changed ?? null
    });
      this._transitionLoop(task, loop, AgentLoopState.VERIFY);
      this._transitionLoop(task, loop, AgentLoopState.REPLAN);
      if ((task.verificationNoProgress || 0) >= MAX_VERIFICATION_NO_PROGRESS) {
        taskManager.failTask(
          `The page showed no visible change after ${MAX_VERIFICATION_NO_PROGRESS} verified actions. The agent stopped to avoid repeating ineffective actions.`,
          task
        );
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
        this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
        return false;
      }
    }

    // Auto-complete only from fresh, verified evidence tied to this observation.
    // The planner handles goals that need semantic judgment, such as deciding
    // whether extracted text answers the user's question.
    const goalStatus = taskGoalStatus(task, fusedObservation, verificationContext);
    if (goalStatus?.satisfied) {
      if (loop.state === AgentLoopState.GROUND) {
        this._transitionLoop(task, loop, AgentLoopState.REPLAN);
      }
      this._transitionLoop(task, loop, AgentLoopState.DONE);
      taskManager.completeTask(goalStatus.message, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_COMPLETED', { result: task.result });
      return false;
    }

    if (task.currentStep >= task.maxSteps) {
      taskManager.failTask('Maximum step limit reached without achieving goal', task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
      this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
      return false;
    }

    // STEP 5: REASONING & PLANNING
    // Storage initialization must not block task creation or the initial UI
    // The vault backs symbolic value resolution at execution time. Warm it
    // before planning: with the intent regexes gone there is no cheap way to
    // know in advance whether a task needs profile values, and awaiting the
    // ready promise costs a storage read either way.
    taskManager.updateState(AgentState.PLANNING, 'Loading local profile values…', task);
    this.notify('STATE_CHANGED', { state: AgentState.PLANNING });
    await this._awaitOwned(task, token, measureStage(task, 'local_profile_ready_ms', () => defaultLocalVault.ready));
    taskManager.updateState(AgentState.PLANNING, `Planning next action for "${task.taskState.getActiveSubgoal()}"…`, task);
    this.notify('STATE_CHANGED', { state: AgentState.PLANNING, active_subgoal: task.taskState.getActiveSubgoal() });

    // PageStateModeler has converted the sanitized observation into semantic
    // candidates and task-relevant state. The server planner consumes only
    // that sanitized representation; provider selection cannot grant action
    // authority or bypass the local validation/risk stages below.
    this._transitionLoop(task, loop, AgentLoopState.PLAN);
    const plannerClarification = typeof task.pendingPlannerClarification === 'string'
      ? task.pendingPlannerClarification
      : '';
    delete task.pendingPlannerClarification;
    const plannerTask = plannerClarification
      ? `${task.prompt}\n\nUser clarification: ${plannerClarification}`
      : task.prompt;
    const providerOutcome = await this._awaitOwned(task, token, measureStage(task, 'reasoning_request_ms', () =>
      this.plannerProvider.plan({
        task: plannerTask,
        fusedObservation,
        taskHistory: task.steps,
        taskState: task.taskState,
        pageState
      })
    ));
    const planResult = providerOutcome?.available && providerOutcome.result
      ? providerOutcome.result
      : { plannerUnavailable: true, remoteCallAttempted: false };
    if (task.lastLLMPayload) {
      task.lastLLMPayload.modelTrace ||= { vision: null, reasoning: null };
      task.lastLLMPayload.modelTrace.reasoning = planResult?.model_trace || {
        component: 'reasoning', source: planResult?.remoteCallMade === false ? 'local' : 'unknown', provider: null, model: null
      };
    }

    // L6/L7: Track previous subgoal for advancement detection
    const prevSubgoal = task.taskState.getActiveSubgoal();

    if (task.taskState && planResult.task_understanding) {
      task.taskState.updateFromModel(planResult.task_understanding);
      task.taskState.updateFromModel(planResult.current_state);
    }

    // L6: If the subgoal advanced, reset consecutive failures
    const newSubgoal = task.taskState.getActiveSubgoal();
    if (prevSubgoal !== newSubgoal) {
      log.info('SUBGOAL_ADVANCED', { from: prevSubgoal, to: newSubgoal });
      task.consecutiveFailures = 0;
    }

    if (!this._handlePlannerFailure(task, planResult)) {
      this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
      return false;
    }
    let proposedAction = planResult.action;

    // A clarification that only describes a step the agent can already take is
    // not a clarification — it is a click it declined to make. The planner
    // reaches for ASK_USER whenever candidates look "equally suitable", which
    // on a results page is almost always true, and it then asks the user to do
    // the work: "please click the first video result". That hands back to the
    // human the one thing the agent is supposed to be doing.
    //
    // Only the narrow, unambiguous shape is auto-resolved: the question asks
    // for an on-page interaction, it does not need a value the user alone has,
    // and the observation grounds a single best candidate. Everything else —
    // OTPs, CAPTCHAs, credentials, legal-ambiguity fields, unattributable
    // identity choices — still stops and asks, because those are genuinely the
    // user's to answer.
    const autoResolved = this._resolveAgentDoableClarification(proposedAction, fusedObservation, task);
    if (autoResolved) proposedAction = autoResolved;

    // PLAY tasks on YouTube default to full watch-page videos. If the planner
    // targets a Shorts URL, pick the highest-ranked observed /watch result; if
    // none is visible yet, advance the results page instead of opening Shorts.
    const fullLengthVideoAction = this._avoidYouTubeShorts(proposedAction, fusedObservation, task);
    if (fullLengthVideoAction) proposedAction = fullLengthVideoAction;

    // Same-host NAVIGATE guard: the planner emits NAVIGATE for a page that is
    // still loading (empty observation on the right host). Executing it
    // reloads the tab and resets the load, so the next observation is empty
    // again and the task loops NAVIGATE forever (seen as repeated "Open
    // youtube.com" steps). When already on the destination host, WAIT for the
    // load and re-observe instead of reloading.
    if (proposedAction?.action === ActionType.NAVIGATE) {
      const navTarget = proposedAction.target?.url || proposedAction.value;
      const currentPageUrl = rawDOM.url || currentUrl;
      if (typeof navTarget === 'string' && navTarget && currentPageUrl &&
          urlsMatchForVerification(navTarget, currentPageUrl)) {
        log.info('NAVIGATE skipped: already on destination host; waiting for the page to load.', {
          target: String(navTarget).slice(0, 120),
          current: String(currentPageUrl).slice(0, 120)
        });
        proposedAction = {
          action: ActionType.WAIT,
          duration: 2500,
          risk: RiskLevel.LOW,
          requires_confirmation: false,
          thought: `Already on ${currentPageUrl}; waiting for the page to finish loading instead of reloading it.`
        };
      }
    }

    // The Critique's stop decision is authoritative only when paired with its
    // final answer. The backend coerces a bare termination flag to false; this
    // client check keeps the contract fail-closed if a nonstandard backend
    // returns one. Critic termination and a final answer go together.
    if (this._completeFromCriticTermination(task, planResult, proposedAction)) {
      this._transitionLoop(task, loop, AgentLoopState.DONE);
      return false;
    }

    if (proposedAction?.action === ActionType.DONE) {
      // A fill task may not report success while the page still shows empty
      // required fields. The planner sees sanitized counts, so a miscount (or
      // a field it could not ground) used to produce "COMPLETED" over a
      // visibly unfilled form. Re-observe and let the planner keep working.
      const unmet = unmetRequiredFields(task, fusedObservation, verificationContext);
      // `unmet` is an array, and an empty array is truthy: testing it directly
      // blocked every completion, including tasks with no form at all.
      if (unmet.length > 0) {
        log.warn('Planner reported DONE while required form fields remain empty.', {
          unmet_required: unmet
        });
        taskManager.recordStep({
          thought: `Cannot finish yet — these required fields are still empty: ${unmet.join(', ')}. Filling them before completing.`,
          action: { action: ActionType.WAIT, risk: RiskLevel.LOW, requires_confirmation: false },
          success: false,
          error: 'Required form fields are still empty.',
          ...plannerStepMetadata(planResult)
        }, task);
        this.notify('STEP_FAILED', {
          stepNumber: task.currentStep,
          thought: `These required fields are still empty: ${unmet.join(', ')}. The agent will fill them before finishing.`,
          action: { action: ActionType.WAIT },
          success: false,
          timestamp: Date.now()
        });
        this._transitionLoop(task, loop, AgentLoopState.REPLAN);
        return true;
      }
      const finalResponse = planResult.final_response || planResult.thought;
      taskManager.completeTask(finalResponse, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_COMPLETED', { result: finalResponse });
      this._transitionLoop(task, loop, AgentLoopState.DONE);
      return false;
    }

    // STEP 6: LOCAL SAFETY GATE & RISK VALIDATION
    this._transitionLoop(task, loop, AgentLoopState.VALIDATE);
    taskManager.updateState(AgentState.VALIDATING_ACTION, 'Validating action and privacy…', task);
    this.notify('STATE_CHANGED', { state: AgentState.VALIDATING_ACTION, action: proposedAction });

    const preValidation = defaultActionValidator.validatePreExecution(proposedAction, fusedObservation, task.taskState);
    if (!preValidation.valid) {
      log.warn('Action failed pre-validation; retrying observation.', { reason: preValidation.reason });
      await this._awaitOwned(task, token, measureStage(task, 'prevalidation_recovery_wait_ms', () => this.sleep(500)));
      taskManager.recordStep({
        thought: preValidation.reason || 'Target changed; re-analyzing the page.',
        action: proposedAction,
        success: false,
        error: preValidation.reason,
        ...plannerStepMetadata(planResult)
      }, task);
      this.notify('STEP_FAILED', {
        stepNumber: task.currentStep,
        thought: preValidation.reason || 'The target element changed. Re-analyzing the page.',
        action: proposedAction,
        success: false,
        timestamp: Date.now()
      });
      this._transitionLoop(task, loop, AgentLoopState.REPLAN);
      return true;
    }

    // Resolve only the plan's availability status before confirmation. This
    // keeps an empty Local Vault from first presenting a high-risk approval
    // and then waiting forever for the user-input prompt that can only be
    // discovered after execution. The resolver returns a private clone; no
    // plaintext value is copied into the action, task history, or notification.
    if (proposedAction.action === ActionType.FILL_FORM_PLAN &&
        Array.isArray(proposedAction.value?.fields) &&
        proposedAction.value.fields.some((field) =>
          typeof field?.value_source === 'string' &&
          /^LOCAL_/.test(field.value_source) &&
          !/^LOCAL_DOCUMENT_/.test(field.value_source)
        )) {
      try {
        await this._awaitOwned(task, token, defaultLocalValueResolver.vault?.ready || Promise.resolve());
        const resolvedPlan = defaultLocalValueResolver.resolve(proposedAction);
        const unavailable = (resolvedPlan?.fields || []).filter((field) =>
          typeof field?.value_source === 'string' &&
          /^LOCAL_/.test(field.value_source) &&
          !/^LOCAL_DOCUMENT_/.test(field.value_source) &&
          field.status !== 'AVAILABLE'
        );
        if (unavailable.length) {
          proposedAction = {
            action: ActionType.ASK_USER,
            value: {
              prompt: 'Some protected profile values are not configured in the Local Vault. Enter them below; the answers stay local and are used only on this page.',
              ambiguousFields: clarificationFieldMetadata(unavailable, fusedObservation)
            },
            risk: RiskLevel.LOW,
            requires_confirmation: false
          };
        }
      } catch (preflightError) {
        // Execution still performs the authoritative local resolution. A
        // preflight failure must not turn a resolvable action into a guessed
        // value or leak the resolver error into remote/task telemetry.
        log.warn('Local value availability preflight unavailable; deferring to executor.');
      }
    }

    const fusedTarget = (fusedObservation.elements || [])
      .find((el) => el.id === proposedAction.target?.element_id) || null;
    const riskAssessment = defaultRiskGate.evaluate(proposedAction, {
      targetElement: proposedAction.target,
      targetDom: fusedTarget?.dom || null,
      observationElements: fusedObservation.elements || [],
      currentUrl: rawDOM.url,
      pageTitle: rawDOM.title
    });

    if (!riskAssessment.allowed) {
      taskManager.failTask(`Safety Gate Blocked Action: ${riskAssessment.reason}`, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
      this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
      return false;
    }

    // Settings can force confirmation for high-risk actions even if the model disagrees.
    // The media fast-path runs first: an explicit play request whose click the
    // gate rates LOW never takes an approval card, even when the planner set
    // requires_confirmation out of caution. Gate-demanded confirmations are
    // untouched (see isConfidentMediaPlay).
    const mediaFastPath = isConfidentMediaPlay(task, proposedAction, riskAssessment, fusedTarget);
    const needsConfirm = !mediaFastPath && (riskAssessment.requiresConfirmation ||
      proposedAction.requires_confirmation ||
      ((taskManager.settings?.alwaysConfirm !== false) &&
        (riskAssessment.risk === RiskLevel.HIGH || riskAssessment.risk === RiskLevel.CRITICAL)));

    if (needsConfirm) {
      // Explain WHY approval is needed: the safety gate's reason when it
      // demanded confirmation, otherwise the agent's own request.
      const confirmReason = riskAssessment.requiresConfirmation
        ? riskAssessment.reason
        : 'The agent requested your approval before this step.';
      const confirmationId = globalThis.crypto?.randomUUID?.() || `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      taskManager.setPendingConfirmation(proposedAction, confirmReason, { confirmationId, taskId: task.id }, task);
      this.notify('STATE_CHANGED', { state: AgentState.WAITING_FOR_USER });
      this.notify('CONFIRMATION_REQUIRED', {
        confirmationId,
        taskId: task.id,
        action: { ...proposedAction, risk: riskAssessment.risk },
        reason: confirmReason,
        reviewSummary: latestConfirmationReview(task.steps),
        privacySummary: {
          dataKeptLocal: proposedAction.value_source || 'No secrets disclosed',
          dataSharedWithServer: 'Sanitized task request and page context; saved profile values stay local'
        }
      });

      const confirmationWaitStarted = clockNow();
      // Bound the wait. Without this the loop parks forever when the side panel
      // is closed, crashed, or fails to render the modal: the task shows
      // WAITING_FOR_USER, no further step ever runs, and nothing is logged.
      // Expiring turns that silent hang into an explicit failure.
      const approval = await (async () => {
        // The timer must be cleared, not left armed: in MV3 a pending timer
        // holds the service worker alive, so an uncleared 120s timer would tax
        // every confirmation with up to two minutes of worker residency. The
        // codebase already clears its timers this way (vlm-client.js, and
        // action-executor's finally(clearTimeout)).
        let expiryTimer = null;
        try {
          return await Promise.race([
            this._awaitOwned(task, token, new Promise((resolve) => {
              this.pendingUserConfirmationResolver = resolve;
            })),
            new Promise((resolve) => {
              expiryTimer = setTimeout(() => resolve('__expired__'), CONFIRMATION_TIMEOUT_MS);
            })
          ]);
        } finally {
          if (expiryTimer !== null) clearTimeout(expiryTimer);
        }
      })();
      task.activeStepTimings.confirmation_wait_ms = Math.max(0, Math.round(clockNow() - confirmationWaitStarted));

      // Superseded by a newer task: the new loop owns the task state now.
      // Acting here (clearing its state or cancelling) would kill it.
      this._assertTaskOwner(task, token);

      taskManager.clearPendingConfirmation(task);

      if (approval === '__expired__') {
        // The wait is over, so a late click on a stale panel must not reach a
        // resolver whose promise has already lost the race.
        this.pendingUserConfirmationResolver = null;
        // Second argument is the OWNERSHIP token, not a hint. Passing a string
        // made _isCurrent() compare a string against the task object, fail, and
        // return without transitioning anything -- the task stayed
        // WAITING_FOR_USER forever while the UI showed a failure.
        taskManager.failTask(
          `Approval for ${String(proposedAction.action).toUpperCase()} was not received in time. Nothing was submitted or attached.`,
          task
        );
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', {
          error: 'Approval timed out — nothing was submitted or attached.',
          hint: 'Re-run the task and approve the prompt when it appears.'
        });
        this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
        return false;
      }

      if (!approval) {
        taskManager.cancelTask(task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_CANCELLED', { reason: 'User declined action confirmation' });
        this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
        return false;
      }
      taskManager.updateState(AgentState.EXECUTING, 'Approval received — continuing…', task);
    }

    // STEP 7: LOCAL EXECUTION (secrets resolved strictly locally)
    this._assertTaskOwner(task, token);
    loop.assertObservation(task.observationContext?.snapshotId);
    this._transitionLoop(task, loop, AgentLoopState.EXECUTE);
    taskManager.updateState(AgentState.EXECUTING, 'Performing the action in the page…', task);
    this.notify('STATE_CHANGED', { state: AgentState.EXECUTING, action: proposedAction });

    let execResult;
    try {
      execResult = await this._awaitOwned(task, token, measureStage(task, 'action_execution_ms', () =>
        defaultActionExecutor.execute(task.tabId, proposedAction, task.observationContext)
      ));
    } catch (execErr) {
      if (execErr?.name === 'SupersededTaskError') throw execErr;
      execResult = { success: false, error: execErr?.message || 'Execution failed' };
    }

    if (proposedAction.action === ActionType.OPEN_TAB && execResult?.success && Number.isInteger(execResult.openedTabId)) {
      // Continue the same task in the tab that was actually opened so
      // multi-step requests can inspect and act on its loaded page.
      task.tabId = execResult.openedTabId;
    }
    if (proposedAction.action === ActionType.EXTRACT && execResult?.success && typeof execResult.extractedText === 'string') {
      // Extraction can contain user data even when the normal DOM snapshot
      // would redact it. Scrub it before storing it in task history or sending
      // the result back for a grounded answer.
      execResult.extractedText = defaultDOMSanitizer.sanitizeUserPrompt(execResult.extractedText).slice(0, 3500);
      if (execResult.url) execResult.url = defaultDOMSanitizer.sanitizeUrl(execResult.url);
      if (execResult.title) execResult.title = defaultDOMSanitizer.sanitizeUserPrompt(execResult.title);
    }

    // A plan can be structurally valid while one or more LOCAL_* sources are
    // not configured in the vault. The content script reports those fields as
    // missing, but treating that as an ordinary failed execution caused the
    // planner to repeat the same FILL_FORM_PLAN three times. Convert only this
    // narrow, value-free failure into the existing user-input flow: the user
    // can supply the value locally, and the answer is never sent back to the
    // model unless the outbound policy approves its sanitized clarification.
    if (proposedAction.action === ActionType.FILL_FORM_PLAN &&
        execResult?.success === false && Array.isArray(execResult.details)) {
      const plannedFields = Array.isArray(proposedAction.value?.fields) ? proposedAction.value.fields : [];
      const missingFields = execResult.details
        .filter((detail) => detail?.success === false && /Missing value for/i.test(String(detail.reason || '')))
        .map((detail) => plannedFields.find((field) => field?.field_id === detail.field))
        .filter(Boolean);
      if (missingFields.length) {
        const missingIds = new Set(missingFields.map((field) => field.field_id));
        execResult = {
          ...execResult,
          needs_user_input: true,
          prompt: 'Some protected profile values are not configured in the Local Vault. Enter them below; the answers stay local and are used only on this page.',
          ambiguousFields: clarificationFieldMetadata(missingFields, fusedObservation),
          details: execResult.details.filter((detail) => missingIds.has(detail.field) || detail.success === true)
        };
      }
    }

    // Intercept ASK_USER / needs_user_input to pause and await user clarification
    if (proposedAction.action === ActionType.ASK_USER || execResult?.needs_user_input) {
      const askData = {
        prompt: execResult?.prompt || proposedAction.value?.prompt || 'User clarification required',
        ambiguousFields: execResult?.ambiguousFields || proposedAction.value?.ambiguousFields || [],
        action: proposedAction
      };
      const requestId = globalThis.crypto?.randomUUID?.() || `input_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      askData.requestId = requestId;
      askData.taskId = task.id;
      taskManager.setPendingUserInput(askData, { requestId, taskId: task.id }, task);
      this.notify('STATE_CHANGED', { state: AgentState.WAITING_FOR_USER });
      this.notify('USER_INPUT_REQUIRED', askData);

      const userWaitStarted = clockNow();
      // Bounded, for the same reason the confirmation wait 100 lines earlier is:
      // an unbounded wait on a promise resolved only by the side panel parks the
      // loop forever if that panel is closed, crashed, or fails to render the
      // modal. Without this the task sits in WAITING_FOR_USER indefinitely and
      // nothing is logged. Expiring turns that into an explicit failure.
      const userInput = await (async () => {
        let expiryTimer = null;
        try {
          return await Promise.race([
            this._awaitOwned(task, token, new Promise((resolve) => {
              this.pendingUserInputResolver = resolve;
            })),
            new Promise((resolve) => {
              expiryTimer = setTimeout(() => resolve({ timedOut: true }), USER_INPUT_TIMEOUT_MS);
            })
          ]);
        } finally {
          // Clear it: an armed timer holds the MV3 service worker alive.
          if (expiryTimer !== null) clearTimeout(expiryTimer);
        }
      })();
      task.activeStepTimings.user_wait_ms = Math.max(0, Math.round(clockNow() - userWaitStarted));

      if (userInput?.timedOut) {
        this.pendingUserInputResolver = null;
        taskManager.failTask(
          'No answer was received in time. Nothing was entered or submitted.',
          task
        );
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', {
          error: 'No answer received — nothing was entered or submitted.',
          hint: 'Re-run the task and answer the prompt in the side panel.'
        });
        this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
        return false;
      }

      // Superseded by a newer task: the new loop owns the task state now.
      this._assertTaskOwner(task, token);

      taskManager.clearPendingUserInput(task);

      if (userInput?.cancelled) {
        taskManager.cancelTask(task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_CANCELLED', { reason: 'User cancelled input request' });
        this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
        return false;
      }

      // Skip is an explicit decision, not an answer that should be sent back
      // to the planner. Replanning an unchanged empty form made the agent ask
      // the same question repeatedly. For a no-submit task, completing with a
      // clear "left unchanged" result is honest; for a task that still asks
      // for submission, fail closed instead of claiming success.
      if (userInput?.skipped === true) {
        const leftUnchanged = taskExplicitlyAvoidsSubmission(task.prompt);
        taskManager.recordStep({
          thought: leftUnchanged
            ? 'User skipped the clarification; leaving the unresolved fields unchanged.'
            : 'User skipped required clarification; no further page action is safe.',
          action: proposedAction,
          result: { needs_user_input: true, skipped: true },
          success: leftUnchanged,
          ...(leftUnchanged ? {} : { error: 'Required clarification was skipped.' }),
          ...plannerStepMetadata(planResult)
        }, task);
        this.clearOverlays(task.tabId);
        if (leftUnchanged) {
          taskManager.completeTask('Clarification skipped; the unresolved fields were left unchanged.', task);
          this.notify('TASK_COMPLETED', { result: task.result });
          this._transitionLoop(task, loop, AgentLoopState.DONE);
        } else {
          taskManager.failTask('Required clarification was skipped. Nothing was submitted or attached.', task);
          this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
          this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
        }
        return false;
      }

      // If user saved any values to vault:
      const userInputApplyStarted = clockNow();
      if (Array.isArray(userInput?.saveToVault)) {
        for (const item of userInput.saveToVault) {
          if (item?.key && item?.value !== undefined) {
            try {
              await this._awaitOwned(task, token, defaultLocalVault.updateSecret(item.key, item.value));
            } catch (vErr) {
              log.exception('Could not save a vault secret', vErr);
            }
          }
        }
      }

      // Apply user answers locally. Store field IDs and execution outcomes
      // only; answer strings can contain personal values.
      const resolvedFieldIds = [];
      const answerIds = Object.keys(userInput?.answers || {});
      let verificationAction = null;
      let verificationExecution = null;
      if (!(askData.ambiguousFields || []).length && typeof userInput?.answers?.response === 'string') {
        const clarification = defaultDOMSanitizer.sanitizeUserPrompt(userInput.answers.response).slice(0, 1500).trim();
        if (clarification) {
          try {
            await this._awaitOwned(task, token, defaultLocalVault.ready);
            await defaultPolicyEngine.enforceOutboundSafety({ user_clarification: clarification });
            // Keep the text in memory for the next planner request only. It is
            // deliberately excluded from task history and task-manager snapshots.
            task.pendingPlannerClarification = clarification;
            resolvedFieldIds.push('response');
          } catch (privacyErr) {
            if (privacyErr?.name !== 'OutboundPolicyViolationError') throw privacyErr;
            taskManager.updatePrivacyMetrics({ privacyBlocks: 1 }, task);
            this.notify('PRIVACY_UPDATED', task.privacyMetrics);
            taskManager.failTask('Privacy protection blocked this AI request. Remove or rephrase the sensitive content, then try again.', task);
            this.clearOverlays(task.tabId);
            this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
            this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
            return false;
          }
        }
      }
      if (userInput?.answers && Object.keys(userInput.answers).length > 0) {
        const candidateChoice = userInput.answers.candidate_choice;
        if (!(askData.ambiguousFields || []).length && userInput.answers.response !== undefined) {
          // This free-text clarification belongs in the next planner context,
          // not in a synthetic field called `response` on the current page.
        } else if (candidateChoice !== undefined && candidateChoice !== null && candidateChoice !== '') {
          // A candidate choice is a page action, not a field value. Execute it
          // alone and let the next loop iteration observe the resulting page.
          const answerAction = { action: ActionType.CLICK, target: { element_id: candidateChoice } };
          if (await this._gateUserAnswer(task, token, answerAction, 'candidate_choice', null)) {
            loop.assertObservation(task.observationContext?.snapshotId);
            const answerResult = await this._awaitOwned(task, token,
              defaultActionExecutor.execute(task.tabId, answerAction, task.observationContext));
            if (answerResult?.success) {
              resolvedFieldIds.push('candidate_choice');
              verificationAction = actionVerificationSummary(answerAction);
              verificationExecution = { success: true };
            }
          }
        } else {
          // A single form-plan command keeps all user-provided field values
          // local and allows the content executor to resolve and type-check
          // every field against this one observation before it makes a page
          // mutation. A re-render that detaches a later field fails closed;
          // the next step then observes and grounds the changed form again.
          const fields = [];
          for (const [fieldId, value] of Object.entries(userInput.answers)) {
            if (value === undefined || value === null || value === '') continue;
            const fieldMeta = (askData.ambiguousFields || []).find((field) => field.field_id === fieldId) || {};
            // The planner's ambiguousFields metadata is optional and usually
            // absent, which used to default every answer to TEXT. A native
            // date input then failed the executor's own control-type check
            // ("type changed: expected TEXT, found DATE") and the user's
            // answer was silently discarded. Derive the control type from the
            // element this observation actually saw.
            const observed = (task.lastFusedObservation?.elements || [])
              .find((element) => (element?.id || element?.element_id || element?.el_id) === fieldId);
            const dom = observed?.dom || observed || {};
            const observedTag = String(dom.tag || '').toLowerCase();
            const observedType = String(dom.type || '').toLowerCase();
            const controlType = String(fieldMeta.control_type || observedControlType(
              observedTag, observedType, dom.role, dom.is_contenteditable === true
            ) || (
              observedTag === 'select' ? 'SELECT'
                : observedType === 'checkbox' ? 'CHECKBOX'
                  : observedType === 'radio' ? 'RADIO'
                    : observedTag === 'textarea' ? 'TEXTAREA'
                      : observedType === 'email' ? 'EMAIL'
                        : observedType === 'tel' ? 'PHONE'
                          : observedType === 'number' ? 'NUMBER'
                            : observedType === 'date' ? 'DATE' : 'TEXT'
            )).toUpperCase();
            fields.push({
              field_id: fieldId,
              control_type: controlType,
              semantic_type: fieldMeta.semantic_type,
              value
            });
          }
          if (fields.length) {
            const answerAction = { action: ActionType.FILL_FORM_PLAN, value: { fields } };
            if (await this._gateUserAnswer(task, token, answerAction, 'user_answers', null)) {
              loop.assertObservation(task.observationContext?.snapshotId);
              const answerResult = await this._awaitOwned(task, token,
                defaultActionExecutor.execute(task.tabId, answerAction, task.observationContext));
              for (const detail of answerResult?.details || []) {
                if (detail?.success) resolvedFieldIds.push(detail.field);
              }
              if (answerResult?.details?.some((detail) => detail?.success)) {
                verificationAction = actionVerificationSummary(answerAction);
                verificationExecution = { success: true };
              }
            }
          }
        }
      }
      const skippedFieldIds = (askData.ambiguousFields || [])
        .map((field) => field.field_id)
        .filter((id) => !resolvedFieldIds.includes(id));

      if ([AgentState.FAILED, AgentState.CANCELLED].includes(task.state)) {
        this._transitionLoop(task, loop, AgentLoopState.BLOCKED);
        return false;
      }

      task.activeStepTimings.user_input_apply_ms = Math.max(0, Math.round(clockNow() - userInputApplyStarted));
      await this._awaitOwned(task, token, measureStage(task, 'user_input_followup_wait_ms', () => this.sleep(400)));

      this._transitionLoop(task, loop, AgentLoopState.VERIFY);

      // Record step in history with user's responses
      taskManager.recordStep({
        thought: planResult.thought,
        action: proposedAction,
        result: {
          needs_user_input: Boolean(execResult?.needs_user_input),
          resolvedFieldIds,
          skippedFieldIds,
          answeredFieldIds: answerIds.filter((id) => resolvedFieldIds.includes(id))
        },
        success: true,
        ...plannerStepMetadata(planResult)
      }, task);
      if (verificationAction && verificationExecution) {
        task.pendingVerification = {
          action: verificationAction,
          execution: verificationExecution,
          beforeObservation: fusedObservation,
          stepNumber: task.currentStep
        };
      }

      this.notify('STEP_COMPLETED', {
        stepNumber: task.currentStep,
        thought: 'User clarification received and applied',
        action: proposedAction,
        success: true,
        timestamp: Date.now()
      });
      this._transitionLoop(task, loop, AgentLoopState.REPLAN);
      return true;
    }

    // STEP 8: VERIFY — execution result determines recovery
    this._transitionLoop(task, loop, AgentLoopState.VERIFY);
    taskManager.updateState(AgentState.VERIFYING, 'Checking the result…', task);
    this.notify('STATE_CHANGED', { state: AgentState.VERIFYING });

    if (!execResult || execResult.success === false) {
      // A FILL_FORM_PLAN reports per-field outcomes in `details` but no
      // top-level `error`. Without surfacing the first failing field the
      // planner is told only "Action did not complete", with no field and no
      // reason, so it re-plans the identical batch and the failure counter
      // eventually kills a task where 11 of 12 fields actually succeeded.
      const firstFailedField = Array.isArray(execResult?.details)
        ? execResult.details.find((detail) => detail && detail.success !== true)
        : null;
      const errMsg = execResult?.error
        || (firstFailedField
          ? `Field ${firstFailedField.field || firstFailedField.field_id || '(unknown)'} did not fill: ${firstFailedField.reason || firstFailedField.error || 'no reason given'}`
          : 'Action did not complete');
      await this._awaitOwned(task, token, measureStage(task, 'failed_action_recovery_wait_ms', () => this.sleep(600)));
      taskManager.recordStep({
        thought: planResult.thought,
        action: proposedAction,
        result: execResult,
        success: false,
        error: String(errMsg).slice(0, 200),
        ...plannerStepMetadata(planResult),
        diagnostic: { model_trace: task.lastLLMPayload?.modelTrace || null }
      }, task);
      task.pendingVerification = {
        action: actionVerificationSummary(proposedAction),
        execution: { success: false },
        beforeObservation: fusedObservation,
        stepNumber: task.currentStep
      };
      this.notify('STEP_FAILED', {
        stepNumber: task.currentStep,
        thought: 'That action did not complete. The agent will try another way.',
        action: proposedAction,
        success: false,
        timestamp: Date.now()
      });
      this._transitionLoop(task, loop, AgentLoopState.REPLAN);
      return true;
    }

    // Settle the page before saving the step timing so this stage is included
    // in the per-step latency record. The next observation still performs its
    // own mutation-based stability check.
    const postActionWait = this._getPostActionWait(proposedAction.action);
    await this._awaitOwned(task, token, measureStage(task, 'post_action_wait_ms', () => this.sleep(postActionWait)));

    taskManager.recordStep({
      thought: planResult.thought,
      action: proposedAction,
      result: execResult,
      success: true,
      ...plannerStepMetadata(planResult),
      diagnostic: {
        task_understanding: planResult.task_understanding,
        page_understanding: planResult.page_understanding,
        current_state: planResult.current_state,
        task_state: task.taskState?.toPayload(),
        page_state: task.pageState,
        model_trace: task.lastLLMPayload?.modelTrace || null,
        // Decision diagnostics: safe metadata only (ids, semantic types,
        // scores, evidence sources) — never raw personal data, secrets,
        // page contents, or model responses.
        decision: {
          task_intent: taskIntent || null,
          required_action: planResult.selection_evidence?.required_action || proposedAction?.action || null,
          candidate_ids: planResult.selection_evidence?.candidate_ids || null,
          candidate_semantics: planResult.selection_evidence?.candidate_semantics || null,
          candidate_scores: planResult.selection_evidence?.candidate_scores || null,
          selected_candidate: planResult.selection_evidence?.selected_candidate || proposedAction?.target?.element_id || null,
          selection_evidence: planResult.selection_evidence?.selection_evidence || null,
          validation_result: 'PASSED'
        }
      }
    });
    task.pendingVerification = {
      action: actionVerificationSummary(proposedAction),
      execution: { success: true },
      beforeObservation: fusedObservation,
      stepNumber: task.currentStep
    };

    this.notify('STEP_COMPLETED', {
      stepNumber: task.currentStep,
      thought: planResult.thought,
      action: proposedAction,
      result: execResult,
      diagnostic: {
        task_understanding: planResult.task_understanding,
        page_understanding: planResult.page_understanding,
        current_state: planResult.current_state,
        task_state: task.taskState?.toPayload(),
        page_state: task.pageState,
        model_trace: task.lastLLMPayload?.modelTrace || null,
      },
      success: true,
      timestamp: Date.now()
    });

    this._transitionLoop(task, loop, AgentLoopState.REPLAN);
    return true;
  }

  /**
   * Converts a clarification the agent could have answered itself into the
   * grounded click it describes.
   *
   * The planner reaches for ASK_USER whenever candidates look "equally
   * suitable", which on a results page is almost always true, and then asks the
   * user to do the work: "please click the first video result". That hands back
   * to the human the one thing the agent exists to do.
   *
   * Fails closed to the normal ASK_USER path unless every condition holds:
   *   - the action really is ASK_USER, with a question
   *   - the question asks for an on-page interaction
   *   - the question does not need a value only the user can supply
   *   - the observation grounds one clearly best clickable candidate
   *
   * OTPs, CAPTCHAs, credentials, legal-ambiguity fields and unattributable
   * identity choices are deliberately excluded: those are genuinely the user's
   * to answer, and automating them would trade a safety property for
   * convenience.
   *
   * @returns {Object|null} a replacement action, or null to keep asking.
   */
  _resolveAgentDoableClarification(action, fusedObservation, task) {
    if (action?.action !== ActionType.ASK_USER) return null;
    const prompt = String(action.value?.prompt || '').trim();
    if (!prompt) return null;

    // The question must describe something doable on the page...
    if (!/\b(click|open|select|choose|tap|press|start|play|pick)\b/i.test(prompt)) return null;
    // ...and must not be asking for information only the user holds.
    if (/\b(?:otp|one[\s-]?time|captcha|verification\s+code|security\s+code|2fa|passcode|password|ssn|aadhaar|aadhar|pan|card\s+number|cvv|sign[\s-]?in|log[\s-]?in|type\s+your|enter\s+your|provide\s+your|upload|attach)\b/i.test(prompt)) {
      return null;
    }

    // Models sometimes still ask the user to click Play even though the
    // watch-page control is present in the grounded DOM. Resolve that narrow
    // case locally: require an explicit PLAY task, a video page, a matching
    // requested title, paused media, and a visible/enabled observed control.
    // The resulting CLICK still passes through the normal semantic and risk
    // gates, including the LOW-risk media fast path.
    const mediaPlayIntent = normalizedIntent(task);
    const wantsMediaPlayback = mediaPlayIntent === 'PLAY' || taskRequires(task, 'PLAY') ||
      (!mediaPlayIntent && promptAsksPlay(task));
    const currentUrl = String(fusedObservation?.page?.url || task.pageState?.url || '');
    const pageType = String(task.pageState?.page_type || '').toUpperCase();
    const isVideoPage = pageType === 'VIDEO_PAGE' || /\/(?:watch|shorts|embed|video)(?:\/|\?|$)/i.test(currentUrl);
    if (wantsMediaPlayback && isVideoPage && !mediaCurrentlyPlaying(fusedObservation) &&
        requestedMediaMatchesPage(task, fusedObservation) &&
        /\b(?:play\s+button|click\s+(?:the\s+)?play|press\s+(?:the\s+)?play|start\s+playback)\b/i.test(prompt)) {
      const normalizeLabel = (value) => String(value || '')
        .replace(/\s*[[(].*?[\])]\s*$/, '')
        .trim();
      const playControlPattern = /^\s*(?:play|resume)(?:\s+(?:(?:the\s+)?video|media|playback|button))?[\s.!…]*$/i;
      const playControl = (fusedObservation.elements || []).find((element) => {
        if (!element || element.visible === false || element.enabled === false ||
            element.disabled === true || element.interaction?.clickable !== true) return false;
        const tag = String(element.dom?.tag || element.tag || '').toLowerCase();
        const role = String(element.dom?.role || element.role || '').toLowerCase();
        const semantic = String(element.semantics?.semantic_type || element.semantic_action_type || '').toUpperCase();
        const isButton = tag === 'button' || role === 'button' || semantic === 'PLAY';
        if (!isButton) return false;
        const labels = [
          element.accessible_name, element.label, element.text, element.title,
          element.dom?.accessible_name, element.dom?.ariaLabel,
          element.dom?.label, element.dom?.text, element.dom?.title
        ];
        return labels.some((label) => typeof label === 'string' &&
          playControlPattern.test(normalizeLabel(label)));
      });
      if (playControl?.id) {
        const label = String(playControl.accessible_name || playControl.label || 'Play').slice(0, 80);
        log.info('Resolved a play-control clarification using the observed player button.', {
          acted_on: playControl.id,
          label
        });
        return {
          action: ActionType.CLICK,
          risk: RiskLevel.LOW,
          requires_confirmation: false,
          target: { element_id: playControl.id, label },
          thought: `Clicking the observed ${label} control to start the requested video.`
        };
      }
    }

    // `is_clickable` is NOT on ranked_candidates. task-grounding.js builds that
    // list and never emits the flag; page-state-modeler.js computes it, but onto
    // pageState.elements -- a different array. Filtering on it here therefore
    // matched nothing, so this whole 45-line resolver was unreachable and every
    // "please click the first result" still deferred to the user. Read the flag
    // from the element list, indexed by id.
    const clickableIds = new Set(
      (task.pageState?.elements || [])
        .filter((el) => el && el.is_clickable === true)
        .map((el) => el.id)
        .filter(Boolean)
    );
    const candidates = (task.pageState?.ranked_candidates || [])
      .filter((c) => c && typeof c.element_id === 'string' && c.element_id && clickableIds.has(c.element_id));
    if (!candidates.length) return null;

    const [best, runnerUp] = candidates;
    // "the first", "the top", "any of them": the model is describing a
    // pick-one decision, so the local ranking is the answer to it.
    const defersChoice = /\b(?:first|top|any|one\s+of|either)\b/i.test(prompt);
    // Fungible media picks: on an explicit play request ("play isro video")
    // any topically-matching result completes the goal — choosing between
    // equally-scored ISRO videos carries no identity, credential, or purchase
    // consequence, so a near-tie is not evidence the user must choose. The
    // best-ranked candidate (the same ranking the planner clicks unaided)
    // wins without the margin requirement. Every other guard on this path —
    // the credential/OTP/sign-in exclusions, the clickability join, the
    // positive-score floor — still applies.
    const playIntent = normalizedIntent(task);
    const taskWantsPlay = playIntent === 'PLAY' || taskRequires(task, 'PLAY') ||
      (!playIntent && promptAsksPlay(task));
    const isYouTube = (task.pageState?.site || '').toLowerCase() === 'youtube' || /\byoutube\b/i.test(task.prompt || '');
    const mediaChoice = (taskWantsPlay || isYouTube) && /\b(?:play|watch|video|song|music|result)\b/i.test(prompt);
    // Otherwise the best candidate must actually stand out. A near-tie means the
    // model was right that the choice belongs to the user.
    if (!defersChoice && !mediaChoice && runnerUp && Number.isFinite(best.score) && Number.isFinite(runnerUp.score) &&
        best.score - runnerUp.score < 3) {
      return null;
    }
    // A non-positive top score means nothing on the page really matched.
    if (Number.isFinite(best.score) && best.score <= 0) return null;

    const label = String(best.accessible_name || best.label || best.element_id).slice(0, 80);
    log.info('Resolved a clarification the agent could act on itself.', {
      asked: prompt.slice(0, 160),
      acted_on: best.element_id,
      label,
      score: best.score ?? null,
      defers_choice: defersChoice
    });
    return {
      action: ActionType.CLICK,
      risk: RiskLevel.LOW,
      requires_confirmation: false,
      target: { element_id: best.element_id, label },
      thought: `Proceeding with the best match on this page (${label}) rather than asking the user to choose.`
    };
  }

  _avoidYouTubeShorts(action, fusedObservation, task) {
    if (!wantsFullLengthYouTubeVideo(task, fusedObservation)) return null;
    const currentUrl = String(fusedObservation?.page?.url || task.pageState?.url || '');
    const currentlyOnShort = isYouTubeShortsUrl(currentUrl);
    const navigationTarget = action?.action === ActionType.NAVIGATE
      ? (action.target?.url || action.value)
      : '';
    const targetId = action?.target?.element_id || action?.targetId || '';
    let selected = targetId ? observationElement(fusedObservation, targetId) : null;
    if (!selected && targetId.startsWith('item_')) {
      const item = (fusedObservation?.result_items || []).find((candidate) => candidate.id === targetId);
      selected = item?.primary_action_id
        ? observationElement(fusedObservation, item.primary_action_id)
        : null;
    }
    const selectedUrl = action?.action === ActionType.NAVIGATE
      ? String(navigationTarget || '')
      : String(selected?.href || selected?.dom?.href || '');
    const targetingShort = isYouTubeShortsUrl(selectedUrl);
    const targetingFullLengthVideo = isFullLengthYouTubeVideoUrl(selectedUrl);

    // An explicit route to search results or a grounded full video is already
    // moving toward the user's requested content. Let it proceed.
    if (currentlyOnShort && (targetingFullLengthVideo ||
        (action?.action === ActionType.NAVIGATE && !targetingShort) ||
        action?.action === ActionType.GO_BACK)) return null;
    if (!currentlyOnShort && !targetingShort) return null;

    const rankedScores = new Map((task.pageState?.ranked_candidates || [])
      .map((candidate) => [candidate?.element_id, Number(candidate?.score)]));
    const fullLengthCandidates = (fusedObservation?.elements || [])
      .filter((element) => element && element.visible !== false && element.enabled !== false &&
        element.disabled !== true && element.interaction?.clickable === true &&
        isFullLengthYouTubeVideoUrl(element.href || element.dom?.href || ''))
      .sort((a, b) => {
        const scoreA = rankedScores.get(a.id);
        const scoreB = rankedScores.get(b.id);
        const safeA = Number.isFinite(scoreA) ? scoreA : -Infinity;
        const safeB = Number.isFinite(scoreB) ? scoreB : -Infinity;
        return safeA === safeB ? 0 : safeB > safeA ? 1 : -1;
      });
    const best = fullLengthCandidates[0];
    if (best?.id) {
      const label = String(best.accessible_name || best.label || best.text || 'Full video').slice(0, 100);
      log.info('Skipped a YouTube Short and selected an observed full video.', {
        acted_on: best.id,
        label
      });
      return {
        action: ActionType.CLICK,
        risk: action?.risk || RiskLevel.LOW,
        requires_confirmation: action?.requires_confirmation === true,
        target: { element_id: best.id, label },
        thought: `Skipping the Shorts result and opening the best-ranked full video (${label}).`
      };
    }

    if (currentlyOnShort) {
      return {
        action: ActionType.GO_BACK,
        risk: RiskLevel.LOW,
        requires_confirmation: false,
        thought: 'Leaving YouTube Shorts to return to the video results and find a full video.'
      };
    }
    log.info('Skipped a YouTube Shorts result; scrolling to look for a full video.', {});
    return {
      action: ActionType.SCROLL,
      deltaY: 650,
      risk: RiskLevel.LOW,
      requires_confirmation: false,
      thought: 'Skipping the Shorts result and looking farther down for a full video.'
    };
  }

  _completeFromCriticTermination(task, planResult, proposedAction) {
    if (planResult?.terminate_assessment !== true || proposedAction?.action === ActionType.DONE) return false;
    // Form tasks have a separate local completion guard below: DONE is
    // accepted only after the relevant form's required fields are satisfied.
    // A critic stop flag paired with a non-DONE action must not skip that
    // check, even if it includes a polished final response.
    if (normalizedIntent(task) === 'FILL_FORM') return false;
    const finalResponse = typeof planResult.final_response === 'string'
      ? planResult.final_response.trim()
      : '';
    if (!finalResponse) return false;

    taskManager.completeTask(finalResponse, task);
    this.clearOverlays(task.tabId);
    this.notify('TASK_COMPLETED', { result: finalResponse });
    return true;
  }

  _handlePlannerFailure(task, planResult) {
    if (planResult?.remoteCallAttempted !== false) taskManager.updatePrivacyMetrics({ serverCallsCount: 1 }, task);
    if (planResult?.privacyBlocked) taskManager.updatePrivacyMetrics({ privacyBlocks: 1 }, task);
    if (planResult?.authRejected) {
      // The most common first-run failure, and the one a generic "service
      // unavailable" message hides completely. Name the actual fix.
      taskManager.failTask(
        'The extension is not authenticated with the backend. Open Settings and paste the BACKEND_SHARED_SECRET value from your .env into "Backend access token", then save.',
        task
      );
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
      return false;
    }
    if (planResult?.plannerUnavailable) {
      // The client classifies the failure (unreachable / timeout / server error
      // / rejected) and supplies the matching remedy. Show that instead of one
      // generic "check the configuration" line, which is useless when the real
      // problem is that nothing is listening on the port.
      taskManager.failTask(
        planResult.unavailableAdvice
          || 'The AI planner is unavailable. Check the backend configuration and try again.',
        task
      );
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
      return false;
    }
    if (planResult?.privacyBlocked) {
      this.notify('PRIVACY_UPDATED', task.privacyMetrics);
      // GPTOSSClient returns only PolicyEngine's value-free diagnostic here
      // (category/reason, never the matched text). Preserve it so friendlyError
      // can tell the user what kind of content triggered the local gate.
      // Backend-side blocks still use the generic fallback because they do
      // not include a locally verified category.
      const blockMessage = typeof planResult.privacyBlocked === 'string' &&
        planResult.privacyBlocked.startsWith('Outbound policy blocked payload:')
        ? planResult.privacyBlocked
        : 'Privacy protection blocked this AI request. Remove or rephrase the sensitive content, then try again.';
      taskManager.failTask(blockMessage, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
      return false;
    }
    return true;
  }

  /**
   * Capability-aware navigation bootstrap (runs before OBSERVE).
   *
   * - Pure NAVIGATE tasks ("open youtube"): validated deterministic
   *   navigation in task.tabId, verified by URL — from ANY page except the
   *   extension panel. No DOM extraction, no VLM, no grounding needed.
   * - Compound tasks starting on a non-automatable page with a known site
   *   ("search youtube for cats" from chrome://newtab): navigate to the
   *   site homepage first, then let the normal loop re-observe and continue.
   * - Otherwise: { handled:false } and the caller applies the normal
   *   pipeline (or a controlled unsupported-page error).
   *
   * Returns { handled:boolean, shouldContinue:boolean }.
   */
  async _maybeHandleNavigationBootstrap(task, currentTab, capability, token = task.runToken) {
    const notHandled = { handled: false, shouldContinue: true };
    // User-approved shortcuts ("My sites") resolve before the built-in map.
    const customSites = taskManager.settings?.customSites &&
      typeof taskManager.settings.customSites === 'object' &&
      !Array.isArray(taskManager.settings.customSites)
      ? taskManager.settings.customSites
      : {};
    let goal = null;
    try {
      goal = getNavigationGoal(task.prompt, customSites);
    } catch {
      goal = null;
    }

    // Never navigate the extension panel tab away.
    if (capability === PageCapability.EXTENSION_INTERNAL) return notHandled;

    if (goal?.url) {
      const validation = validateNavigationUrl(goal.url);
      log.info('NAVIGATION', { phase: 'validated', target: validation.normalizedUrl || goal.url, valid: validation.valid });
      if (!validation.valid) {
        taskManager.failTask(`Navigation blocked: ${validation.reason}`, task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: taskManager.getTask()?.error, hint: taskManager.getTask()?.hint });
        return { handled: true, shouldContinue: false };
      }

      // Already on the target host: never navigate again.
      //
      // This used to be gated behind `!goal.isPure`, which meant a compound
      // prompt whose navigation lead was not recognised as pure — "go to
      // youtube and play an ISRO video" — reloaded the destination on every
      // single step. Each reload reset the page, so the action that was about
      // to be dispatched was always stale, the step re-observed, and the
      // bootstrap navigated again. That is a livelock, not a slow task.
      //
      // Being on the right host is sufficient reason to skip, whether or not
      // the task is pure: re-navigating to the URL you are already on cannot
      // make progress, and it destroys the very observation the next action
      // depends on.
      const currentHost = (() => { try { return new URL(currentTab?.url || '').hostname.toLowerCase(); } catch { return ''; } })();
      const targetHost = validation.host?.toLowerCase() || '';
      if (currentHost && targetHost && (currentHost === targetHost || currentHost.endsWith('.' + targetHost))) {
        const subgoal = task.taskState?.getActiveSubgoal()?.toLowerCase() || '';
        if (subgoal.startsWith('open ') || subgoal.startsWith('navigate ')) {
          try { task.taskState.advanceSubgoal?.(); } catch {}
        }
        return notHandled;
      }

      return await this._awaitOwned(task, token, this._executeBootstrapNavigation(task, currentTab, validation.normalizedUrl, {
        pure: goal.isPure,
        thought: goal.isPure
          ? `Navigate to ${validation.host} (pure navigation request; no page interaction needed).`
          : `Navigate to ${validation.host} first, then continue the task on the new page.`
      }, token));
    }

    // Compound task stranded on a non-automatable page or starting on another site:
    // hop to the task's site homepage (if deterministically known), then re-observe.
    const site = task.taskState?.site;
    let home = site ? getSiteHomepage(site, customSites) : null;
    const currentHost = (() => { try { return new URL(currentTab?.url || '').hostname.toLowerCase(); } catch { return ''; } })();
    const targetSiteHost = site?.toLowerCase();

    // If already on that site, do not navigate again
    if (home && currentHost && targetSiteHost && (currentHost === targetSiteHost || currentHost.includes(targetSiteHost))) {
      home = null;
      const subgoal = task.taskState?.getActiveSubgoal()?.toLowerCase() || '';
      if (subgoal.startsWith('open ') || subgoal.startsWith('navigate ')) {
        try { task.taskState.advanceSubgoal?.(); } catch {}
      }
    }

    if (home) {
      const validation = validateNavigationUrl(home);
      if (!validation.valid) return notHandled;
      log.info('NAVIGATION', { phase: 'bootstrap', target: validation.normalizedUrl, valid: true });
      return await this._awaitOwned(task, token, this._executeBootstrapNavigation(task, currentTab, validation.normalizedUrl, {
        pure: false,
        thought: `Navigate to ${validation.host} first, then continue the task.`
      }, token));
    }

    // Stranded on a non-automatable page (new tab, browser internal) with a
    // navigation request no site list resolves ("open <unknown> website").
    // The built-in list is intentionally small and stays that way: an
    // off-list destination needs the user's eyes, not a silent guess. Ask for
    // approval to search instead, with the option to give the exact address
    // and store it in "My sites" for next time. Non-navigation tasks still
    // fail via the capability gate below.
    if (capability !== PageCapability.AUTOMATABLE_WEB && capability !== PageCapability.EXTENSION_INTERNAL) {
      const wantsNavigation = goal?.needsSearch === true ||
        (goal && !goal.url) ||
        /^(?:please\s+)?(?:could\s+you\s+)?(?:open|go\s+to|navigate\s+to|visit|go)\b/i.test(String(task.prompt || ''));
      const query = String(task.prompt || '')
        .replace(/^(?:please\s+)?(?:could\s+you\s+)?(?:open|go\s+to|navigate\s+to|visit|go)\s+/i, '')
        .trim().slice(0, 200);
      if (wantsNavigation && query) {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        const validation = validateNavigationUrl(searchUrl);
        if (validation.valid) {
          return await this._awaitOwned(task, token, this._approveOffListNavigation(task, {
            siteLabel: String(goal?.site || query).slice(0, 80),
            query,
            searchUrl: validation.normalizedUrl,
            isPure: goal?.isPure === true
          }, token));
        }
      }
    }

    return notHandled;
  }

  /**
   * Approval gate for destinations outside every site list.
   *
   * The panel shows a confirmation with the proposed Google search plus an
   * optional address field and an "Add to my sites" toggle. Approving with an
   * address navigates there directly (and stores it when asked); approving
   * empty-handed runs the pure-search fallback; declining stops the task.
   * Returns the same { handled, shouldContinue } contract as the bootstrap.
   */
  async _approveOffListNavigation(task, { siteLabel, query, searchUrl, isPure }, token = task.runToken) {
    const stopped = { handled: true, shouldContinue: false };
    const confirmationId = globalThis.crypto?.randomUUID?.() || `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const navAction = {
      action: ActionType.NAVIGATE,
      target: { url: searchUrl },
      risk: RiskLevel.LOW,
      requires_confirmation: true
    };
    const reason = `"${siteLabel}" is not in the known-sites list, so it needs your call: continue to a Google search for it, or type its exact address to open it directly (optionally adding it to My sites for next time).`;
    taskManager.setPendingConfirmation(navAction, reason, {
      confirmationId, taskId: task.id, siteApproval: true, siteLabel, candidateUrl: searchUrl
    }, task);
    this.notify('STATE_CHANGED', { state: AgentState.WAITING_FOR_USER });
    this.notify('CONFIRMATION_REQUIRED', {
      confirmationId,
      taskId: task.id,
      action: { ...navAction, risk: RiskLevel.LOW },
      reason,
      siteApproval: true,
      siteLabel,
      candidateUrl: searchUrl,
      privacySummary: {
        dataKeptLocal: 'No secrets disclosed',
        dataSharedWithServer: 'Sanitized task request and page context; saved profile values stay local'
      }
    });
    const approved = await this._awaitOwned(task, token, new Promise((resolve) => {
      this.pendingUserConfirmationResolver = resolve;
    }));
    taskManager.clearPendingConfirmation(task);
    const response = this.lastConfirmationResponse;
    this.lastConfirmationResponse = null;
    if (!approved) {
      taskManager.cancelTask(task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_CANCELLED', { reason: `Navigation to "${siteLabel}" was declined. It was not added to the sites list.` });
      return stopped;
    }
    // An exact address from the user beats the search: validate it like any
    // other navigation target, never trust it blindly.
    const userUrl = String(response?.siteUrl || '').trim();
    if (userUrl) {
      const direct = validateNavigationUrl(userUrl);
      if (!direct.valid) {
        taskManager.failTask(`That website address was rejected: ${direct.reason}`, task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_FAILED', { error: taskManager.getTask()?.error, hint: taskManager.getTask()?.hint });
        return stopped;
      }
      if (response?.rememberSite === true) {
        try {
          const current = taskManager.settings?.customSites || {};
          await taskManager.updateSettings({
            customSites: { ...current, [siteLabel.toLowerCase()]: direct.normalizedUrl }
          });
          log.info('NAVIGATION', { phase: 'site-remembered', site: siteLabel, host: direct.host });
        } catch (error) {
          log.warn('Could not remember the approved site; continuing without storing it.', { error: String(error?.message || error).slice(0, 160) });
        }
      }
      return await this._awaitOwned(task, token, this._executeBootstrapNavigation(task, null, direct.normalizedUrl, {
        pure: isPure,
        thought: `Open "${siteLabel}" at ${direct.host} (approved by the user).`
      }, token));
    }
    // Approved empty-handed: pure-search fallback, not a direct open, so the
    // loop continues on the results page instead of completing.
    return await this._awaitOwned(task, token, this._executeBootstrapNavigation(task, null, searchUrl, {
      pure: false,
      thought: `The destination is not in the sites list (approved to search), so search for "${String(query || siteLabel).slice(0, 120)}" first, then continue the task on the results page.`
    }, token));
  }

  /**
   * Validated tab navigation + verification for the bootstrap path.
   * Always uses task.tabId (never the focused window/tab). Uses the same
   * defaultActionExecutor NAVIGATE implementation as the normal pipeline —
   * no competing navigation path. Records honest steps: success only after
   * URL verification, failure otherwise (never fake success).
   */
  async _executeBootstrapNavigation(task, currentTab, normalizedUrl, { pure, thought }, token = task.runToken) {
    const navAction = {
      action: ActionType.NAVIGATE,
      target: { url: normalizedUrl },
      risk: RiskLevel.LOW,
      requires_confirmation: false
    };

    // Existing safety gate still applies (defense in depth).
    let riskAssessment = { allowed: true, risk: RiskLevel.LOW, reason: 'Standard interactive action.' };
    try {
      riskAssessment = defaultRiskGate.evaluate(navAction, {
        targetElement: navAction.target,
        targetDom: null,
        currentUrl: currentTab?.url || '',
        pageTitle: currentTab?.title || ''
      });
    } catch (e) {
      log.exception('Risk evaluation failed; continuing with LOW', e);
    }
    if (!riskAssessment.allowed) {
      taskManager.failTask(`Safety Gate Blocked Action: ${riskAssessment.reason}`, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: taskManager.getTask()?.error, hint: taskManager.getTask()?.hint });
      return { handled: true, shouldContinue: false };
    }

    // Persist pre-navigation state so a service-worker restart mid-flight
    // leaves an honest EXECUTING task (with history), never a fake DONE.
    taskManager.updateState(AgentState.EXECUTING, `Navigating to ${normalizedUrl}…`, task);
    this.notify('STATE_CHANGED', { state: AgentState.EXECUTING, action: navAction });
    log.info('NAVIGATION', { phase: 'started', tab_id: task.tabId });

    let execResult;
    try {
      this._assertTaskOwner(task, token);
      execResult = await this._awaitOwned(task, token, measureStage(task, 'navigation_execution_ms', () => defaultActionExecutor.execute(task.tabId, navAction)));
    } catch (execErr) {
      if (execErr?.name === 'SupersededTaskError') throw execErr;
      execResult = { success: false, error: execErr?.message || 'Navigation failed' };
    }
    if (!execResult || execResult.success === false) {
      const errMsg = String(execResult?.error || 'Navigation did not complete').slice(0, 200);
      log.warn('NAVIGATION', { phase: 'failed', reason: errMsg });
      taskManager.recordStep({ thought, action: navAction, result: execResult, success: false, error: errMsg }, task);
      this.notify('STEP_FAILED', { stepNumber: task.currentStep, thought, action: navAction, success: false, timestamp: Date.now() });
      return { handled: true, shouldContinue: true };
    }

    const verification = await this._awaitOwned(task, token, measureStage(task, 'navigation_verification_ms', () => this._verifyNavigation(task.tabId, normalizedUrl, task, token)));
    log.info('NAVIGATION', { phase: verification.ok ? 'completed' : 'failed' });
    log.info('VERIFY', { url: verification.actualUrl || '(unknown)', success: verification.ok });
    if (!verification.ok) {
      const errMsg = verification.actualUrl
        ? `Navigation reached ${verification.actualUrl} instead of the requested destination.`
        : 'Navigation timed out before the new page could be verified.';
      taskManager.recordStep({ thought, action: navAction, result: execResult, success: false, error: errMsg.slice(0, 200) }, task);
      this.notify('STEP_FAILED', { stepNumber: task.currentStep, thought: errMsg, action: navAction, success: false, timestamp: Date.now() });
      return { handled: true, shouldContinue: true };
    }

    if (pure) {
      taskManager.recordStep({
        thought: `${thought} Verified at ${verification.actualUrl}.`,
        action: navAction,
        result: execResult,
        success: true,
        diagnostic: { bootstrap_navigation: true, verified_url: verification.actualUrl }
      }, task);
      this.notify('STEP_COMPLETED', { stepNumber: task.currentStep, thought, action: navAction, success: true, timestamp: Date.now() });
      try {
        if (task.taskState?.advanceSubgoal) task.taskState.advanceSubgoal();
        else if (task.taskState?.advance) task.taskState.advance(navAction, null, { success: true });
      } catch { /* non-fatal */ }
      taskManager.completeTask(`Navigated to ${verification.actualUrl}.`, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_COMPLETED', { result: `Navigated to ${verification.actualUrl}.` });
      return { handled: true, shouldContinue: false };
    }

    try {
      const subgoal = task.taskState?.getActiveSubgoal()?.toLowerCase() || '';
      if (subgoal.startsWith('open ') || subgoal.startsWith('navigate ')) {
        task.taskState.advanceSubgoal?.();
      }
    } catch {}

    await this._awaitOwned(task, token, measureStage(task, 'post_action_wait_ms', () => this.sleep(this._getPostActionWait(ActionType.NAVIGATE))));
    taskManager.recordStep({
      thought: `${thought} Verified at ${verification.actualUrl}.`,
      action: navAction,
      result: execResult,
      success: true,
      diagnostic: { bootstrap_navigation: true, verified_url: verification.actualUrl }
    }, task);
    this.notify('STEP_COMPLETED', { stepNumber: task.currentStep, thought, action: navAction, success: true, timestamp: Date.now() });
    return { handled: true, shouldContinue: true };
  }

  /** Poll task.tabId until its URL matches the destination (redirect-tolerant). */
  async _verifyNavigation(tabId, expectedUrl, task = null, token = this.runToken) {
    const deadline = Date.now() + NAV_VERIFY_TIMEOUT_MS;
    let actualUrl = '';
    while (Date.now() < deadline) {
      try {
        const tab = await withTimeout(chrome.tabs.get(tabId), CHROME_API_TIMEOUT_MS, 'The browser tab did not respond in time.');
        if (task) this._assertTaskOwner(task, token);
        actualUrl = tab?.url || '';
        if (actualUrl && urlsMatchForVerification(expectedUrl, actualUrl)) {
          return { ok: true, actualUrl };
        }
      } catch {
        // Tab may be mid-navigation; keep polling until the timeout.
      }
      if (task) await this._awaitOwned(task, token, this.sleep(NAV_VERIFY_POLL_MS));
      else await this.sleep(NAV_VERIFY_POLL_MS);
    }
    try {
      const tab = await withTimeout(chrome.tabs.get(tabId), CHROME_API_TIMEOUT_MS, 'The browser tab did not respond in time.');
      if (task) this._assertTaskOwner(task, token);
      actualUrl = tab?.url || actualUrl;
    } catch { /* keep last value */ }
    return { ok: false, actualUrl };
  }

  /**
   * L2: Improved stuck-loop detection.
   * Catches both exact repetition AND alternating patterns (A→B→A→B).
   * Also checks if state fingerprint hasn't changed across recent steps.
   */
  _isStuckInLoop(task) {
    const steps = task.steps || [];
    if (steps.length < MAX_IDENTICAL_ACTIONS) return false;
    const tail = steps.slice(-MAX_IDENTICAL_ACTIONS);

    const keyOf = (s) => {
      const a = s?.action || {};
      const t = a.target || {};
      // Action signature only (type + element + symbolic source): thought
      // text never participates, so loops hidden behind slightly different
      // reasoning are still detected.
      return `${a.action}::${t.element_id || t.url || ''}::${a.value_source || ''}`;
    };

    // Check 1: Exact same action repeated N times
    const stateFingerprint = (s) => {
      const p = s.diagnostic?.page_state || {};
      // Include result-set size and text excerpt so genuinely different pages
      // never collide on "undefined::undefined::undefined".
      const resultCount = Array.isArray(p.result_sets) ? p.result_sets.length : (p.result_sets ? 1 : 0);
      const textHead = String(p.visible_text_excerpt || '').slice(0, 80);
      return `${p.url || ''}::${p.page_type || ''}::${p.summary || ''}::${resultCount}::${textHead}`;
    };

    const firstAction = keyOf(tail[0]);
    const firstState = stateFingerprint(tail[0]);
    const allIdentical = tail.every((s) => s.success === true && keyOf(s) === firstAction && stateFingerprint(s) === firstState);
    if (allIdentical) return true;

    // L2: Check 2: Alternating pattern detection (A→B→A→B)
    if (steps.length >= 4) {
      const last4 = steps.slice(-4);
      const keys = last4.map(keyOf);
      if (keys[0] === keys[2] && keys[1] === keys[3] && keys[0] !== keys[1]) {
        // Check that no actual progress is being made (page state unchanged)
        const states = last4.map(stateFingerprint);
        if (states[0] === states[2] && states[1] === states[3]) {
          log.warn('Alternating stuck loop detected', { keys });
          return true;
        }
      }
    }

    // L2: Check 3: All recent steps are failures with the same NON-EMPTY error.
    // Empty errors (no diagnostic) are not a loop signal — the original
    // circuit-breaker ignored failing sequences entirely.
    if (steps.length >= MAX_IDENTICAL_ACTIONS) {
      const recentFails = steps.slice(-MAX_IDENTICAL_ACTIONS);
      if (recentFails.every(s => s.success === false)) {
        const errors = recentFails.map(s => (s.error || '').slice(0, 50));
        if (errors[0] && new Set(errors).size === 1) {
          log.warn('Repeated identical failures detected', { count: recentFails.length });
          return true;
        }
      }
    }

    return false;
  }

  // Backward-compatible alias for older tests: exact-repeat circuit breaker.
  _isRepeatingIdenticalAction(task) {
    return this._isStuckInLoop(task);
  }

  /**
   * L12: Strips webpage-embedded instruction attacks from the observation copy
   * passed to the planner. Webpage text is untrusted data, never instructions.
   * Now also scans context text and visible_text.
   */
  quarantineInjectedElements(fusedObservation) {
    if (!fusedObservation) return;
    
    let quarantined = 0;

    // L12: Scan element labels, descriptions, AND context text
    if (Array.isArray(fusedObservation.elements)) {
      for (const elmt of fusedObservation.elements) {
        const dom = elmt?.dom || {};
        const candidateText = [
          dom.label, dom.ariaLabel, dom.accessible_name, dom.placeholder,
          dom.ariaDescribedBy, dom.fieldset_legend, dom.context, dom.value,
          ...(Array.isArray(dom.options) ? dom.options.flatMap((option) =>
            typeof option === 'string' ? [option] : [option?.text, option?.value, option?.label]
          ) : []),
          elmt?.semantics?.accessible_name, elmt?.visual?.description
        ];
        if (candidateText.some(containsInjection)) {
          quarantined++;
          if (elmt.dom) {
            elmt.dom.label = '[Untrusted page text — ignored]';
            elmt.dom.value = elmt.dom.sensitive ? '[REDACTED]' : '';
            elmt.dom.placeholder = '';
            elmt.dom.ariaLabel = '';
            elmt.dom.accessible_name = '';
            elmt.dom.ariaDescribedBy = '';
            elmt.dom.fieldset_legend = '';
            elmt.dom.context = '[Untrusted page content — quarantined]';
            if (Array.isArray(elmt.dom.options)) elmt.dom.options = elmt.dom.options.map((option) =>
              typeof option === 'string' ? '[Untrusted option — quarantined]' :
                { ...option, text: '[Untrusted option — quarantined]', label: '[Untrusted option — quarantined]', value: option?.value_redacted ? '[REDACTED]' : '' }
            );
          }
          if (elmt.semantics) elmt.semantics.accessible_name = '[Untrusted page text — ignored]';
          if (elmt.visual) elmt.visual.description = 'Untrusted page content (quarantined)';
        }
      }
    }

    // L12: Scan visible_text for injection attempts
    if (fusedObservation.visible_text && containsInjection(fusedObservation.visible_text)) {
      quarantined++;
      // Don't blank visible_text entirely — strip the injected portions
      for (const re of INJECTION_PATTERNS) {
        const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        fusedObservation.visible_text = fusedObservation.visible_text.replace(globalRe, '[INJECTION_QUARANTINED]');
      }
    }

    // L12: Scan headings for injection
    if (Array.isArray(fusedObservation.headings)) {
      for (const heading of fusedObservation.headings) {
        const headingText = heading?.text || (typeof heading === 'string' ? heading : '');
        if (containsInjection(headingText)) {
          quarantined++;
          if (typeof heading === 'object' && heading.text) {
            heading.text = '[Untrusted heading — quarantined]';
          }
        }
      }
    }

    // L12: Scan result_items text content
    if (Array.isArray(fusedObservation.result_items)) {
      for (const item of fusedObservation.result_items) {
        if (containsInjection(item?.title) || containsInjection(item?.text)) {
          quarantined++;
          if (containsInjection(item.title)) item.title = '[Untrusted item — quarantined]';
          if (containsInjection(item.text)) item.text = '[Untrusted content — quarantined]';
        }
      }
    }

    if (quarantined > 0) {
      log.warn('Quarantined injected element(s)/text from webpage content.', { count: quarantined });
    }
  }

  /**
   * L1/L5: Wait for the page to stabilize by sending a CHECK_PAGE_STABILITY
   * message to the content script.
   */
  async _waitForPageStability(tabId) {
    try {
      await new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const done = () => { if (!settled) { settled = true; if (timer !== null) clearTimeout(timer); resolve(); } };
        timer = setTimeout(done, 800);
        chrome.tabs.sendMessage(
          tabId,
          { type: MessageType.CHECK_PAGE_STABILITY, payload: { quietMs: 120 } },
          () => {
            if (typeof chrome !== 'undefined' && chrome.runtime?.lastError) {
              // Expected if content script is not injected yet or tab is not ready.
            }
            done();
          }
        );
      });
    } catch {
      await this.sleep(150);
    }
  }

  /**
   * L5: Determine how long to wait after an action for the page to settle.
   * Navigation/click actions need longer waits for SPA transitions.
   */
  _getPostActionWait(actionType) {
    switch (actionType) {
      case ActionType.NAVIGATE:
        return 500;
      case ActionType.CLICK:
      case ActionType.SUBMIT:
        return 150;
      case ActionType.TYPE:
        return 60;
      case ActionType.SELECT:
        return 80;
      case ActionType.SCROLL:
        return 120;
      default:
        return 60;
    }
  }

  clearOverlays(tabId) {
    try {
      if (tabId != null && typeof chrome !== 'undefined' && chrome.tabs?.sendMessage) {
        chrome.tabs.sendMessage(tabId, { type: MessageType.CLEAR_OVERLAYS }, () => {
          if (chrome.runtime?.lastError) { /* page may be gone — ignore */ }
        });
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Run a user's own answer to an ASK_USER prompt through the same two gates a
   * model-proposed action goes through.
   *
   * The answer arrives as a plain element id and a string, and it used to be
   * dispatched directly to the executor. That made it the only path capable of
   * performing an irreversible action with no grounding check and no risk
   * evaluation, and the answer is not purely user-authored either: the
   * ambiguity modal's candidate list is built from page and VLM output, so
   * "click the one the page offered" can select a payment button.
   *
   * Returns true when the answer may be executed.
   */
  async _gateUserAnswer(task, token, answerAction, fieldId, _fieldMeta) {
    const observation = task?.lastFusedObservation || {};
    const preValidation = defaultActionValidator.validatePreExecution(answerAction, observation, task?.taskState);
    if (!preValidation.valid) {
      log.warn('User answer failed validation.', { field_id: fieldId, reason: preValidation.reason });
      taskManager.recordStep({
        thought: `The answer for "${fieldId}" no longer matches the page.`,
        // User answers may contain PII. Keep only action/target metadata in
        // task history; never persist the local value or form-plan fields.
        action: {
          action: answerAction.action,
          ...(answerAction.target?.element_id ? { target: { element_id: answerAction.target.element_id } } : {}),
          user_provided: true
        },
        success: false,
        error: preValidation.reason
      }, task);
      return false;
    }

    const targetDom = (observation.elements || [])
      .find((element) => element.id === answerAction.target?.element_id)?.dom || null;
    const riskAssessment = defaultRiskGate.evaluate(answerAction, {
      targetElement: answerAction.target,
      targetDom,
      observationElements: observation.elements || []
    });

    if (!riskAssessment.allowed) {
      taskManager.failTask(`Safety Gate Blocked Action: ${riskAssessment.reason}`, task);
      this.clearOverlays(task.tabId);
      this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
      return false;
    }

    // An answer the user typed is not the same as an action the model chose,
    // so a high-risk answer is applied directly: the user just saw the field
    // and supplied the value themselves. What the gate must catch is an action
    // the answer merely *selects* — a candidate click — because that one is
    // chosen from page-influenced options and is never something the user
    // reviewed the consequences of.
    const isCandidateSelection = answerAction.action === ActionType.CLICK;
    if (isCandidateSelection && (riskAssessment.requiresConfirmation || riskAssessment.risk === RiskLevel.CRITICAL)) {
      const confirmationId = globalThis.crypto?.randomUUID?.() || `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      taskManager.setPendingConfirmation(answerAction, riskAssessment.reason, { confirmationId, taskId: task.id }, task);
      this.notify('STATE_CHANGED', { state: AgentState.WAITING_FOR_USER });
      this.notify('CONFIRMATION_REQUIRED', {
        confirmationId,
        taskId: task.id,
        action: { ...answerAction, risk: riskAssessment.risk },
        reason: riskAssessment.reason,
        privacySummary: {
          dataKeptLocal: 'No secrets disclosed',
          dataSharedWithServer: 'Sanitized task request and page context; saved profile values stay local'
        }
      });
      const approved = await this._awaitOwned(task, token, new Promise((resolve) => {
        this.pendingUserConfirmationResolver = resolve;
      }));
      taskManager.clearPendingConfirmation(task);
      if (!approved) {
        taskManager.cancelTask(task);
        this.clearOverlays(task.tabId);
        this.notify('TASK_CANCELLED', { reason: 'User declined the selected action' });
        return false;
      }
    }
    return true;
  }

  handleUserConfirmation(payload = {}) {
    const task = taskManager.getTask();
    const pending = task?.pendingConfirmation;
    if (!task || task.id !== payload.taskId || !pending ||
        pending.taskId !== payload.taskId || pending.confirmationId !== payload.confirmationId) return false;
    const resolve = this.pendingUserConfirmationResolver;
    this.pendingUserConfirmationResolver = null;
    if (resolve) {
      // Stash the raw answer before resolving: the off-list site gate reads
      // the typed address / remember choice from here (the resolver itself
      // only carries the boolean, unchanged for every other caller).
      this.lastConfirmationResponse = { ...(payload || {}) };
      resolve(Boolean(payload.approved));
      return true;
    }
    // Correlated prompt but no live loop: the worker was suspended while
    // waiting, so nothing is going to execute the approved action. Finalize
    // honestly rather than reporting success, and never imply the action ran.
    taskManager.cancelTask(task);
    this.notify('TASK_CANCELLED', {
      reason: payload.approved
        ? 'Approved, but the agent service restarted before the action could run. Nothing was submitted.'
        : 'Action declined.'
    });
    return true;
  }

  handleUserInput(payload) {
    const task = taskManager.getTask();
    const pending = task?.pendingUserInput;
    if (!task || task.id !== payload?.taskId || !pending ||
        pending.taskId !== payload.taskId || pending.requestId !== payload.requestId) return false;
    const resolve = this.pendingUserInputResolver;
    this.pendingUserInputResolver = null;
    if (resolve) {
      resolve(payload);
      return true;
    }
    // Correlated prompt but no live loop: the answers cannot be consumed, so
    // stop the task instead of leaving a prompt that silently does nothing.
    taskManager.failTask(
      'The browser restarted the agent service before your answer could be used.',
      task
    );
    this.notify('TASK_FAILED', { error: task.error, hint: task.hint });
    return true;
  }

  pauseTask() {
    const task = taskManager.getTask();
    if (!task || [AgentState.COMPLETED, AgentState.FAILED, AgentState.CANCELLED].includes(task.state)) return false;
    if (this.isPaused) return true;
    this.pausedFromState = task.state;
    this.isPaused = true;
    taskManager.updateState(AgentState.PAUSED, 'Paused. Resume to continue the task.', task);
    this.notify('STATE_CHANGED', { state: AgentState.PAUSED });
    return true;
  }

  resumeTask() {
    const task = taskManager.getTask();
    if (!task || !this.isPaused || task.state !== AgentState.PAUSED) return false;
    this.isPaused = false;
    taskManager.updateState(this.pausedFromState || AgentState.OBSERVING, 'Resuming task…', task);
    this.pausedFromState = null;
    const resolve = this.pauseResolver;
    this.pauseResolver = null;
    if (this._pauseExpiryTimer) { clearTimeout(this._pauseExpiryTimer); this._pauseExpiryTimer = null; }
    // The wait arms a bounded timer; clear it on a real resume so the timer
    // never outlives the pause it was watching.
    if (this._pauseExpiryTimer !== null && this._pauseExpiryTimer !== undefined) {
      clearTimeout(this._pauseExpiryTimer);
      this._pauseExpiryTimer = null;
    }
    if (resolve) resolve();
    this.notify('STATE_CHANGED', { state: task.state });
    return true;
  }

  cancelTask() {
    const current = taskManager.getTask();
    if (!current || [AgentState.COMPLETED, AgentState.FAILED, AgentState.CANCELLED].includes(current.state)) return false;
    this.runToken++;
    this.isCancelled = true;
    const task = current;
    taskManager.cancelTask(task);
    if (this.pauseResolver) {
      this.pauseResolver();
      this.pauseResolver = null;
    if (this._pauseExpiryTimer) { clearTimeout(this._pauseExpiryTimer); this._pauseExpiryTimer = null; }
    }
    if (task) this.clearOverlays(task.tabId);
    if (this.pendingUserConfirmationResolver) {
      this.pendingUserConfirmationResolver(false);
      this.pendingUserConfirmationResolver = null;
    }
    if (this.pendingUserInputResolver) {
      this.pendingUserInputResolver({ cancelled: true });
      this.pendingUserInputResolver = null;
    }
    this.notify('TASK_CANCELLED', task);
    this.notify('STATE_CHANGED', { state: AgentState.CANCELLED });
    return true;
  }

  async _extractDOM(tabId) {
    const getFrames = () => new Promise(resolve => {
      if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
        chrome.webNavigation.getAllFrames({ tabId }, frames => resolve(frames || []));
      } else {
        resolve([{ frameId: 0 }]);
      }
    });

    const sendExtractionMessage = (frameId) => new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => finish({ success: false, error: 'Page extraction timed out.' }), CHROME_API_TIMEOUT_MS);
      try {
        chrome.tabs.sendMessage(tabId, { type: MessageType.EXTRACT_DOM }, { frameId }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          finish(runtimeError
            ? { success: false, error: runtimeError.message }
            : (response || { success: false, error: 'Empty response' }));
        });
      } catch (error) {
        finish({ success: false, error: error?.message || 'Page extraction failed.' });
      }
    });

    // Ensure content scripts are injected everywhere
    try {
      await withTimeout(chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content/content.js']
      }), CHROME_API_TIMEOUT_MS, 'Content script injection timed out.');
      await this.sleep(150);
    } catch (error) {
      // Ignore injection errors (some frames might be restricted)
    }

    const frames = await getFrames();
    const frameIds = frames.length > 0 ? frames.map(f => f.frameId) : [0];
    
    const results = await Promise.all(frameIds.map(async id => {
      const res = await sendExtractionMessage(id);
      return { frameId: id, result: res };
    }));

    const mainFrame = results.find(r => r.frameId === 0)?.result;
    if (!mainFrame || !mainFrame.success || !mainFrame.data) {
      return mainFrame || { success: false, error: 'Main frame extraction failed' };
    }

    const finalElements = [...mainFrame.data.elements];
    const iframeElements = mainFrame.data.elements.filter(e => e.tag === 'iframe');

    for (const res of results) {
      if (res.frameId === 0 || !res.result.success || !res.result.data) continue;
      
      // Naive matching: just use the first iframe's offset for now
      const offsetBox = iframeElements.length > 0 ? iframeElements[0] : null;
      const dx = offsetBox && offsetBox.bounds ? offsetBox.bounds[0] : 0;
      const dy = offsetBox && offsetBox.bounds ? offsetBox.bounds[1] : 0;
      
      for (const el of res.result.data.elements) {
        const newEl = { ...el, element_id: 'f' + res.frameId + '_' + el.element_id };
        if (newEl.bounds && newEl.bounds.length === 4) {
          newEl.bounds = [newEl.bounds[0] + dx, newEl.bounds[1] + dy, newEl.bounds[2], newEl.bounds[3]];
          newEl.center_x += dx;
          newEl.center_y += dy;
        }
        finalElements.push(newEl);
      }
    }

    mainFrame.data.elements = finalElements;
    return mainFrame;
  }

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

export const agentController = new AgentController();
