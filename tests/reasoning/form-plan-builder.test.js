import test from 'node:test';
import assert from 'node:assert/strict';
import { FormAnalyzer } from '../../extension/reasoning/form-analyzer.js';
import { FormPlanBuilder } from '../../extension/reasoning/form-plan-builder.js';
import { LocalValueResolver } from '../../extension/executor/local-value-resolver.js';
import { GPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { ActionType } from '../../extension/shared/constants.js';

class MemoryVault {
  constructor(values = {}) { this.values = { ...values }; }
  resolveSecret(source) { return this.values[source] || null; }
}

function builder(values = {}) {
  return new FormPlanBuilder(new FormAnalyzer(), new LocalValueResolver(new MemoryVault(values)));
}

const PROFILE = {
  LOCAL_FULL_NAME: 'Synthetic Profile User',
  LOCAL_EMAIL: 'synthetic.form@example.invalid',
  LOCAL_PHONE: '9000000000',
  LOCAL_DOB: '01/01/1990',
  LOCAL_ADDRESS: 'Synthetic Road, Example City, California 90001',
  LOCAL_COUNTRY: 'India',
  LOCAL_GENDER: 'Male',
  LOCAL_TERMS: 'yes'
};

function field(id, tag, type, name, label, extra = {}) {
  return {
    id,
    dom: {
      tag, type, name, label, in_form: true, form_id: 'profile_form',
      value: '', checked: false, ...extra
    }
  };
}

function mixedForm(overrides = {}) {
  return [
    field('el_name', 'input', 'text', 'first_name', 'First name', overrides.name || {}),
    field('el_email', 'input', 'email', 'email', 'Email', overrides.email || {}),
    field('el_phone', 'input', 'tel', 'phone', 'Phone', overrides.phone || {}),
    field('el_dob', 'input', 'date', 'dob', 'Date of birth', overrides.dob || {}),
    field('el_address', 'textarea', '', 'address', 'Street address', overrides.address || {}),
    field('el_country', 'select', '', 'country', 'Country', {
      options: [
        { value: '', text: 'Choose…', selected: true },
        { value: 'us', text: 'United States of America', selected: false },
        { value: 'in', text: 'India', selected: false }
      ], ...overrides.country
    }),
    field('el_gender_male', 'input', 'radio', 'gender', 'Male', {
      options: [
        { value: 'male', text: 'Male', checked: false },
        { value: 'female', text: 'Female', checked: false }
      ], ...overrides.gender
    }),
    field('el_terms', 'input', 'checkbox', 'terms', 'I agree to the terms', overrides.terms || {})
  ];
}

test('form plans explicitly map text, email, phone, number, date, textarea, select, radio and checkbox controls', () => {
  const a = new FormAnalyzer();
  const controls = [
    ['text', a.controlType({ tag: 'input', type: 'text' })],
    ['textarea', a.controlType({ tag: 'textarea' })],
    ['email', a.controlType({ tag: 'input', type: 'email' })],
    ['phone', a.controlType({ tag: 'input', type: 'tel' })],
    ['number', a.controlType({ tag: 'input', type: 'number' })],
    ['date', a.controlType({ tag: 'input', type: 'date' })],
    ['select', a.controlType({ tag: 'select' })],
    ['radio', a.controlType({ tag: 'input', type: 'radio' })],
    ['checkbox', a.controlType({ tag: 'input', type: 'checkbox' })]
  ];
  assert.deepEqual(controls.map(([, type]) => type), [
    'TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'NUMBER', 'DATE', 'SELECT', 'RADIO', 'CHECKBOX'
  ]);
});

test('mixed form plan includes known mapped select, radio and checkbox fields with explicit control types', () => {
  const decision = builder(PROFILE).decide(mixedForm(), 'Fill this form using my saved profile, but do not submit it.');
  assert.equal(decision.status, 'REMAINING');
  const fields = decision.action.value.fields;
  const byId = new Map(fields.map((item) => [item.field_id, item]));
  assert.equal(byId.get('el_country').semantic_type, 'country');
  assert.equal(byId.get('el_country').control_type, 'SELECT');
  assert.equal(byId.get('el_country').value_source, 'LOCAL_COUNTRY');
  assert.equal(byId.get('el_gender_male').control_type, 'RADIO');
  assert.equal(byId.get('el_gender_male').value_source, 'LOCAL_GENDER');
  assert.equal(byId.get('el_terms').control_type, 'CHECKBOX');
  assert.equal(byId.get('el_terms').value_source, 'LOCAL_TERMS');
  assert.ok(fields.every((item) => !Object.hasOwn(item, 'value')), 'the plan must not contain resolved profile plaintext');
});

test('already-correct checkbox is not planned for a click', () => {
  const form = [field('el_terms', 'input', 'checkbox', 'terms', 'Agree to terms', { checked: true })];
  const decision = builder({ LOCAL_TERMS: 'yes' }).decide(form, 'Fill the form using my saved profile');
  assert.equal(decision.status, 'COMPLETE');
});

test('wrong checkbox state is planned for correction', () => {
  const form = [field('el_terms', 'input', 'checkbox', 'terms', 'Agree to terms', { checked: false })];
  const decision = builder({ LOCAL_TERMS: 'yes' }).decide(form, 'Fill the form using my saved profile');
  assert.equal(decision.status, 'REMAINING');
  assert.equal(decision.action.value.fields[0].field_id, 'el_terms');
  assert.equal(decision.action.value.fields[0].control_type, 'CHECKBOX');
});

test('missing profile values are reported to the user and are not executed as empty strings', () => {
  const form = [field('el_country', 'select', '', 'country', 'Country', {
    options: [{ value: 'in', text: 'India', selected: false }]
  })];
  const decision = builder().decide(form, 'Fill the form using my saved profile');
  assert.equal(decision.status, 'ASK_USER');
  assert.equal(decision.action.value.ambiguousFields[0].status, 'UNAVAILABLE');
});

test('ambiguous Other and custom preference fields are surfaced instead of guessed', () => {
  const form = [
    field('el_other', 'input', 'text', 'other', 'Other'),
    field('el_preference', 'input', 'text', 'custom_preference', 'Custom preference')
  ];
  const decision = builder(PROFILE).decide(form, 'Fill the form using my saved profile');
  assert.equal(decision.status, 'ASK_USER');
  assert.deepEqual(decision.action.value.ambiguousFields.map((item) => item.semantic_type), ['other', 'other']);
});

test('all known profile fields already completed, including country aliases, produce no further action', () => {
  const form = mixedForm({
    name: { value: '[REDACTED]' },
    email: { value: '[REDACTED]' },
    phone: { value: '[REDACTED]' },
    dob: { value: '[REDACTED]' },
    address: { value: '[REDACTED]' },
    country: { value: 'us', options: [
      { value: '', text: 'Choose…', selected: false },
      { value: 'us', text: 'United States of America', selected: true },
      { value: 'in', text: 'India', selected: false }
    ] },
    gender: { options: [
      { value: 'male', text: 'Male', checked: true },
      { value: 'female', text: 'Female', checked: false }
    ] },
    terms: { checked: true }
  });
  const history = [{
    action: { action: 'FILL_FORM_PLAN' }, success: true,
    result: { details: ['el_name', 'el_email', 'el_phone', 'el_dob', 'el_address'].map((id) => ({ field: id, success: true })) }
  }];
  const decision = builder({ ...PROFILE, LOCAL_COUNTRY: 'USA' }).decide(form, 'Fill the form using my saved profile, but do not submit it.', history);
  assert.equal(decision.status, 'COMPLETE');
});

test('known fields still remaining are returned as actionable work', () => {
  const form = [field('el_country', 'select', '', 'country', 'Country', {
    options: [{ value: '', text: 'Choose…', selected: true }, { value: 'in', text: 'India', selected: false }]
  })];
  const decision = builder(PROFILE).decide(form, 'Fill the form using my saved profile');
  assert.equal(decision.status, 'REMAINING');
  assert.equal(decision.action.value.fields[0].field_id, 'el_country');
});

test('remote DONE cannot bypass a locally resolvable form field', async () => {
  const client = new GPTOSSClient('http://127.0.0.1:1', builder(PROFILE));
  const result = await client.planNextStep(
    'Fill this form using my saved profile, but do not submit it.',
    { elements: [field('el_terms', 'input', 'checkbox', 'terms', 'Agree to terms', { checked: false })] },
    [],
    { intent: 'FILL_FORM', constraints: ['must NOT submit the form'] }
  );
  assert.equal(result.action.action, ActionType.FILL_FORM_PLAN);
  assert.equal(result.action.value.fields[0].field_id, 'el_terms');
  assert.equal(result.remoteCallMade, false);
});

test('user-supplied personal text is excluded from extension request diagnostics', async () => {
  const client = new GPTOSSClient();
  const previousFetch = globalThis.fetch;
  const previousDebug = console.debug;
  const logs = [];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ intent: 'unknown' }) });
  console.debug = (...parts) => logs.push(parts.join(' '));
  try {
    await client.post('/interpret', { task: 'Synthetic name and synthetic.email@example.invalid' });
  } finally {
    globalThis.fetch = previousFetch;
    console.debug = previousDebug;
  }
  assert.doesNotMatch(logs.join('\n'), /Synthetic name|synthetic\.email@example\.invalid/);
});
