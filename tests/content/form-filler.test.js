import test from 'node:test';
import assert from 'node:assert/strict';
import { FormFiller } from '../../extension/content/form-filler.js';

class FakeSelect {
  constructor(options) {
    this.tagName = 'SELECT';
    this.type = 'select-one';
    this.options = options.map((option) => ({ ...option }));
    this.selectedIndex = this.options.findIndex((option) => option.selected);
    this.events = [];
  }
  get value() { return this.options[this.selectedIndex]?.value || ''; }
  set value(value) {
    this.selectedIndex = this.options.findIndex((option) => String(option.value) === String(value));
    this.options.forEach((option, index) => { option.selected = index === this.selectedIndex; });
  }
  scrollIntoView() {}
  focus() {}
  dispatchEvent(event) { this.events.push(event.type); }
}

function makeSelect() {
  return new FakeSelect([
    { value: '', text: 'Choose…', selected: true },
    { value: 'us', text: 'United States', selected: false },
    { value: 'in', text: 'India', selected: false }
  ]);
}

test('native select resolves India and US country aliases and verifies the actual selected option', async () => {
  const oldWindow = globalThis.window;
  globalThis.window = { HTMLSelectElement: FakeSelect };
  try {
    const filler = new FormFiller();
    for (const [target, expected] of [
      ['India', 'in'],
      ['United States', 'us'],
      ['USA', 'us'],
      ['United States of America', 'us']
    ]) {
      const select = makeSelect();
      const field = { value: target, semantic_type: 'country', control_type: 'SELECT' };
      await filler._fillElement(select, field);
      assert.equal(select.value, expected);
      assert.equal(select.options[select.selectedIndex].selected, true);
      assert.ok(select.events.includes('change'));
      assert.equal(await filler._verifyElement(select, field), true);
    }
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

test('checkbox fill preserves correct state and toggles only when the target differs', async () => {
  const filler = new FormFiller();
  const checkbox = (initial) => ({
    tagName: 'INPUT', type: 'checkbox', checked: initial, clicks: 0,
    scrollIntoView() {}, focus() {}, dispatchEvent() {},
    click() { this.clicks++; this.checked = !this.checked; }
  });

  const alreadyCorrect = checkbox(true);
  await filler._fillElement(alreadyCorrect, { value: 'yes', semantic_type: 'terms', control_type: 'CHECKBOX' });
  assert.equal(alreadyCorrect.checked, true);
  assert.equal(alreadyCorrect.clicks, 0);
  assert.equal(await filler._verifyElement(alreadyCorrect, { value: 'yes' }), true);

  const wrongState = checkbox(false);
  await filler._fillElement(wrongState, { value: 'yes', semantic_type: 'terms', control_type: 'CHECKBOX' });
  assert.equal(wrongState.checked, true);
  assert.equal(wrongState.clicks, 1);
  assert.equal(await filler._verifyElement(wrongState, { value: 'yes' }), true);
});

test('textarea uses its own native setter and dispatches framework input events', async () => {
  const oldWindow = globalThis.window;
  class FakeTextArea {
    constructor() { this.tagName = 'TEXTAREA'; this.type = 'textarea'; this._value = ''; this.events = []; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    scrollIntoView() {}
    focus() {}
    dispatchEvent(event) { this.events.push(event.type); }
  }
  globalThis.window = { HTMLTextAreaElement: FakeTextArea };
  try {
    const filler = new FormFiller();
    const textarea = new FakeTextArea();
    const field = { value: 'Synthetic address', semantic_type: 'address_line1', control_type: 'TEXTAREA' };
    await filler._fillElement(textarea, field);
    assert.equal(textarea.value, 'Synthetic address');
    assert.ok(textarea.events.includes('input'));
    assert.ok(textarea.events.includes('change'));
    assert.equal(await filler._verifyElement(textarea, field), true);
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});

test('radio fill selects the matching group member and leaves the rest unchecked', async () => {
  const oldDocument = globalThis.document;
  const radios = [];
  const makeRadio = (value, text) => ({
    tagName: 'INPUT', type: 'radio', name: 'gender', value, checked: false,
    scrollIntoView() {}, focus() {}, dispatchEvent() {},
    closest: () => ({ innerText: text }),
    click() {
      radios.forEach((radio) => { radio.checked = radio === this; });
    }
  });
  radios.push(makeRadio('male', 'Male'), makeRadio('female', 'Female'));
  globalThis.document = {
    querySelectorAll: (selector) => selector === 'input[type="radio"]' ? radios : []
  };
  try {
    const filler = new FormFiller();
    const field = { value: 'Male', semantic_type: 'gender', control_type: 'RADIO' };
    await filler._fillElement(radios[0], field);
    assert.equal(radios[0].checked, true);
    assert.equal(radios[1].checked, false);
    assert.equal(await filler._verifyElement(radios[0], field), true);
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});
