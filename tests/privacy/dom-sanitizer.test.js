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

test('DOMSanitizer - PII in canonical accessible and selected-state fields is redacted', () => {
  const sanitizer = new DOMSanitizer();
  const secret = 'jane@example.com';
  const { sanitizedElements } = sanitizer.sanitizeElements([{
    id: 'el_1', tag: 'select', type: 'select-one', label: `Contact ${secret}`,
    accessible_name: `Contact ${secret}`, text: `Account ${secret}`, title: `Selected ${secret}`,
    value: '',
    options: [{ text: secret, value: secret, selected: true }],
    selected_option: { index: 0, text: secret, value: secret }
  }]);
  const serialized = JSON.stringify(sanitizedElements[0]);

  assert.doesNotMatch(serialized, /jane@example\.com/i);
  assert.match(sanitizedElements[0].accessible_name, /REDACTED/);
  assert.match(sanitizedElements[0].text, /REDACTED/);
  assert.match(sanitizedElements[0].title, /REDACTED/);
  assert.match(sanitizedElements[0].selected_option.value, /REDACTED/);
});

test('DOMSanitizer - strips page-authored identifier data and keeps safe form semantics', () => {
  const sanitizer = new DOMSanitizer();
  const { sanitizedElements } = sanitizer.sanitizeElements([
    { id: 'el_1', tag: 'input', type: 'text', name: 'firstName', value: 'Jane Doe' },
    { id: 'el_2', tag: 'input', type: 'text', name: 'shippingAddress', value: '42 Oak Road' },
    { id: 'el_3', tag: 'select', type: 'select-one', name: 'country', value: 'India' },
    { id: 'el_4', tag: 'input', type: 'radio', name: 'gender', value: 'female' },
    {
      id: 'Jane Doe 482173920184', tag: 'input', type: 'text',
      name: 'applicantName_JaneDoe_482173920184_jane@example.com', value: ''
    }
  ]);
  const serialized = JSON.stringify(sanitizedElements);

  assert.equal(sanitizedElements[0].id, 'el_1', 'synthetic target IDs must still resolve');
  assert.equal(sanitizedElements[4].id, '', 'opaque page IDs must be dropped');
  assert.equal(sanitizedElements[4].name, 'applicant name', 'safe field meaning should survive');
  assert.deepEqual(sanitizedElements.slice(0, 4).map((element) => element.sensitive), [true, true, true, true]);
  assert.doesNotMatch(serialized, /Jane Doe|JaneDoe|482173920184|jane@example\.com|42 Oak Road|India|female/);
  assert.match(serialized, /first name|shipping address|country|gender/);
});

test('DOMSanitizer - Sanitizes sensitive query parameters in URLs', () => {
  const sanitizer = new DOMSanitizer();
  const rawUrl = 'https://gov-services.in/apply?step=2&token=secret_auth_token_999&session=abcxyz';
  const cleanUrl = sanitizer.sanitizeUrl(rawUrl);

  assert.ok(!cleanUrl.includes('secret_auth_token_999'), 'Token must be redacted from URL');
  assert.ok(cleanUrl.includes('token=%5BREDACTED%5D') || cleanUrl.includes('token=[REDACTED]'));
});

test('DOMSanitizer - Redacts lowercase IFSC codes from outbound text and placeholders', async () => {
  const sanitizer = new DOMSanitizer();
  const extras = sanitizer.sanitizePageExtras({ visible_text: 'Branch IFSC: sbin0001234' });
  const placeholder = sanitizer.scrubPlaceholderText('sbin0001234');
  assert.doesNotMatch(extras.visible_text, /sbin0001234/i);
  assert.doesNotMatch(placeholder, /sbin0001234/i);
  await assert.doesNotReject(() => new PolicyEngine(new LocalVault()).enforceOutboundSafety(extras));
});

test('DOMSanitizer - keeps only minimal local media state for the verifier', () => {
  const sanitizer = new DOMSanitizer();
  const extras = sanitizer.sanitizePageExtras({
    local_media_state: {
      visible_count: 1,
      media: [{
        ordinal: 77,
        tag: 'video',
        paused: false,
        ended: false,
        ready_state: 99,
        src: 'https://private.example/video?token=secret',
        title: 'Jane jane@example.com'
      }]
    }
  });

  assert.deepEqual(extras.local_media_state, {
    visible_count: 1,
    media: [{ ordinal: 0, tag: 'video', paused: false, ended: false, ready_state: 4 }]
  });
  assert.doesNotMatch(JSON.stringify(extras.local_media_state), /private\.example|secret|jane@example\.com|src|title/i);
});

test('PolicyEngine - Blocks outbound payloads containing unredacted secrets', async () => {
  const vault = new LocalVault();
  const policyEngine = new PolicyEngine(vault);

  // Safe sanitized payload
  const safePayload = {
    task_id: 'task_1',
    elements: [
      { id: 'el_1', label: 'Aadhaar', value: '[REDACTED]', value_source: 'LOCAL_AADHAAR' }
    ]
  };
  await assert.doesNotReject(() => policyEngine.enforceOutboundSafety(safePayload));

  // Dangerous payload containing raw secret from vault
  const leakedPayload = {
    task_id: 'task_1',
    elements: [
      { id: 'el_1', label: 'Aadhaar', value: '4821 7392 0184' } // Leaking raw vault secret
    ]
  };
  await assert.rejects(
    () => policyEngine.enforceOutboundSafety(leakedPayload),
    OutboundPolicyViolationError,
    'Must throw OutboundPolicyViolationError when raw secret is leaked'
  );
});

test('DOMSanitizer - Scrubs PII-shaped example text from placeholders', async () => {
  const vault = new LocalVault();
  const sanitizer = new DOMSanitizer(undefined, undefined, vault);

  const rawElements = [
    {
      id: 'el_1',
      tag: 'input',
      type: 'text',
      name: 'pan_number',
      label: 'Permanent Account Number (PAN)',
      placeholder: 'ABCDE1234F',
      value: ''
    },
    {
      id: 'el_2',
      tag: 'input',
      type: 'tel',
      name: 'phone',
      label: 'Registered Mobile Number',
      placeholder: '9876543210',
      value: ''
    }
  ];

  const { sanitizedElements } = sanitizer.sanitizeElements(rawElements);
  const safePayload = { task_id: 't', sanitized_dom: { elements: sanitizedElements } };

  const panEl = sanitizedElements.find((e) => e.id === 'el_1');
  assert.ok(!panEl.placeholder.includes('ABCDE1234F'), 'PAN example placeholder must be scrubbed');
  // Field identity (label/name) is preserved for the model
  assert.ok(panEl.label.includes('PAN'), 'Field label must be preserved');

  const phoneEl = sanitizedElements.find((e) => e.id === 'el_2');
  assert.ok(!phoneEl.placeholder.includes('9876543210'), 'Phone example placeholder must be scrubbed');

  // The scrubbed payload must pass the outbound policy gate (vault holds same defaults)
  const policyEngine = new PolicyEngine(vault);
  await assert.doesNotReject(
    () => policyEngine.enforceOutboundSafety(safePayload),
    'Scrubbed demo-page payload must pass the outbound policy gate'
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


test('DOMSanitizer - vault substrings must not corrupt labels (Female vs male)', async () => {
  const { DOMSanitizer } = await import('../../extension/privacy/dom-sanitizer.js');
  const sanitizer = new DOMSanitizer();
  assert.equal(sanitizer.scrubPlaceholderText('Female'), 'Female');
  assert.equal(sanitizer.sanitizeUserPrompt('Gender Female Other'), 'Gender Female Other');
});
