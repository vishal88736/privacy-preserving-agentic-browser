/**
 * Tests for LocalValueResolver
 * Covers symbolic source resolution, plain value pass-through,
 * FILL_FORM_PLAN bulk resolution, strict/soft source handling,
 * first_name/last_name splitting, and missing key errors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalValueResolver } from '../../extension/executor/local-value-resolver.js';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { ActionType, SymbolicSecretSource } from '../../extension/shared/constants.js';

function makeResolver(overrides = {}) {
  const vault = new LocalVault();
  // Explicitly labeled synthetic fixtures keep tests independent of any
  // production defaults (the real vault starts empty).
  Object.assign(vault.memoryStore, {
    LOCAL_AADHAAR: 'SYNTHETIC_AADHAAR_FIXTURE', LOCAL_PAN: 'SYNTHETIC_PAN_FIXTURE',
    LOCAL_EMAIL: 'synthetic@example.invalid', LOCAL_FULL_NAME: 'Synthetic User',
    LOCAL_ADDRESS: 'Synthetic Road, Example City, Example State - 000000'
  }, overrides);
  return { resolver: new LocalValueResolver(vault), vault };
}

// ── Plain value pass-through ──────────────────────────────────────────────

test('LocalValueResolver - returns plain value when no value_source', () => {
  const { resolver } = makeResolver();
  const result = resolver.resolve({ action: ActionType.TYPE, value: 'Pune' });
  assert.equal(result, 'Pune');
});

test('LocalValueResolver - returns empty string for action with no value and no value_source', () => {
  const { resolver } = makeResolver();
  const result = resolver.resolve({ action: ActionType.CLICK });
  assert.equal(result, '');
});

// ── Symbolic source resolution ────────────────────────────────────────────

test('LocalValueResolver - resolves LOCAL_AADHAAR from vault', () => {
  const { resolver } = makeResolver();
  const result = resolver.resolve({
    action: ActionType.TYPE,
    value_source: SymbolicSecretSource.LOCAL_AADHAAR
  });
  assert.equal(result, 'SYNTHETIC_AADHAAR_FIXTURE');
});

test('LocalValueResolver - resolves LOCAL_PAN from vault', () => {
  const { resolver } = makeResolver();
  const result = resolver.resolve({
    action: ActionType.TYPE,
    value_source: SymbolicSecretSource.LOCAL_PAN
  });
  assert.equal(result, 'SYNTHETIC_PAN_FIXTURE');
});

test('LocalValueResolver - resolves LOCAL_EMAIL from vault', () => {
  const { resolver } = makeResolver();
  const result = resolver.resolve({
    action: ActionType.TYPE,
    value_source: SymbolicSecretSource.LOCAL_EMAIL
  });
  assert.equal(result, 'synthetic@example.invalid');
});

test('LocalValueResolver - rejects unsupported LOCAL_DOCUMENT handling', () => {
  const { resolver } = makeResolver();
  assert.throws(() => resolver.resolve({
    action: ActionType.UPLOAD,
    value_source: SymbolicSecretSource.LOCAL_DOCUMENT
  }), /not configured/);
});

test('LocalValueResolver - throws for missing strict source (LOCAL_AADHAAR not configured)', () => {
  const { resolver, vault } = makeResolver();
  // Remove the Aadhaar entry to simulate misconfiguration
  delete vault.memoryStore[SymbolicSecretSource.LOCAL_AADHAAR];
  assert.throws(
    () => resolver.resolve({ action: ActionType.TYPE, value_source: SymbolicSecretSource.LOCAL_AADHAAR }),
    /not configured/
  );
});

test('LocalValueResolver - throws for completely unknown value_source', () => {
  const { resolver } = makeResolver();
  assert.throws(
    () => resolver.resolve({ action: ActionType.TYPE, value_source: 'NON_EXISTENT_SOURCE' }),
    /not configured/
  );
});

// ── FILL_FORM_PLAN bulk resolution ────────────────────────────────────────

test('LocalValueResolver - bulk resolves FILL_FORM_PLAN fields with symbolic sources', () => {
  const { resolver } = makeResolver();
  const action = {
    action: ActionType.FILL_FORM_PLAN,
    value: {
      fields: [
        { field_id: 'el_name', value_source: SymbolicSecretSource.LOCAL_FULL_NAME },
        { field_id: 'el_email', value_source: SymbolicSecretSource.LOCAL_EMAIL },
        { field_id: 'el_pan', value_source: SymbolicSecretSource.LOCAL_PAN }
      ]
    }
  };
  const result = resolver.resolve(action);
  const byId = new Map(result.fields.map(f => [f.field_id, f]));
  assert.equal(byId.get('el_name').value, 'Synthetic User');
  assert.equal(byId.get('el_email').value, 'synthetic@example.invalid');
  assert.equal(byId.get('el_pan').value, 'SYNTHETIC_PAN_FIXTURE');
});

test('LocalValueResolver - FILL_FORM_PLAN: first_name semantic splits full name', () => {
  const { resolver } = makeResolver();
  const action = {
    action: ActionType.FILL_FORM_PLAN,
    value: {
      fields: [
        { field_id: 'el_first', value_source: SymbolicSecretSource.LOCAL_FULL_NAME, semantic_type: 'first_name' },
        { field_id: 'el_last', value_source: SymbolicSecretSource.LOCAL_FULL_NAME, semantic_type: 'last_name' }
      ]
    }
  };
  const result = resolver.resolve(action);
  const byId = new Map(result.fields.map(f => [f.field_id, f]));
  assert.equal(byId.get('el_first').value, 'Synthetic');
  assert.equal(byId.get('el_last').value, 'User');
});

test('LocalValueResolver - FILL_FORM_PLAN: strict source missing throws error', () => {
  const { resolver, vault } = makeResolver();
  delete vault.memoryStore[SymbolicSecretSource.LOCAL_PASSWORD];
  const action = {
    action: ActionType.FILL_FORM_PLAN,
    value: {
      fields: [
        { field_id: 'el_pass', value_source: SymbolicSecretSource.LOCAL_PASSWORD }
      ]
    }
  };
  assert.throws(() => resolver.resolve(action), /not configured/);
});

test('LocalValueResolver - FILL_FORM_PLAN: non-strict missing source resolves to empty string', () => {
  const { resolver, vault } = makeResolver();
  // LOCAL_GENDER is NOT a strict source
  delete vault.memoryStore[SymbolicSecretSource.LOCAL_GENDER];
  const action = {
    action: ActionType.FILL_FORM_PLAN,
    value: {
      fields: [
        { field_id: 'el_gender', value_source: SymbolicSecretSource.LOCAL_GENDER }
      ]
    }
  };
  const result = resolver.resolve(action);
  assert.equal(result.fields[0].value, '');
});

test('LocalValueResolver - FILL_FORM_PLAN: fields without value_source are left unchanged', () => {
  const { resolver } = makeResolver();
  const action = {
    action: ActionType.FILL_FORM_PLAN,
    value: {
      fields: [
        { field_id: 'el_static', value: 'static_text' }
        // no value_source
      ]
    }
  };
  const result = resolver.resolve(action);
  // Should not throw; field value unchanged
  assert.equal(result.fields[0].value, 'static_text');
});

test('LocalValueResolver - parseAddressParts derives city/state/zip', () => {
  const { resolver } = makeResolver({
    LOCAL_ADDRESS: 'Flat 402, Green Meadows, Baner, Pune, Maharashtra - 411045'
  });
  const parts = resolver.parseAddressParts(resolver.vault.resolveSecret('LOCAL_ADDRESS'));
  assert.equal(parts.city, 'Pune');
  assert.equal(parts.state, 'Maharashtra');
  assert.equal(parts.zip, '411045');
});

test('LocalValueResolver - FILL_FORM_PLAN resolves address_part without name fallback', () => {
  const { resolver } = makeResolver({
    LOCAL_ADDRESS: 'Flat 402, Green Meadows, Baner, Pune, Maharashtra - 411045'
  });
  const action = {
    action: ActionType.FILL_FORM_PLAN,
    value: {
      fields: [
        { field_id: 'el_city', semantic_type: 'city', value_source: SymbolicSecretSource.LOCAL_ADDRESS, address_part: 'city' },
        { field_id: 'el_zip', semantic_type: 'zip_code', value_source: SymbolicSecretSource.LOCAL_ADDRESS, address_part: 'zip' }
      ]
    }
  };
  const result = resolver.resolve(action);
  assert.equal(result.fields[0].value, 'Pune');
  assert.equal(result.fields[1].value, '411045');
});

test('LocalValueResolver - unparseable address_part marks field ambiguous', () => {
  const { resolver } = makeResolver({ LOCAL_ADDRESS: 'nowhere' });
  const action = {
    action: ActionType.FILL_FORM_PLAN,
    value: {
      fields: [
        { field_id: 'el_zip', semantic_type: 'zip_code', value_source: SymbolicSecretSource.LOCAL_ADDRESS, address_part: 'zip' }
      ]
    }
  };
  const result = resolver.resolve(action);
  assert.equal(result.fields[0].value, '');
  assert.equal(result.fields[0].ambiguous, true);
});
