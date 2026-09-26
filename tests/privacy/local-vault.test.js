import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { SymbolicSecretSource as S } from '../../extension/shared/constants.js';

test('LocalVault starts empty and does not ship identity or credential defaults', () => {
  const vault = new LocalVault();
  assert.deepEqual(vault.getAllSecretsForUI(), {});
  for (const key of [S.LOCAL_PAN, S.LOCAL_AADHAAR, S.LOCAL_FULL_NAME, S.LOCAL_PASSWORD, S.LOCAL_DOCUMENT]) assert.equal(vault.resolveSecret(key), null);
});

test('LocalVault accepts explicitly configured values for supported symbolic keys', async () => {
  const vault = new LocalVault();
  await vault.updateSecret(S.LOCAL_PAN, 'SYNTHETIC-PAN-FIXTURE');
  await vault.updateSecret(S.LOCAL_EMAIL, 'synthetic@example.invalid');
  assert.equal(vault.resolveSecret(S.LOCAL_PAN), 'SYNTHETIC-PAN-FIXTURE');
  assert.deepEqual(vault.getAllSecretsForUI(), { [S.LOCAL_PAN]: 'SYNTHETIC-PAN-FIXTURE', [S.LOCAL_EMAIL]: 'synthetic@example.invalid' });
  assert.deepEqual(vault.getAvailableKeysSummary().map(x => x.key).sort(), [S.LOCAL_PAN, S.LOCAL_EMAIL].sort());
});

test('LocalVault rejects unsupported keys, document blobs, and oversized values', async () => {
  const vault = new LocalVault();
  await assert.rejects(vault.updateSecret(S.LOCAL_DOCUMENT, 'demo'), /Unsupported/);
  // LOCAL_CUSTOM_* keys are valid custom vault keys (used by the vault UI and
  // form analyzer). Arbitrary non-custom keys are still rejected.
  await assert.rejects(vault.updateSecret('LOCAL_UNKNOWN_KEY', 'value'), /Unsupported/);
  await assert.rejects(vault.updateSecret('MY_SECRET_KEY', 'value'), /Unsupported/);
  await assert.rejects(vault.updateSecret(S.LOCAL_PAN, { value: 'x' }), /text/);
  await assert.rejects(vault.updateSecret(S.LOCAL_PAN, 'x'.repeat(4097)), /too large/);
});

test('LocalVault does not reveal unknown symbolic values', () => {
  const vault = new LocalVault();
  assert.equal(vault.resolveSecret('NO_SUCH_KEY'), null);
  assert.equal(vault.resolveSecret(null), null);
});
