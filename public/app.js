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

/** Wires every picker and exit selector of the document, if any. */
function setup() {
  for (const picker of document.querySelectorAll('[data-servers-picker]')) wirePicker(picker);
  for (const combo of document.querySelectorAll('[data-exit-kind]')) wireExitKind(combo);
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
