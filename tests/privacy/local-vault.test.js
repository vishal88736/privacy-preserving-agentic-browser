/**
 * Tests for LocalVault
 * Covers secret resolution, update, filtering, and key summary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { SymbolicSecretSource } from '../../extension/shared/constants.js';

// ── resolveSecret ──────────────────────────────────────────────────────────

test('LocalVault - resolves known symbolic sources to correct default values', () => {
  const vault = new LocalVault();
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_PAN), 'ABCDE1234F');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_AADHAAR), '4821 7392 0184');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_FULL_NAME), 'Vishal Agrawal');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_PHONE), '9876543210');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_EMAIL), 'vishal.agrawal@example.com');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_PASSWORD), 'SecureDemoPass#2026');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_DOB), '15/08/2002');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_COUNTRY), 'us');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_GENDER), 'male');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_TERMS), 'yes');
});

test('LocalVault - LOCAL_DOCUMENT resolves to an object (not a string)', () => {
  const vault = new LocalVault();
  const doc = vault.resolveSecret(SymbolicSecretSource.LOCAL_DOCUMENT);
  assert.ok(typeof doc === 'object' && doc !== null, 'Document must be an object');
  assert.ok(typeof doc.name === 'string', 'Document must have a name');
  assert.ok(typeof doc.content === 'string', 'Document must have base64 content');
});

test('LocalVault - returns null for unknown symbolic source', () => {
  const vault = new LocalVault();
  assert.equal(vault.resolveSecret('NON_EXISTENT_KEY'), null);
  assert.equal(vault.resolveSecret(''), null);
  assert.equal(vault.resolveSecret(null), null);
  assert.equal(vault.resolveSecret(undefined), null);
});

// ── getAllSecretsForUI ─────────────────────────────────────────────────────

test('LocalVault - getAllSecretsForUI returns only string values (excludes document blob)', () => {
  const vault = new LocalVault();
  const secrets = vault.getAllSecretsForUI();

  // Must include all string fields
  assert.equal(typeof secrets[SymbolicSecretSource.LOCAL_PAN], 'string');
  assert.equal(typeof secrets[SymbolicSecretSource.LOCAL_AADHAAR], 'string');
  assert.equal(typeof secrets[SymbolicSecretSource.LOCAL_EMAIL], 'string');

  // Must NOT include the document blob
  assert.equal(secrets[SymbolicSecretSource.LOCAL_DOCUMENT], undefined,
    'Document object must be excluded from UI secrets');

  // All values must be strings
  for (const [key, value] of Object.entries(secrets)) {
    assert.equal(typeof value, 'string', `Expected string for key ${key}, got ${typeof value}`);
  }
});

test('LocalVault - getAllSecretsForUI returns at least 10 configured secrets', () => {
  const vault = new LocalVault();
  const secrets = vault.getAllSecretsForUI();
  assert.ok(Object.keys(secrets).length >= 10, 'Should have at least 10 string secrets configured');
});

// ── getAvailableKeysSummary ────────────────────────────────────────────────

test('LocalVault - getAvailableKeysSummary returns all keys with preview dots', () => {
  const vault = new LocalVault();
  const summary = vault.getAvailableKeysSummary();

  assert.ok(Array.isArray(summary), 'Summary must be an array');
  assert.ok(summary.length > 0, 'Summary must not be empty');

  // Every entry should have key + isConfigured
  for (const entry of summary) {
    assert.ok(typeof entry.key === 'string', 'key must be a string');
    assert.ok(typeof entry.isConfigured === 'boolean', 'isConfigured must be boolean');
  }

  // Non-document entries should have masked preview
  const panEntry = summary.find(e => e.key === SymbolicSecretSource.LOCAL_PAN);
  assert.ok(panEntry, 'PAN entry should be present in summary');
  assert.equal(panEntry.isConfigured, true);
  assert.equal(panEntry.preview, '••••••••', 'PAN preview should be masked');

  // Document entry should show filename
  const docEntry = summary.find(e => e.key === SymbolicSecretSource.LOCAL_DOCUMENT);
  assert.ok(docEntry, 'Document entry should be present in summary');
  assert.ok(typeof docEntry.preview === 'string', 'Document preview should be a filename string');
});

// ── updateSecret ──────────────────────────────────────────────────────────

test('LocalVault - updateSecret changes in-memory value immediately', async () => {
  const vault = new LocalVault();

  // Override original PAN
  await vault.updateSecret(SymbolicSecretSource.LOCAL_PAN, 'XYZPQ9876K');
  assert.equal(vault.resolveSecret(SymbolicSecretSource.LOCAL_PAN), 'XYZPQ9876K',
    'Updated secret should be immediately readable from the in-memory store');
});

test('LocalVault - updateSecret with new key creates entry', async () => {
  const vault = new LocalVault();
  await vault.updateSecret('LOCAL_CUSTOM_KEY', 'custom_value_42');
  assert.equal(vault.resolveSecret('LOCAL_CUSTOM_KEY'), 'custom_value_42');
});

// ── getAllSecretsForUI after update ───────────────────────────────────────

test('LocalVault - getAllSecretsForUI reflects updated values', async () => {
  const vault = new LocalVault();
  await vault.updateSecret(SymbolicSecretSource.LOCAL_EMAIL, 'updated@mail.com');
  const secrets = vault.getAllSecretsForUI();
  assert.equal(secrets[SymbolicSecretSource.LOCAL_EMAIL], 'updated@mail.com');
});

test('LocalVault - getAllSecretsForUI excludes non-string values even after updateSecret', async () => {
  const vault = new LocalVault();
  await vault.updateSecret('LOCAL_SOME_OBJECT', { foo: 'bar' });
  const secrets = vault.getAllSecretsForUI();
  assert.equal(secrets['LOCAL_SOME_OBJECT'], undefined, 'Object values must be filtered out');
});
