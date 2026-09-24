import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from '../../extension/background/agent-controller.js';
import { FormAnalyzer } from '../../extension/reasoning/form-analyzer.js';
import { FormPlanBuilder } from '../../extension/reasoning/form-plan-builder.js';
import { LocalValueResolver } from '../../extension/executor/local-value-resolver.js';
import { ActionType } from '../../extension/shared/constants.js';

function makeController(profile) {
  const vault = { resolveSecret: (source) => profile[source] || null };
  const builder = new FormPlanBuilder(new FormAnalyzer(), new LocalValueResolver(vault));
  return new AgentController(builder);
}

function termsElement(checked) {
  return [{
    id: 'el_terms',
    dom: {
      id: 'el_terms', tag: 'input', type: 'checkbox', name: 'terms', label: 'Agree to terms',
      checked, in_form: true, form_id: 'form_1', disabled: false, value: 'yes'
    }
  }];
}

test('controller replaces remote DONE while a configured profile field remains blank', () => {
  const controller = makeController({ LOCAL_TERMS: 'yes' });
  const planResult = {
    action: { action: ActionType.DONE }, isTerminal: true, thought: 'model says done'
  };
  const guarded = controller._guardProfileFormCompletion(
    { prompt: 'Fill this form using my saved profile, but do not submit it.', steps: [] },
    'FILL_FORM', planResult, termsElement(false)
  );
  assert.equal(guarded.action.action, ActionType.FILL_FORM_PLAN);
  assert.equal(guarded.action.value.fields[0].field_id, 'el_terms');
  assert.equal(guarded.planResult.isTerminal, false);
});

test('controller accepts DONE after known profile controls are already correct', () => {
  const controller = makeController({ LOCAL_TERMS: 'yes' });
  const planResult = { action: { action: ActionType.DONE }, isTerminal: true };
  const guarded = controller._guardProfileFormCompletion(
    { prompt: 'Fill this form using my saved profile, but do not submit it.', steps: [] },
    'FILL_FORM', planResult, termsElement(true)
  );
  assert.equal(guarded.action.action, ActionType.DONE);
  assert.equal(guarded.planResult.isTerminal, true);
});
