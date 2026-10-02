// Client-side conveniences of the proxy servers picker: a filter over the
// checkbox list and a "clear all" button.
//
// The filter HIDES rows and never removes them. A checkbox that leaves the DOM
// leaves the form with it, and the next save would quietly drop that server from
// the proxy — the very class of silent data loss this picker replaced. The module
// is an ES module on purpose: `applyFilter` is exported so the test suite can
// assert that property without a browser.
//
// The form itself does not depend on any of this: with JavaScript off the list is
// a plain set of checkboxes and the submit button still saves it. The controls
// that need the script are rendered `hidden` and are unhidden below.

/**
 * One row of the picker, as far as the filter is concerned. The `text` is what a
 * query is matched against (the server tag); `hidden` is flipped by the filter.
 *
 * @typedef {{text: string, hidden: boolean}} FilterRow
 */

/**
 * Hides the rows that do not match `query` and shows the rest. Matching ignores
 * case and surrounding spaces; an empty query shows everything. A row is never
 * dropped from the list — only its `hidden` flag changes, so a checked row stays
 * in the form and travels with the save.
 *
 * @param {FilterRow[]} rows
 * @param {string} query
 * @returns {number} Number of rows left visible.
 */
export function applyFilter(rows, query) {
  const needle = String(query ?? '')
    .trim()
    .toLowerCase();
  let visible = 0;

  for (const row of rows) {
    const match = needle.length === 0 || String(row.text).toLowerCase().includes(needle);
    row.hidden = !match;
    if (match) visible += 1;
  }

  return visible;
}

/**
 * A picker, seen as rows of `applyFilter`. The record proxies the `hidden`
 * property of the `<label>` straight onto the DOM, so the pure filter above
 * drives the real layout.
 *
 * @param {HTMLElement} label
 * @returns {FilterRow}
 */
function rowOf(label) {
  return {
    text: label.dataset.tag ?? '',
    get hidden() {
      return label.hidden;
    },
    set hidden(value) {
      label.hidden = value;
    },
  };
}

/**
 * Wires one picker. Called for the panel rendered in the page and again after
 * every htmx swap, because htmx replaces the markup wholesale.
 *
 * @param {HTMLElement} picker
 */
function wirePicker(picker) {
  if (picker.dataset.wired === '1') return;
  picker.dataset.wired = '1';

  const tools = picker.querySelector('[data-servers-tools]');
  const filterInput = picker.querySelector('[data-servers-filter]');
  const clearButton = picker.querySelector('[data-servers-clear]');
  const labels = [...picker.querySelectorAll('[data-server]')];

  if (tools !== null) {
    tools.hidden = false;
    if (clearButton !== null) clearButton.hidden = false;
  }

  if (filterInput !== null) {
    const rows = labels.map(rowOf);
    const apply = () => applyFilter(rows, filterInput.value);
    filterInput.addEventListener('input', apply);
    // A browser may restore the value of the field on reload; honour it.
    apply();
  }

  if (clearButton !== null) {
    clearButton.addEventListener('click', () => {
      for (const label of labels) {
        const box = label.querySelector('input[type="checkbox"]');
        if (box !== null) box.checked = false;
      }
    });
  }
}

/**
 * True when a branch belongs to the chosen exit kind. A pure function on purpose,
 * like `applyFilter`: the rule is exported so the test suite can pin it without a
 * browser.
 *
 * @param {string} kind Value of the `[data-exit-kind]` combo.
 * @param {string} branchKind Value of one `[data-exit-branch]`.
 * @returns {boolean}
 */
export function isActiveBranch(kind, branchKind) {
  return kind === branchKind;
}

/**
 * Wires one exit selector of the proxy form: the combo decides which branch is
 * shown. The branches are only HIDDEN, never removed, and the server reads
 * `exit_kind` as the arbiter, so the form still works with the script absent —
 * then both branches are visible and the ignored one is discarded on save. The
 * fields of the hidden branch are disabled as well, so an untouched save cannot
 * carry the other branch along.
 *
 * @param {HTMLSelectElement} combo
 */
