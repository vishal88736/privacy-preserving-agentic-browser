import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { LocalValueResolver } from '../../extension/executor/local-value-resolver.js';
import { TaskManager } from '../../extension/background/task-manager.js';
import { AgentController } from '../../extension/background/agent-controller.js';
import { ActionValidator } from '../../extension/executor/action-validator.js';
import { ActionType, AgentState, SymbolicSecretSource } from '../../extension/shared/constants.js';

test('LocalValueResolver - resolves LOCAL_CITY, LOCAL_STATE, LOCAL_ZIP directly from vault', () => {
  const vault = new LocalVault();
  vault.memoryStore[SymbolicSecretSource.LOCAL_CITY] = 'Bengaluru';
  vault.memoryStore[SymbolicSecretSource.LOCAL_STATE] = 'Karnataka';
  vault.memoryStore[SymbolicSecretSource.LOCAL_ZIP] = '560001';

  const resolver = new LocalValueResolver(vault);

  const planAction = {
    action: ActionType.FILL_FORM_PLAN,
    value: {
      fields: [
        { field_id: 'f_city', semantic_type: 'city', address_part: 'city', value_source: SymbolicSecretSource.LOCAL_ADDRESS },
        { field_id: 'f_state', semantic_type: 'state', address_part: 'state', value_source: SymbolicSecretSource.LOCAL_ADDRESS },
        { field_id: 'f_zip', semantic_type: 'zip_code', address_part: 'zip', value_source: SymbolicSecretSource.LOCAL_ADDRESS }
      ]
    }
  };

  const resolved = resolver.resolve(planAction);
  assert.equal(resolved.fields[0].value, 'Bengaluru');
  assert.equal(resolved.fields[1].value, 'Karnataka');
  assert.equal(resolved.fields[2].value, '560001');
});

test('LocalValueResolver - falls back to parsing LOCAL_ADDRESS when sub-tokens are not directly set', () => {
  const vault = new LocalVault();
  delete vault.memoryStore[SymbolicSecretSource.LOCAL_CITY];
  delete vault.memoryStore[SymbolicSecretSource.LOCAL_STATE];
  delete vault.memoryStore[SymbolicSecretSource.LOCAL_ZIP];
  vault.memoryStore[SymbolicSecretSource.LOCAL_ADDRESS] = 'Flat 402, Green Meadows, Baner, Pune, Maharashtra - 411045';

  const resolver = new LocalValueResolver(vault);

  const planAction = {
    action: ActionType.FILL_FORM_PLAN,
    value: {
      fields: [
        { field_id: 'f_city', semantic_type: 'city', address_part: 'city', value_source: SymbolicSecretSource.LOCAL_ADDRESS },
        { field_id: 'f_state', semantic_type: 'state', address_part: 'state', value_source: SymbolicSecretSource.LOCAL_ADDRESS },
        { field_id: 'f_zip', semantic_type: 'zip_code', address_part: 'zip', value_source: SymbolicSecretSource.LOCAL_ADDRESS }
      ]
    }
  };

  const resolved = resolver.resolve(planAction);
  assert.equal(resolved.fields[0].value, 'Pune');
  assert.equal(resolved.fields[1].value, 'Maharashtra');
  assert.equal(resolved.fields[2].value, '411045');
});

test('TaskManager - tracks pendingUserInput state lifecycle', () => {
  const tm = new TaskManager();
  const task = tm.createTask('Fill the ambiguous registration form', 123);
  assert.equal(task.pendingUserInput, null);

  const askData = {
    prompt: 'Please provide newsletter preference',
    ambiguousFields: [{ field_id: 'f_news', semantic_type: 'newsletter', label: 'Newsletter' }]
  };

  tm.setPendingUserInput(askData);
  assert.equal(tm.getTask().state, AgentState.WAITING_FOR_USER);
  assert.ok(tm.getTask().pendingUserInput);
  assert.equal(tm.getTask().pendingUserInput.prompt, 'Please provide newsletter preference');
  assert.equal(tm.getTask().pendingUserInput.ambiguousFields.length, 1);

  tm.clearPendingUserInput();
  assert.equal(tm.getTask().pendingUserInput, null);
});

test('TaskManager - cancelTask clears pendingUserInput', () => {
  const tm = new TaskManager();
  tm.createTask('Fill form', 123);
  tm.setPendingUserInput({ prompt: 'Input needed' });
  assert.ok(tm.getTask().pendingUserInput);

  tm.cancelTask();
  assert.equal(tm.getTask().state, AgentState.CANCELLED);
  assert.equal(tm.getTask().pendingUserInput, null);
});

test('AgentController - handleUserInput resolves pending resolver', async () => {
  const controller = new AgentController();
  let resolvedPayload = null;

  const promise = new Promise((resolve) => {
    controller.pendingUserInputResolver = resolve;
  }).then((res) => {
    resolvedPayload = res;
  });

  controller.handleUserInput({ answers: { f_1: 'Value 1' }, saveToVault: [{ key: 'LOCAL_CITY', value: 'Delhi' }] });
  await promise;

  assert.deepEqual(resolvedPayload, {
    answers: { f_1: 'Value 1' },
    saveToVault: [{ key: 'LOCAL_CITY', value: 'Delhi' }]
  });
  assert.equal(controller.pendingUserInputResolver, null);
});

test('ActionValidator - ASK_USER requires no target element', () => {
  const validator = new ActionValidator();
  const res = validator.validatePreExecution({ action: ActionType.ASK_USER }, {});
  assert.equal(res.valid, true);
});
