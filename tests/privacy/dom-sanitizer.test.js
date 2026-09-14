import test from 'node:test';
import assert from 'node:assert';
import { DOMSanitizer } from '../../extension/privacy/dom-sanitizer.js';
import { PolicyEngine, OutboundPolicyViolationError } from '../../extension/privacy/policy-engine.js';
import { LocalVault } from '../../extension/privacy/local-vault.js';
import { SymbolicSecretSource } from '../../extension/shared/constants.js';

test('DOMSanitizer - Scrubs sensitive inputs into [REDACTED] and sets symbolic source', () => {
  const sanitizer = new DOMSanitizer();

  const rawElements = [
    {
      id: 'el_1',
      tag: 'input',
      type: 'text',
      name: 'aadhaar_number',
      label: 'Enter 12-digit Aadhaar Number',
      value: '4821 7392 0184'
    },
    {
      id: 'el_2',
      tag: 'input',
      type: 'password',
      name: 'user_pass',
      label: 'Password',
      value: 'MySecretPassword123'
    },
    {
      id: 'el_3',
      tag: 'input',
      type: 'text',
      name: 'origin_city',
      label: 'Departure City',
      value: 'Pune'
    },
    {
      id: 'el_4',
      tag: 'button',
      type: 'submit',
      label: 'Submit Application'
    }
  ];

  const { sanitizedElements, sensitiveCount, detectedCategories } = sanitizer.sanitizeElements(rawElements);

  assert.strictEqual(sensitiveCount, 2, 'Should identify 2 sensitive elements');
  assert.ok(detectedCategories.includes('AADHAAR'));
  assert.ok(detectedCategories.includes('PASSWORD'));

  // el_1 must have value redacted and symbolic source set
  const aadhaarEl = sanitizedElements.find(e => e.id === 'el_1');
  assert.strictEqual(aadhaarEl.value, '[REDACTED]', 'Aadhaar plaintext value must be redacted');
  assert.strictEqual(aadhaarEl.sensitive, true);
  assert.strictEqual(aadhaarEl.value_source, SymbolicSecretSource.LOCAL_AADHAAR);

  // el_2 password must be redacted
  const passEl = sanitizedElements.find(e => e.id === 'el_2');
  assert.strictEqual(passEl.value, '[REDACTED]', 'Password plaintext value must be redacted');
  assert.strictEqual(passEl.sensitive, true);
  assert.strictEqual(passEl.value_source, SymbolicSecretSource.LOCAL_PASSWORD);

  // el_3 non-sensitive origin city is preserved
  const cityEl = sanitizedElements.find(e => e.id === 'el_3');
  assert.strictEqual(cityEl.sensitive, false);
  assert.strictEqual(cityEl.value, 'Pune');
});

test('DOMSanitizer - Sanitizes sensitive query parameters in URLs', () => {
  const sanitizer = new DOMSanitizer();
  const rawUrl = 'https://gov-services.in/apply?step=2&token=secret_auth_token_999&session=abcxyz';
  const cleanUrl = sanitizer.sanitizeUrl(rawUrl);

  assert.ok(!cleanUrl.includes('secret_auth_token_999'), 'Token must be redacted from URL');
  assert.ok(cleanUrl.includes('token=%5BREDACTED%5D') || cleanUrl.includes('token=[REDACTED]'));
});

test('PolicyEngine - Blocks outbound payloads containing unredacted secrets', () => {
  const vault = new LocalVault();
  const policyEngine = new PolicyEngine(vault);

  // Safe sanitized payload
  const safePayload = {
    task_id: 'task_1',
    elements: [
      { id: 'el_1', label: 'Aadhaar', value: '[REDACTED]', value_source: 'LOCAL_AADHAAR' }
    ]
  };
  assert.doesNotThrow(() => policyEngine.enforceOutboundSafety(safePayload));

  // Dangerous payload containing raw secret from vault
  const leakedPayload = {
    task_id: 'task_1',
    elements: [
      { id: 'el_1', label: 'Aadhaar', value: '4821 7392 0184' } // Leaking raw vault secret
    ]
  };
  assert.throws(
    () => policyEngine.enforceOutboundSafety(leakedPayload),
    OutboundPolicyViolationError,
    'Must throw OutboundPolicyViolationError when raw secret is leaked'
  );
});

test('DOMSanitizer - Handles elements with null attributes gracefully without toLowerCase errors', () => {
  const sanitizer = new DOMSanitizer();

  const elementsWithNulls = [
    {
      id: 'div_1',
      tag: 'div',
      type: null,
      name: null,
      label: null,
      placeholder: null,
      value: '',
      autocomplete: null,
      ariaLabel: null,
      role: null
    },
    {
      id: 'input_search',
      tag: 'input',
      type: null,
      name: 'search_query',
      label: 'Search',
      placeholder: 'Search YouTube',
      value: '',
      autocomplete: null,
      ariaLabel: 'Search',
      role: null
    }
  ];

  assert.doesNotThrow(() => {
    const result = sanitizer.sanitizeElements(elementsWithNulls);
    assert.strictEqual(result.sanitizedElements.length, 2);
  }, 'Must not throw TypeError: Cannot read properties of null (reading toLowerCase)');
});

