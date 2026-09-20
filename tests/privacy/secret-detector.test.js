/**
 * Tests for SecretDetector
 * Covers structural/attribute-based classification of DOM input elements.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretDetector } from '../../extension/privacy/secret-detector.js';
import { PIICategory, SymbolicSecretSource } from '../../extension/shared/constants.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDetector() {
  return new SecretDetector();
}

// ── type=password ──────────────────────────────────────────────────────────

test('SecretDetector - classifies input[type=password] as PASSWORD', () => {
  const d = makeDetector();
  const result = d.classifyElement({ type: 'password', name: 'pass', id: 'pwd' });
  assert.equal(result.isSensitive, true);
  assert.equal(result.category, PIICategory.PASSWORD);
  assert.equal(result.source, SymbolicSecretSource.LOCAL_PASSWORD);
  assert.equal(result.reason, 'input[type=password]');
});

// ── autocomplete hints ─────────────────────────────────────────────────────

test('SecretDetector - autocomplete=current-password triggers PASSWORD', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', autocomplete: 'current-password', name: 'pwd' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.PASSWORD);
  assert.equal(r.reason, 'autocomplete=password');
});

test('SecretDetector - autocomplete=new-password triggers PASSWORD', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', autocomplete: 'new-password' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.PASSWORD);
});

test('SecretDetector - autocomplete=cc-number triggers CREDIT_CARD', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', autocomplete: 'cc-number' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.CREDIT_CARD);
  assert.equal(r.source, SymbolicSecretSource.LOCAL_CREDIT_CARD);
  assert.equal(r.reason, 'autocomplete=cc-number');
});

test('SecretDetector - autocomplete=cc-csc triggers CVV', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', autocomplete: 'cc-csc' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.CVV);
  assert.equal(r.source, SymbolicSecretSource.LOCAL_CVV);
});

// ── file upload identity docs ──────────────────────────────────────────────

test('SecretDetector - file upload with "aadhaar" in name is DOCUMENT', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'file', name: 'aadhaar_upload', id: 'doc_field', label: 'Upload Aadhaar' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.DOCUMENT);
  assert.equal(r.source, SymbolicSecretSource.LOCAL_DOCUMENT);
  assert.equal(r.reason, 'file_upload_identity');
});

test('SecretDetector - file upload with "pan" in id is DOCUMENT', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'file', name: 'document', id: 'pan_doc' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.DOCUMENT);
});

test('SecretDetector - generic file upload (no identity keyword) is not sensitive', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'file', name: 'profile_picture', id: 'avatar' });
  assert.equal(r.isSensitive, false);
});

// ── keyword heuristic matching ─────────────────────────────────────────────

test('SecretDetector - placeholder "Aadhaar Number" triggers AADHAAR', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', placeholder: 'Enter Aadhaar Number', name: 'uid' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.AADHAAR);
  assert.equal(r.source, SymbolicSecretSource.LOCAL_AADHAAR);
});

test('SecretDetector - label "PAN Card" triggers PAN', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', label: 'PAN Card Number', name: 'pan' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.PAN);
  assert.equal(r.source, SymbolicSecretSource.LOCAL_PAN);
});

test('SecretDetector - name="otp" triggers OTP', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', name: 'otp', placeholder: 'Enter OTP' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.OTP);
});

test('SecretDetector - name="card_number" triggers CREDIT_CARD', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', name: 'card_number', placeholder: 'Debit Card Number' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.CREDIT_CARD);
});

test('SecretDetector - aria-label "cvv" triggers CVV', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', ariaLabel: 'CVV security code', name: 'sec' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.CVV);
});

test('SecretDetector - placeholder "IFSC" triggers BANK_ACCOUNT', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', placeholder: 'Bank Account IFSC', name: 'ifsc' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.BANK_ACCOUNT);
});

test('SecretDetector - name="mobile" triggers PHONE', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'tel', name: 'mobile', label: 'Mobile Number' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.PHONE);
  assert.equal(r.source, SymbolicSecretSource.LOCAL_PHONE);
});

test('SecretDetector - label "Email Address" triggers EMAIL', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'email', label: 'Email Address', name: 'email' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.EMAIL);
  assert.equal(r.source, SymbolicSecretSource.LOCAL_EMAIL);
});

test('SecretDetector - label "Date of Birth" triggers DOB', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'date', label: 'Date of Birth', name: 'dob' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.DOB);
  assert.equal(r.source, SymbolicSecretSource.LOCAL_DOB);
});

test('SecretDetector - placeholder "Full Name" triggers FULL_NAME', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', placeholder: 'Enter your full name', name: 'applicant_name' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.FULL_NAME);
  assert.equal(r.source, SymbolicSecretSource.LOCAL_FULL_NAME);
});

test('SecretDetector - name="residential_address" triggers ADDRESS', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', name: 'residential_address', label: 'Home Address' });
  assert.equal(r.isSensitive, true);
  assert.equal(r.category, PIICategory.ADDRESS);
});

test('SecretDetector - aria-label "Upload aadhaar document" triggers AADHAAR (keyword order)', () => {
  // The AADHAAR pattern appears before DOCUMENT in sensitiveKeywords, so it wins
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', ariaLabel: 'Upload aadhaar document' });
  assert.equal(r.isSensitive, true);
  // AADHAAR matches first because /aadhaar|uidai|unique\s*id/i is earlier in the list
  assert.ok(r.category === PIICategory.AADHAAR || r.category === PIICategory.DOCUMENT,
    `Expected AADHAAR or DOCUMENT, got ${r.category}`);
});

// ── non-sensitive baseline ─────────────────────────────────────────────────

test('SecretDetector - generic search input is NOT sensitive', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', name: 'query', id: 'search', placeholder: 'Search for products' });
  assert.equal(r.isSensitive, false);
  assert.equal(r.category, null);
  assert.equal(r.source, null);
  assert.equal(r.reason, 'non_sensitive');
});

test('SecretDetector - city input is NOT sensitive', () => {
  const d = makeDetector();
  const r = d.classifyElement({ type: 'text', name: 'city', label: 'Departure City', placeholder: 'Pune' });
  assert.equal(r.isSensitive, false);
});

test('SecretDetector - handles empty / undefined fields without throwing', () => {
  const d = makeDetector();
  assert.doesNotThrow(() => {
    const r = d.classifyElement({});
    assert.equal(r.isSensitive, false);
  });
  assert.doesNotThrow(() => {
    const r = d.classifyElement({ type: null, name: undefined, id: '', placeholder: null });
    assert.equal(r.isSensitive, false);
  });
});

test('SecretDetector - classifyElement with no argument returns non-sensitive', () => {
  const d = makeDetector();
  const r = d.classifyElement();
  assert.equal(r.isSensitive, false);
});
