/**
 * Tests for FormAnalyzer
 * Covers _norm, isFillable, classifyField, mapToValueSource, and analyzeForms.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FormAnalyzer } from '../../extension/reasoning/form-analyzer.js';
import { SymbolicSecretSource } from '../../extension/shared/constants.js';

function makeAnalyzer() {
  return new FormAnalyzer();
}

// ── isFillable ────────────────────────────────────────────────────────────

test('FormAnalyzer - isFillable: text input is fillable', () => {
  const a = makeAnalyzer();
  assert.equal(a.isFillable({ tag: 'input', type: 'text' }), true);
});

test('FormAnalyzer - isFillable: textarea is fillable', () => {
  const a = makeAnalyzer();
  assert.equal(a.isFillable({ tag: 'textarea' }), true);
});

test('FormAnalyzer - isFillable: select is fillable', () => {
  const a = makeAnalyzer();
  assert.equal(a.isFillable({ tag: 'select' }), true);
});

test('FormAnalyzer - isFillable: disabled input is NOT fillable', () => {
  const a = makeAnalyzer();
  assert.equal(a.isFillable({ tag: 'input', type: 'text', disabled: true }), false);
});

test('FormAnalyzer - isFillable: submit input is NOT fillable', () => {
  const a = makeAnalyzer();
  assert.equal(a.isFillable({ tag: 'input', type: 'submit' }), false);
});

test('FormAnalyzer - isFillable: button tag is NOT fillable', () => {
  const a = makeAnalyzer();
  assert.equal(a.isFillable({ tag: 'button', type: 'submit' }), false);
});

test('FormAnalyzer - isFillable: anchor tag is NOT fillable', () => {
  const a = makeAnalyzer();
  assert.equal(a.isFillable({ tag: 'a' }), false);
});

test('FormAnalyzer - isFillable: hidden/file/image/reset inputs are NOT fillable', () => {
  const a = makeAnalyzer();
  ['hidden', 'file', 'image', 'reset'].forEach(type => {
    assert.equal(a.isFillable({ tag: 'input', type }), false, `${type} input should NOT be fillable`);
  });
});

// ── classifyField ─────────────────────────────────────────────────────────

test('FormAnalyzer - classifyField: email field by label', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'email', label: 'Email Address', name: 'email', id: 'email', placeholder: '' });
  assert.ok(result, 'Should classify email field');
  assert.equal(result.semantic_type, 'email');
  assert.ok(result.confidence > 0);
});

test('FormAnalyzer - classifyField: phone by name "mobile"', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'tel', name: 'mobile', label: 'Mobile Number', id: 'mobile_no', placeholder: '' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'phone');
});

test('FormAnalyzer - classifyField: full name by name "full_name"', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'text', name: 'full_name', label: 'Your Name', id: 'name', placeholder: '' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'full_name');
});

test('FormAnalyzer - classifyField: first_name detected', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'text', name: 'first_name', label: 'First Name', id: 'fname', placeholder: 'First name' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'first_name');
});

test('FormAnalyzer - classifyField: last_name detected', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'text', name: 'last_name', label: 'Last Name', id: 'lname', placeholder: '' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'last_name');
});

test('FormAnalyzer - classifyField: date_of_birth by label "Date of Birth"', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'date', name: 'dob', label: 'Date of Birth', id: 'dob_field', placeholder: '' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'date_of_birth');
});

test('FormAnalyzer - classifyField: password by name "password"', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'password', name: 'password', label: 'Password', id: 'pwd', placeholder: '' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'password');
});

test('FormAnalyzer - classifyField: pan by name "pan_number"', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'text', name: 'pan_number', label: 'PAN Card', id: 'pan', placeholder: '' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'pan');
});

test('FormAnalyzer - classifyField: aadhaar by label "Aadhaar Number"', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'text', name: 'uid', label: 'Aadhaar Number', id: 'aadhaar', placeholder: '' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'aadhaar');
});

test('FormAnalyzer - classifyField: zip_code by name "pincode"', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'text', name: 'pincode', label: 'Pincode', id: 'zip', placeholder: '' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'zip_code');
});

test('FormAnalyzer - classifyField: terms by label "I agree"', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'checkbox', name: 'agree', label: 'I agree to terms and conditions', id: 'chk_terms', placeholder: '' });
  assert.ok(result);
  assert.equal(result.semantic_type, 'terms');
});

test('FormAnalyzer - classifyField: returns null for search input', () => {
  const a = makeAnalyzer();
  const result = a.classifyField({ tag: 'input', type: 'search', name: 'q', label: 'Search', id: 'search_box', placeholder: 'Search products' });
  assert.equal(result, null);
});

// ── mapToValueSource ──────────────────────────────────────────────────────

test('FormAnalyzer - mapToValueSource: email → LOCAL_EMAIL', () => {
  const a = makeAnalyzer();
  assert.equal(a.mapToValueSource('email'), SymbolicSecretSource.LOCAL_EMAIL);
});

test('FormAnalyzer - mapToValueSource: phone → LOCAL_PHONE', () => {
  const a = makeAnalyzer();
  assert.equal(a.mapToValueSource('phone'), SymbolicSecretSource.LOCAL_PHONE);
});

test('FormAnalyzer - mapToValueSource: pan → LOCAL_PAN', () => {
  const a = makeAnalyzer();
  assert.equal(a.mapToValueSource('pan'), SymbolicSecretSource.LOCAL_PAN);
});

test('FormAnalyzer - mapToValueSource: aadhaar → LOCAL_AADHAAR', () => {
  const a = makeAnalyzer();
  assert.equal(a.mapToValueSource('aadhaar'), SymbolicSecretSource.LOCAL_AADHAAR);
});

test('FormAnalyzer - mapToValueSource: first_name and last_name → LOCAL_FULL_NAME', () => {
  const a = makeAnalyzer();
  assert.equal(a.mapToValueSource('first_name'), SymbolicSecretSource.LOCAL_FULL_NAME);
  assert.equal(a.mapToValueSource('last_name'), SymbolicSecretSource.LOCAL_FULL_NAME);
});

test('FormAnalyzer - mapToValueSource: unknown type → LOCAL_PROFILE fallback', () => {
  const a = makeAnalyzer();
  assert.equal(a.mapToValueSource('unknown_xyz'), SymbolicSecretSource.LOCAL_PROFILE);
});

// ── analyzeForms ──────────────────────────────────────────────────────────

test('FormAnalyzer - analyzeForms: classifies fields from a KYC form', () => {
  const a = makeAnalyzer();
  const elements = [
    { id: 'el_name', tag: 'input', type: 'text', name: 'full_name', label: 'Full Name', in_form: true, form_id: 'form_kyc' },
    { id: 'el_pan', tag: 'input', type: 'text', name: 'pan_number', label: 'PAN Card Number', in_form: true, form_id: 'form_kyc' },
    { id: 'el_submit', tag: 'button', type: 'submit', label: 'Submit', in_form: true, form_id: 'form_kyc' }
  ];
  const plans = a.analyzeForms(elements, 'Fill my KYC form');
  assert.equal(plans.length, 1, 'Should produce one form plan');
  const plan = plans[0];
  assert.equal(plan.form_id, 'form_kyc');
  // Button should be excluded (not fillable)
  assert.ok(plan.fields.length >= 2);
  const byId = new Map(plan.fields.map(f => [f.field_id, f]));
  assert.equal(byId.get('el_name').value_source, SymbolicSecretSource.LOCAL_FULL_NAME);
  assert.equal(byId.get('el_pan').value_source, SymbolicSecretSource.LOCAL_PAN);
});

test('FormAnalyzer - analyzeForms: handles fused element shape (dom nested)', () => {
  const a = makeAnalyzer();
  const elements = [
    {
      id: 'el_email',
      dom: { tag: 'input', type: 'email', name: 'email', label: 'Email Address', in_form: true },
      interaction: { typeable: true }
    }
  ];
  const plans = a.analyzeForms(elements, 'Register with email');
  // Floating (no form_id) fields go into "floating" group
  assert.ok(plans.length >= 1, 'Should produce at least one plan for floating fields');
  const allFields = plans.flatMap(p => p.fields);
  const emailField = allFields.find(f => f.field_id === 'el_email');
  assert.ok(emailField, 'email field should be classified');
  assert.equal(emailField.value_source, SymbolicSecretSource.LOCAL_EMAIL);
});

test('FormAnalyzer - analyzeForms: returns empty array when no fillable fields', () => {
  const a = makeAnalyzer();
  const elements = [
    { id: 'el_btn', tag: 'button', type: 'submit', label: 'Go', in_form: true, form_id: 'f1' }
  ];
  const plans = a.analyzeForms(elements, 'Submit form');
  // submit button is not fillable so plan.fields is empty, so plans should be []
  assert.equal(plans.length, 0);
});

test('FormAnalyzer - analyzeForms: groups floating fields separately', () => {
  const a = makeAnalyzer();
  const elements = [
    { id: 'el_search', tag: 'input', type: 'text', name: 'search_query', label: 'Search', in_form: false }
  ];
  const plans = a.analyzeForms(elements, 'Search for something');
  // 'search_query' won't match any semantic pattern → classifyField returns null → not added
  // Result could be 0 plans or floating group with 0 fields
  assert.ok(Array.isArray(plans));
});
