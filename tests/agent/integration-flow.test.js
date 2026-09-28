import test from 'node:test';
import assert from 'node:assert/strict';
import { GPTOSSClient } from '../../extension/reasoning/gpt-oss-client.js';
import { ActionType, SymbolicSecretSource } from '../../extension/shared/constants.js';

async function withMockFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('Integration - remote planner action is grounded to the sanitized form observation', async () => {
  let sentBody;
  const fusedObservation = {
    elements: [
      { id: 'el_name', dom: { tag: 'input', name: 'full_name', label: 'Full Name', sensitive: false } },
      { id: 'el_aadhaar', dom: { tag: 'input', name: 'aadhaar_number', label: 'Aadhaar Number', sensitive: true, value_source: SymbolicSecretSource.LOCAL_AADHAAR } },
      { id: 'el_submit', dom: { tag: 'button', type: 'submit', label: 'Submit Application' } }
    ]
  };

  await withMockFetch(async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({
      action: { action: ActionType.TYPE, target: { element_id: 'el_name' }, value_source: SymbolicSecretSource.LOCAL_FULL_NAME },
      plan: 'Fill the requested identity fields, then review the result.',
      planner_feedback: '',
      terminate_assessment: false,
      final_response: ''
    }) };
  }, async () => {
    const result = await new GPTOSSClient('http://127.0.0.1:9999').planNextStep(
      'Fill this application using my saved profile', fusedObservation, []
    );
    assert.equal(result.action.action, ActionType.TYPE);
    assert.equal(result.action.target.element_id, 'el_name');
    assert.equal(result.remoteCallMade, true);
    assert.ok(fusedObservation.elements.some((element) => element.id === result.action.target.element_id));
  });
  assert.equal(sentBody.task, 'Fill this application using my saved profile');
  assert.doesNotMatch(JSON.stringify(sentBody), /SYNTHETIC_AADHAAR_FIXTURE/);
});

test('Integration - unsupported local document upload asks user to choose directly on the site', async () => {
  const client = new GPTOSSClient('http://127.0.0.1:9999');
  const fusedObservation = {
    elements: [
      { id: 'el_upload', dom: { tag: 'input', type: 'file', label: 'Upload Identity PDF' }, interaction: { uploadable: true } }
    ]
  };

  const uploadStep = await client.planNextStep('Upload my Aadhaar PDF', fusedObservation, []);
  assert.strictEqual(uploadStep.action.action, ActionType.ASK_USER);
  assert.match(uploadStep.action.value.prompt, /Choose the file directly/i);
  assert.equal(uploadStep.action.value_source, undefined);
});

test('Integration - model-emitted UPLOAD is blocked and routed to the user', async () => {
  const fusedObservation = {
    elements: [
      { id: 'el_file', dom: { tag: 'input', type: 'file', label: 'Supporting document' }, interaction: { uploadable: true } }
    ]
  };

  await withMockFetch(async () => ({ ok: true, json: async () => ({
    action: { action: ActionType.UPLOAD, target: { element_id: 'el_file' } },
    plan: 'Complete the application.',
    planner_feedback: '',
    terminate_assessment: false
  }) }), async () => {
    const result = await new GPTOSSClient('http://backend.test').planNextStep(
      'Complete this application', fusedObservation, []
    );
    assert.equal(result.action.action, ActionType.ASK_USER);
    assert.match(result.action.value.prompt, /Choose the file directly/i);
    assert.equal(result.action.target, undefined);
    assert.equal(result.remoteCallMade, true);
    assert.equal(result.remoteCallAttempted, true);
  });
});

test('Integration - remote flight-search action passes through with its grounded target', async () => {
  const fusedObservation = {
    elements: [
      { id: 'el_from', dom: { tag: 'input', label: 'Origin City (From)' } },
      { id: 'el_to', dom: { tag: 'input', label: 'Destination City (To)' } },
      { id: 'el_search', dom: { tag: 'button', label: 'Search Flights' } }
    ]
  };

  await withMockFetch(async () => ({ ok: true, json: async () => ({
    action: { action: ActionType.TYPE, target: { element_id: 'el_from' }, value: 'Pune' },
    plan: 'Enter the origin and destination, then compare flights.',
    planner_feedback: ''
  }) }), async () => {
    const result = await new GPTOSSClient('http://127.0.0.1:9999').planNextStep(
      'Find the cheapest flight from Pune to Delhi', fusedObservation, []
    );
    assert.equal(result.action.action, ActionType.TYPE);
    assert.equal(result.action.target.element_id, 'el_from');
    assert.equal(result.action.value, 'Pune');
    assert.equal(result.remoteCallMade, true);
  });
});
