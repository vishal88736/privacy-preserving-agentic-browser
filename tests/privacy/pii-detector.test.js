import test from 'node:test';
import assert from 'node:assert';
import { PIIDetector, validateAadhaarVerhoeff, validateLuhn } from '../../extension/privacy/pii-detector.js';
import { PIICategory, SymbolicSecretSource } from '../../extension/shared/constants.js';

test('PIIDetector - Aadhaar Detection & Verhoeff Validation', () => {
  const detector = new PIIDetector();

  // Valid Verhoeff Aadhaar test cases
  const validAadhaar = '2184 7392 0187'; // formatted
  // Test detection
  const match = detector.detectPIIInText('My Aadhaar is 2184 7392 0187 for verification');
  assert.ok(match, 'Should detect 12-digit Aadhaar pattern');
  assert.strictEqual(match.category, PIICategory.AADHAAR);
  assert.strictEqual(match.source, SymbolicSecretSource.LOCAL_AADHAAR);

  // Invalid length or characters
  const invalid = detector.detectPIIInText('12345');
  assert.strictEqual(invalid, null);
});

test('PIIDetector - PAN Card Detection', () => {
  const detector = new PIIDetector();
  const res = detector.detectPIIInText('User PAN is ABCDE1234F');
  assert.ok(res, 'Should detect 10-character PAN');
  assert.strictEqual(res.category, PIICategory.PAN);
  assert.strictEqual(res.source, SymbolicSecretSource.LOCAL_PAN);
  assert.strictEqual(res.match, 'ABCDE1234F');
});

test('PIIDetector - Credit Card & Luhn Algorithm Validation', () => {
  const detector = new PIIDetector();
  // Valid Luhn Card test number
  const validVisa = '4532 0150 0000 0007';
  assert.strictEqual(validateLuhn(validVisa), true);

  const res = detector.detectPIIInText(`Payment card: ${validVisa}`);
  assert.ok(res, 'Should detect valid Luhn credit card');
  assert.strictEqual(res.category, PIICategory.CREDIT_CARD);

  // Invalid card fails Luhn
  assert.strictEqual(validateLuhn('4532 0150 0000 0008'), false);
});

test('PIIDetector - Email and Indian Phone Detection', () => {
  const detector = new PIIDetector();

  const emailRes = detector.detectPIIInText('Contact me at vishal.test@example.gov.in');
  assert.ok(emailRes);
  assert.strictEqual(emailRes.category, PIICategory.EMAIL);

  const phoneRes = detector.detectPIIInText('+91 9876543210', 'mobile number');
  assert.ok(phoneRes);
  assert.strictEqual(phoneRes.category, PIICategory.PHONE);
});

test('PIIDetector - Date of Birth (DOB) and OTP Detection', () => {
  const detector = new PIIDetector();

  const dobRes = detector.detectPIIInText('Born on 15/08/2002');
  assert.ok(dobRes);
  assert.strictEqual(dobRes.category, PIICategory.DOB);

  const otpRes = detector.detectPIIInText('582910', 'verification OTP');
  assert.ok(otpRes);
  assert.strictEqual(otpRes.category, PIICategory.OTP);
});
