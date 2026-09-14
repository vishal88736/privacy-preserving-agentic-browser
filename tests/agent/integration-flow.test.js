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

  // Step 1 plan
  const step1 = await client.planNextStep(task, fusedObservation, history);
  assert.strictEqual(step1.action.action, ActionType.TYPE);
  assert.strictEqual(step1.action.target.element_id, 'el_1');
  assert.strictEqual(step1.action.value_source, SymbolicSecretSource.LOCAL_FULL_NAME);
  history.push({ step: 1, action: step1.action });

  // Step 2 plan (Aadhaar)
  const step2 = await client.planNextStep(task, fusedObservation, history);
  assert.strictEqual(step2.action.action, ActionType.TYPE);
  assert.strictEqual(step2.action.target.element_id, 'el_2');
  assert.strictEqual(step2.action.value_source, SymbolicSecretSource.LOCAL_AADHAAR);
  assert.ok(step2.action.risk === RiskLevel.HIGH || step2.action.risk === RiskLevel.MEDIUM);
  history.push({ step: 2, action: step2.action });

  // Step 3 plan (PAN)
  const step3 = await client.planNextStep(task, fusedObservation, history);
  assert.strictEqual(step3.action.action, ActionType.TYPE);
  assert.strictEqual(step3.action.target.element_id, 'el_3');
  assert.strictEqual(step3.action.value_source, SymbolicSecretSource.LOCAL_PAN);
  history.push({ step: 3, action: step3.action });

  // Fast forward history to submit
  history.push({ step: 4, action: { action: ActionType.TYPE, target: { element_id: 'el_4' } } });
  history.push({ step: 5, action: { action: ActionType.TYPE, target: { element_id: 'el_5' } } });

  // Next step must be Submit with confirmation requirement
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
