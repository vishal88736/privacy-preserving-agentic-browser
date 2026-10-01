import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bootPage, FakeElement } from './harness.mjs';

/**
 * Attaching a stored vault document to a page file input.
 *
 * These run against the SHIPPED content script through the harness, so what is
 * asserted is what a page would actually observe. The properties that matter:
 *
 *   - The input ends up holding a File with the stored name, type and exact
 *     bytes, and both `input` and `change` are dispatched. A page whose
 *     framework only listens for `change` (React, Angular, Vue) otherwise
 *     believes the field is still empty and never submits what was attached.
 *   - The target must really be `input[type=file]`. Anything else is refused.
 *   - Only a descriptor the background built from the vault is accepted: the
 *     marker and the token grammar are both re-checked in the page.
 *   - The bytes are never returned, and never reach a log line.
 *
 * There is no separate synthetic upload path: only a descriptor made from a
 * named vault document can attach bytes to a page input.
 */

const CONTENT_SOURCE = readFileSync(
  fileURLToPath(new URL('../../extension/content/content.js', import.meta.url)), 'utf8'
);

/** Exactly what the background posts for a vault document. */
function documentPayload(overrides = {}) {
  return {
    __vaultDocument: true,
    name: 'LOCAL_DOCUMENT_AADHAAR',
    fileName: 'aadhar.png',
    mimeType: 'image/png',
    byteLength: 27,
    data: Buffer.from('SYNTHETIC-IDENTITY-DOCUMENT').toString('base64'),
    ...overrides
  };
}

async function extractedFileInput() {
  const fileInput = new FakeElement('input', { type: 'file', name: 'aadhaar', id: 'doc' });
  const page = bootPage({ elements: [fileInput] });
  const extraction = await page.send('EXTRACT_DOM', {});
  const element = extraction.data.elements.find((el) => el.type === 'file');
  assert.ok(element, 'the file input must be part of the observation');
  return { page, fileInput, elementId: element.id };
}

test('a stored document is attached and both events reach the page', async () => {
  const { page, fileInput, elementId } = await extractedFileInput();

  const result = await page.send('EXECUTE_ACTION', {
    action: 'UPLOAD',
    target: { element_id: elementId },
    resolvedValue: documentPayload()
  });

  assert.equal(result.success, true, result.error);
  assert.equal(fileInput.files.length, 1, 'the input must hold exactly one file');
  const [file] = fileInput.files;
  assert.equal(file.name, 'aadhar.png');
  assert.equal(file.type, 'image/png');
  assert.equal(file.size, 27, 'the file must carry the stored bytes, byte for byte');
  assert.deepEqual(Array.from(file.parts[0]), Array.from(Buffer.from('SYNTHETIC-IDENTITY-DOCUMENT')));
  assert.ok(fileInput.events.includes('input'), 'a framework tracking the input must be notified');
  assert.ok(fileInput.events.includes('change'), 'a framework tracking the change must be notified');
  assert.ok(fileInput.events.indexOf('input') < fileInput.events.indexOf('change'),
    'input is dispatched before change, as a real selection does');
});

test('the result carries the token and size, never the file name or the bytes', async () => {
  const { page, elementId } = await extractedFileInput();
  const result = await page.send('EXECUTE_ACTION', {
    action: 'UPLOAD',
    target: { element_id: elementId },
    resolvedValue: documentPayload()
  });
  assert.equal(result.document, 'LOCAL_DOCUMENT_AADHAAR');
  assert.equal(result.byteLength, 27);
  const serialized = JSON.stringify(result);
  // The FILE NAME must not travel back. This result is stored on the task and
  // feeds task_history, which the planner reads on the next step, and the whole
  // premise of the local vault is that file names never leave the device --
  // "Aadhaar_Scan_Final.pdf" would name the document to the server.
  assert.ok(!serialized.includes('aadhar.png'),
    'the stored file name must not appear in the action result');
  assert.ok(!serialized.includes('uploadedFile'),
    'no uploadedFile field may be returned to the background');
  assert.ok(!serialized.includes('SYNTHETIC-IDENTITY-DOCUMENT'), 'the body must not be echoed back');
  assert.ok(!serialized.includes(documentPayload().data), 'the encoded body must not be echoed back');
});

test('the file name reaches the page even though it never reaches the background', async () => {
  // The page still needs the real name to display it, and only the page sees it.
  const { page, fileInput, elementId } = await extractedFileInput();
  await page.send('EXECUTE_ACTION', {
    action: 'UPLOAD',
    target: { element_id: elementId },
    resolvedValue: documentPayload()
  });
  assert.equal(fileInput.files.length, 1);
  assert.equal(fileInput.files[0].name, 'aadhar.png',
    'the page must still receive the real file name');
});

test('a TYPE carrying a document token is refused; attachments require UPLOAD', async () => {
  const { page, fileInput, elementId } = await extractedFileInput();
  const result = await page.send('EXECUTE_ACTION', {
    action: 'TYPE',
    target: { element_id: elementId },
    resolvedValue: documentPayload()
  });
  assert.equal(result.success, false);
  assert.match(result.error, /UPLOAD/);
  assert.equal(fileInput.files, null, 'TYPE must not attach a document');
});