function wireExitKind(combo) {
  if (combo.dataset.wired === '1') return;
  combo.dataset.wired = '1';

  const form = combo.closest('form');
  if (form === null) return;
  const branches = [...form.querySelectorAll('[data-exit-branch]')];

  const apply = () => {
    for (const branch of branches) {
      const active = isActiveBranch(combo.value, branch.dataset.exitBranch ?? '');
      branch.hidden = !active;
      for (const field of branch.querySelectorAll('input, select, textarea, button')) {
        field.disabled = !active;
      }
    }
  };

  combo.addEventListener('change', apply);
  apply();
}

/**
 * Wires one provider «вид» select: it shows only the block of the chosen kind
 * (`[data-kind-block="subscription"]` for a subscription), so the suffix can be
 * typed in the SAME submit that picks the kind — no reload. Without the script
 * every block stays visible, and the model ignores the fields that do not belong
 * to the effective kind.
 *
 * @param {HTMLSelectElement} select
 */
function wireKindToggle(select) {
  if (select.dataset.wired === '1') return;
  select.dataset.wired = '1';
  const form = select.closest('form');
  if (form === null) return;
  const blocks = [...form.querySelectorAll('[data-kind-block]')];

  const apply = () => {
    for (const block of blocks) block.hidden = block.dataset.kindBlock !== select.value;
  };
  select.addEventListener('change', apply);
  apply();
}

/**
 * Value of one form field, in the shape the form would SUBMIT it: a checkbox that
 * is not checked sends nothing, so it counts as the empty string.
 *
 * @param {HTMLElement} field
 * @returns {string}
 */
function fieldValue(field) {
  if (field.type === 'checkbox' || field.type === 'radio') return field.checked ? field.value : '';
  return field.value;
}

/**
 * Wires one button that DISCARDS the open edit form («Откатить», «Перечитать с
 * диска»): when the form differs from its initial values, the confirmation says
 * the edits will be lost. Plain DOM, no library; without the script there is no
 * warning, which is the honest fallback.
 *
 * @param {HTMLElement} button
 */
function wireFormGuard(button) {
  if (button.dataset.wired === '1') return;
  button.dataset.wired = '1';
  const form = document.querySelector(button.dataset.formGuard ?? '');
  if (form === null) return;

  const fields = [...form.elements];
  const baseline = new Map(fields.map((field) => [field, fieldValue(field)]));
  const changed = () => fields.some((field) => baseline.get(field) !== fieldValue(field));
  const base = button.dataset.baseConfirm ?? button.getAttribute('hx-confirm') ?? '';

  const apply = () => {
    if (changed()) {
      button.setAttribute('hx-confirm', `${base} Правки на открытой панели будут потеряны.`.trim());
    } else if (base.length > 0) {
      button.setAttribute('hx-confirm', base);
    } else {
      button.removeAttribute('hx-confirm');
    }
  };
  form.addEventListener('input', apply);
  form.addEventListener('change', apply);
  apply();
}

/**
 * Wires one «Скопировать» button: it puts the text of the element named by its
 * `data-copy` selector (a CSS selector, e.g. `#sudoers-lines`) into the
 * clipboard. Without JavaScript the block is still selectable by hand, which is
 * the fallback the screen relies on — no library and no hidden state.
 *
 * @param {HTMLElement} button
 */
function wireCopy(button) {
  if (button.dataset.wired === '1') return;
  button.dataset.wired = '1';
  const target = document.querySelector(button.dataset.copy ?? '');
  if (target === null) return;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(target.textContent ?? '');
      button.textContent = 'Скопировано';
    } catch {
      // No clipboard permission (or an insecure origin): leave the text to be
      // selected by hand rather than failing loudly.
    }
  });
}

/** Wires every control of the document, if any. */
function setup() {
  for (const picker of document.querySelectorAll('[data-servers-picker]')) wirePicker(picker);
  for (const combo of document.querySelectorAll('[data-exit-kind]')) wireExitKind(combo);
  for (const select of document.querySelectorAll('[data-kind-toggle]')) wireKindToggle(select);
  for (const guard of document.querySelectorAll('[data-form-guard]')) wireFormGuard(guard);
  for (const button of document.querySelectorAll('[data-copy]')) wireCopy(button);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
  // htmx swaps the panel's innerHTML; the swapped-in picker needs wiring too.
  // Listening on the document needs no reference to the htmx global.
  document.addEventListener('htmx:afterSwap', setup);
}
