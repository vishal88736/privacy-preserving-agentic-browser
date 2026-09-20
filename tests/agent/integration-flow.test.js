import test from 'node:test';
import assert from 'node:assert';
import { GPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { ActionType, RiskLevel, SymbolicSecretSource } from '../../extension/shared/constants.js';

test('Integration - Multi-step Aadhaar form filling scenario', async () => {
  const client = new GPTOSSClient('http://127.0.0.1:9999');

  // Step 1: Provide observation with Aadhaar, PAN, Name, DOB, Phone and Submit button
  const fusedObservation = {
    elements: [
      { id: 'el_1', dom: { tag: 'input', name: 'full_name', label: 'Full Name', sensitive: false } },
      { id: 'el_2', dom: { tag: 'input', name: 'aadhaar_number', label: 'Aadhaar Number', sensitive: true, value_source: SymbolicSecretSource.LOCAL_AADHAAR } },
      { id: 'el_3', dom: { tag: 'input', name: 'pan_number', label: 'PAN Card', sensitive: true, value_source: SymbolicSecretSource.LOCAL_PAN } },
      { id: 'el_4', dom: { tag: 'input', name: 'dob', label: 'Date of Birth', sensitive: false } },
      { id: 'el_5', dom: { tag: 'input', name: 'phone', label: 'Registered Mobile', sensitive: false } },
      { id: 'el_6', dom: { tag: 'button', type: 'submit', label: 'Submit Application' } }
    ]
  };

  const task = 'Fill this Aadhaar application using my saved profile';
  const history = [];

  // Step 1: bulk form plan (FormAnalyzer now handles fused {dom} shape).
  // Must contain all fillable fields with correct symbolic sources and
  // require confirmation because Aadhaar/PAN are sensitive.
  const step1 = await client.planNextStep(task, fusedObservation, history);
  assert.strictEqual(step1.action.action, ActionType.FILL_FORM_PLAN);
  assert.ok(step1.action.requires_confirmation === true, 'Sensitive bulk plan must require confirmation');
  assert.ok(step1.action.risk === RiskLevel.HIGH || step1.action.risk === RiskLevel.MEDIUM);
  const byId = new Map((step1.action.value.fields || []).map((f) => [f.field_id, f]));
  assert.strictEqual(byId.get('el_1')?.value_source, SymbolicSecretSource.LOCAL_FULL_NAME);
  assert.strictEqual(byId.get('el_2')?.value_source, SymbolicSecretSource.LOCAL_AADHAAR);
  assert.strictEqual(byId.get('el_3')?.value_source, SymbolicSecretSource.LOCAL_PAN);
  history.push({ step: 1, action: step1.action, success: true });

  // After the bulk plan is executed, the next step must be Submit with confirmation
  const submitStep = await client.planNextStep(task, fusedObservation, history);
  assert.strictEqual(submitStep.action.action, ActionType.SUBMIT);
  assert.strictEqual(submitStep.action.target.element_id, 'el_6');
  assert.strictEqual(submitStep.action.risk, RiskLevel.HIGH);
  assert.strictEqual(submitStep.action.requires_confirmation, true);
});

test('Integration - Document Upload scenario', async () => {
  const client = new GPTOSSClient('http://127.0.0.1:9999');
  const fusedObservation = {
    elements: [
      { id: 'el_upload', dom: { tag: 'input', type: 'file', label: 'Upload Identity PDF' }, interaction: { uploadable: true } }
    ]
  };

  const uploadStep = await client.planNextStep('Upload my Aadhaar PDF', fusedObservation, []);
  assert.strictEqual(uploadStep.action.action, ActionType.UPLOAD);
  assert.strictEqual(uploadStep.action.target.element_id, 'el_upload');
  assert.strictEqual(uploadStep.action.value_source, SymbolicSecretSource.LOCAL_DOCUMENT);
  assert.strictEqual(uploadStep.action.requires_confirmation, true);
});

test('Integration - Flight Search comparison scenario', async () => {
  const client = new GPTOSSClient('http://127.0.0.1:9999');
  const fusedObservation = {
    elements: [
      { id: 'el_from', dom: { tag: 'input', label: 'Origin City (From)' } },
      { id: 'el_to', dom: { tag: 'input', label: 'Destination City (To)' } },
      { id: 'el_search', dom: { tag: 'button', label: 'Search Flights' } }
    ]
  };

  const step1 = await client.planNextStep('Find the cheapest flight from Pune to Delhi', fusedObservation, []);
  assert.strictEqual(step1.action.action, ActionType.TYPE);
  assert.strictEqual(step1.action.target.element_id, 'el_from');
  assert.strictEqual(step1.action.value, 'Pune');
});