test('a stored document is refused on anything that is not a file input', async () => {
  const text = new FakeElement('input', { type: 'text', name: 'notes' });
  const page = bootPage({ elements: [text] });
  const extraction = await page.send('EXTRACT_DOM', {});

  const result = await page.send('EXECUTE_ACTION', {
    action: 'TYPE',
    target: { element_id: extraction.data.elements[0].id },
    resolvedValue: documentPayload()
  });
  assert.equal(result.success, false);
  assert.match(result.error, /file input/);
  assert.equal(text.files, null, 'nothing may be attached to a text field');
  assert.equal(text.value, '', 'the document must never be typed into a field');
});

test('an object that merely looks like a document is not accepted', async () => {
  const { page, fileInput, elementId } = await extractedFileInput();
  for (const fake of [
    { name: 'LOCAL_DOCUMENT_AADHAAR', data: 'U0lOVEVTVElD', fileName: 'x', mimeType: 'image/png' },
    { __vaultDocument: true, name: '../../etc/passwd', data: 'U0lOVEVTVElD' },
    { __vaultDocument: true, name: 'LOCAL_DOCUMENT_AADHAAR', data: 12345 },
    { __vaultDocument: 'yes', name: 'LOCAL_DOCUMENT_AADHAAR', data: 'U0lOVEVTVElD' }
  ]) {
    const result = await page.send('EXECUTE_ACTION', {
      action: 'UPLOAD',
      target: { element_id: elementId },
      resolvedValue: fake
    });
    assert.equal(result.success, false, `${JSON.stringify(fake).slice(0, 60)} must be refused`);
    assert.equal(fileInput.files, null, 'no unmarked payload may reach the input');
  }
});

test('a disabled file input is refused rather than silently filled', async () => {
  const fileInput = new FakeElement('input', { type: 'file', name: 'aadhaar', disabled: true });
  const page = bootPage({ elements: [fileInput] });
  const extraction = await page.send('EXTRACT_DOM', {});
  const result = await page.send('EXECUTE_ACTION', {
    action: 'UPLOAD',
    target: { element_id: extraction.data.elements[0].id },
    resolvedValue: documentPayload()
  });
  assert.equal(result.success, false);
  assert.match(result.error, /disabled/);
  assert.equal(fileInput.files, null);
});

test("a file input's own accept list is respected", async () => {
  const fileInput = new FakeElement('input', { type: 'file', name: 'aadhaar' });
  fileInput.setAttribute('accept', '.pdf,application/pdf');
  const page = bootPage({ elements: [fileInput] });
  const extraction = await page.send('EXTRACT_DOM', {});
  const result = await page.send('EXECUTE_ACTION', {
    action: 'UPLOAD',
    target: { element_id: extraction.data.elements[0].id },
    resolvedValue: documentPayload()
  });
  assert.equal(result.success, false, 'a PNG must not be attached to a PDF-only field');
  assert.match(result.error, /only accepts/);
  assert.equal(fileInput.files, null);

  // The same document is accepted when the field allows its type.
  const ok = await page.send('EXECUTE_ACTION', {
    action: 'UPLOAD',
    target: { element_id: extraction.data.elements[0].id },
    resolvedValue: documentPayload({ fileName: 'aadhar.pdf', mimeType: 'application/pdf' })
  });
  assert.equal(ok.success, true, ok.error);
  assert.equal(fileInput.files[0].name, 'aadhar.pdf');
});

test('a page-controlled file name cannot smuggle a path into the attachment', async () => {
  const { page, fileInput, elementId } = await extractedFileInput();
  const result = await page.send('EXECUTE_ACTION', {
    action: 'UPLOAD',
    target: { element_id: elementId },
    resolvedValue: documentPayload({ fileName: '../../home/me/passport\u0000.png' })
  });
  assert.equal(result.success, true, result.error);
  assert.ok(!fileInput.files[0].name.includes('/'), 'the attached name must be a bare file name');
  assert.ok(!fileInput.files[0].name.includes('\u0000'));
});

test('an unmarked synthetic upload payload is refused', async () => {
  const { page, fileInput, elementId } = await extractedFileInput();
  for (const untrusted of [
    { demo: true, content: 'SYNTHETIC DEMO FILE — NO PERSONAL DATA' },
    { demo: true, content: 'real file bytes' },
    { content: 'SYNTHETIC DEMO FILE — NO PERSONAL DATA' },
    { demo: true, content: documentPayload().data },
    'SYNTHETIC DEMO FILE — NO PERSONAL DATA'
  ]) {
    const result = await page.send('EXECUTE_ACTION', {
      action: 'UPLOAD',
      target: { element_id: elementId },
      resolvedValue: untrusted
    });
    assert.equal(result.success, false);
    assert.match(result.error, /named document from the local vault/);
    assert.equal(fileInput.files, null, 'untrusted payloads must never create a File');
  }
});

test('the shipped content script has no legacy synthetic upload implementation', () => {
  assert.doesNotMatch(CONTENT_SOURCE, /_executeUpload|SYNTHETIC DEMO FILE|synthetic-demo\.txt/);
});
