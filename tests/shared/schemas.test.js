/**
 * Tests for shared/schemas.js
 * Covers validateAction, validateSanitizedElement, validateVisionPayload,
 * validateReasonPayload, and ValidationError class.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAction,
  validateSanitizedElement,
  validateVisionPayload,
  validateReasonPayload,
  ValidationError
} from '../../extension/shared/schemas.js';
import { ActionType, RiskLevel, SymbolicSecretSource } from '../../extension/shared/constants.js';

// ── ValidationError class ─────────────────────────────────────────────────

test('ValidationError - has correct name and details', () => {
  const e = new ValidationError('bad action', { key: 'val' });
  assert.equal(e.name, 'ValidationError');
  assert.equal(e.message, 'bad action');
  assert.deepEqual(e.details, { key: 'val' });
  assert.ok(e instanceof Error);
  assert.ok(e instanceof ValidationError);
});

// ── validateAction: valid actions ─────────────────────────────────────────

test('validateAction - accepts valid CLICK with element_id', () => {
  const action = { action: 'CLICK', target: { element_id: 'el_1' } };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts CLICK with coordinates', () => {
  const action = { action: 'CLICK', target: { coordinates: { x: 100, y: 200 } } };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts DONE (no target required)', () => {
  const action = { action: 'DONE' };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts WAIT (no target required)', () => {
  const action = { action: 'WAIT' };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts NAVIGATE (no target required)', () => {
  const action = { action: 'NAVIGATE' };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts SCROLL (no target required)', () => {
  const action = { action: 'SCROLL' };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts TYPE with value', () => {
  const action = { action: 'TYPE', target: { element_id: 'el_2' }, value: 'hello' };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts TYPE with value_source (valid symbolic source)', () => {
  const action = { action: 'TYPE', target: { element_id: 'el_3' }, value_source: SymbolicSecretSource.LOCAL_AADHAAR };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts SUBMIT with element_id', () => {
  const action = { action: 'SUBMIT', target: { element_id: 'el_submit' } };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts UPLOAD with element_id', () => {
  const action = { action: 'UPLOAD', target: { element_id: 'el_file' } };
  assert.equal(validateAction(action), true);
});

test('validateAction - accepts SELECT with element_id', () => {
  const action = { action: 'SELECT', target: { element_id: 'el_sel' } };
  assert.equal(validateAction(action), true);
});

// ── validateAction: default risk assignment ───────────────────────────────

test('validateAction - assigns LOW risk when not provided', () => {
  const action = { action: 'CLICK', target: { element_id: 'el_1' } };
  validateAction(action);
  assert.equal(action.risk, RiskLevel.LOW);
});

test('validateAction - preserves existing valid risk', () => {
  const action = { action: 'SUBMIT', target: { element_id: 'el_1' }, risk: RiskLevel.HIGH };
  validateAction(action);
  assert.equal(action.risk, RiskLevel.HIGH);
});

test('validateAction - assigns requires_confirmation=true for HIGH risk', () => {
  const action = { action: 'SUBMIT', target: { element_id: 'el_1' }, risk: RiskLevel.HIGH };
  validateAction(action);
  assert.equal(action.requires_confirmation, true);
});

test('validateAction - preserves explicit requires_confirmation=false', () => {
  const action = { action: 'CLICK', target: { element_id: 'el_1' }, requires_confirmation: false };
  validateAction(action);
  assert.equal(action.requires_confirmation, false);
});

// ── validateAction: error cases ───────────────────────────────────────────

test('validateAction - throws on null input', () => {
  assert.throws(() => validateAction(null), ValidationError);
});

test('validateAction - throws on non-object input', () => {
  assert.throws(() => validateAction('CLICK'), ValidationError);
});

test('validateAction - throws on invalid action type', () => {
  assert.throws(() => validateAction({ action: 'HACK' }), /Invalid action type/);
});

test('validateAction - throws on missing action field', () => {
  assert.throws(() => validateAction({ target: { element_id: 'el_1' } }), ValidationError);
});

test('validateAction - throws if CLICK has no target', () => {
  assert.throws(() => validateAction({ action: 'CLICK' }), ValidationError);
});

test('validateAction - throws if CLICK target has neither element_id nor coordinates', () => {
  assert.throws(() => validateAction({ action: 'CLICK', target: { label: 'Button' } }), ValidationError);
});

test('validateAction - throws if TYPE has neither value nor value_source', () => {
  assert.throws(
    () => validateAction({ action: 'TYPE', target: { element_id: 'el_1' } }),
    /requires either value or value_source/
  );
});

test('validateAction - throws if TYPE has invalid value_source', () => {
  assert.throws(
    () => validateAction({ action: 'TYPE', target: { element_id: 'el_1' }, value_source: 'FAKE_SOURCE' }),
    /Invalid value_source/
  );
});

test('validateAction - throws on eval field (security violation)', () => {
  assert.throws(
    () => validateAction({ action: 'CLICK', target: { element_id: 'el_1' }, eval: 'document.cookie' }),
    /Security violation|Arbitrary script/
  );
});

test('validateAction - throws on script field (security violation)', () => {
  assert.throws(
    () => validateAction({ action: 'CLICK', target: { element_id: 'el_1' }, script: 'alert(1)' }),
    /Security violation|Arbitrary script/
  );
});

test('validateAction - throws on function field (security violation)', () => {
  assert.throws(
    () => validateAction({ action: 'CLICK', target: { element_id: 'el_1' }, function: 'malicious' }),
    /Security violation|Arbitrary script/
  );
});

// ── validateSanitizedElement ───────────────────────────────────────────────

test('validateSanitizedElement - accepts valid non-sensitive element', () => {
  const el = { id: 'el_1', tag: 'input', sensitive: false };
  assert.equal(validateSanitizedElement(el), true);
});

test('validateSanitizedElement - accepts sensitive element with [REDACTED] value', () => {
  const el = { id: 'el_2', tag: 'input', sensitive: true, value: '[REDACTED]' };
  assert.equal(validateSanitizedElement(el), true);
});

test('validateSanitizedElement - throws if sensitive element has unredacted value', () => {
  const el = { id: 'el_3', tag: 'input', sensitive: true, value: 'ABCDE1234F' };
  assert.throws(() => validateSanitizedElement(el), /unredacted value/);
});

test('validateSanitizedElement - returns false for null', () => {
  assert.equal(validateSanitizedElement(null), false);
});

test('validateSanitizedElement - returns false if id is missing', () => {
  assert.equal(validateSanitizedElement({ tag: 'input' }), false);
});

test('validateSanitizedElement - returns false if tag is missing', () => {
  assert.equal(validateSanitizedElement({ id: 'el_1' }), false);
});

// ── validateVisionPayload ──────────────────────────────────────────────────

test('validateVisionPayload - accepts valid payload', () => {
  const payload = {
    task_id: 'task_1',
    sanitized_screenshot: 'data:image/png;base64,...',
    sanitized_dom: { elements: [{ id: 'el_1', tag: 'button' }] }
  };
  assert.equal(validateVisionPayload(payload), true);
});

test('validateVisionPayload - throws if task_id missing', () => {
  assert.throws(
    () => validateVisionPayload({ sanitized_screenshot: 'x', sanitized_dom: { elements: [] } }),
    /missing task_id/
  );
});

test('validateVisionPayload - throws if sanitized_screenshot missing', () => {
  assert.throws(
    () => validateVisionPayload({ task_id: 'task_1', sanitized_dom: { elements: [] } }),
    /missing sanitized_screenshot/
  );
});

test('validateVisionPayload - throws if sanitized_dom.elements not array', () => {
  assert.throws(
    () => validateVisionPayload({ task_id: 'task_1', sanitized_screenshot: 'x', sanitized_dom: { elements: 'nope' } }),
    /missing sanitized_dom elements/
  );
});

// ── validateReasonPayload ──────────────────────────────────────────────────

test('validateReasonPayload - accepts valid payload', () => {
  const payload = {
    task: 'Find cheapest laptop',
    fused_observation: { elements: [] }
  };
  assert.equal(validateReasonPayload(payload), true);
});

test('validateReasonPayload - throws if task missing', () => {
  assert.throws(
    () => validateReasonPayload({ fused_observation: {} }),
    /missing user task prompt/
  );
});

test('validateReasonPayload - throws if fused_observation missing', () => {
  assert.throws(
    () => validateReasonPayload({ task: 'Buy something' }),
    /missing fused_observation/
  );
});
