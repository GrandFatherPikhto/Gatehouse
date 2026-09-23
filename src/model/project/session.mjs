// The open document: open / new / save / reload, the dirty flag and the two
// notices that live until a save.
//
// Behavioural reference:
// /home/yevstigneevda/Projects/Python/SingBoxTools/generator/model.py — the dirty
// flag, open/save/new and the snapshots are ported from there by sense, with the
// exact rules taken from that file. The divergence is deliberate: the flat
// document of version 2 has no profile envelope, and `open` still knows the old
// shape and migrates it once.
//
// Migration lives in the MODEL and not in the core on purpose: the CLI path
// never writes the owner's file, it only refuses it (see `validateSettings`), so
// a half-migrated document can never reach a generated `config.json`.
//
// The class knows nothing about HTTP: routes parse a request, call a method and
// hand the result to a template. One rule is worth stating up front, because
// everything else follows from it: user-facing rejections throw `ConfigError`
// with a Russian message, which is what the form shows to the owner. There is no
// silent clamping anywhere.

import fs from 'node:fs';
import path from 'node:path';

import {ConfigError, isMapping} from '../../core/errors.mjs';
import {
  dropRemovedSettings,
  isLegacyDocument,
  removedSettingsMessage,
  validateSettings,
} from '../../core/settings.mjs';
import {
  DEFAULT_SNAPSHOT_KEEP,
  DEFAULT_STATE_DIR,
  canonicalJson,
  takeSnapshot,
  writeAtomic,
} from '../storage.mjs';
import {migrateLegacyDocument, newDocument} from './document.mjs';
import {migrateProviders, resolvedProvidersRoot} from './providers.mjs';

/**
 * The state of one open `webui.json`.
 */
export class ProjectSession {
  /**
   * @param {{path?: string|null, stateDir?: string, snapshotKeep?: number,
   *   amneziaDir?: string, providersDir?: string}} [options]
   *   `path` opens an existing file immediately; `stateDir` is where snapshots
   *   go, `.state` beside the project by default. `amneziaDir` and `providersDir`
   *   come from `GATEHOUSE_AMNEZIA_DIR` / `GATEHOUSE_PROVIDERS`; the web layer,
   *   which alone may read the environment, fills them in.
   */
  constructor(options = {}) {
    this.stateDir = options.stateDir ?? path.join(process.cwd(), DEFAULT_STATE_DIR);
    this.snapshotKeep = options.snapshotKeep ?? DEFAULT_SNAPSHOT_KEEP;
    /**
     * Directory of the tunnel configs, handed in by the web layer from
     * `GATEHOUSE_AMNEZIA_DIR`. It is the only source beside the build constant
     * `DEFAULT_AMNEZIA_DIR`; the document no longer carries an `amnezia_dir`.
     *
     * @type {string}
     */
    this.defaultAmneziaDir = typeof options.amneziaDir === 'string' ? options.amneziaDir : '';
    /**
     * Root of the provider folders, handed in by the web layer from
     * `GATEHOUSE_PROVIDERS`; empty means "read the variable, else the default".
     *
     * @type {string}
     */
    this.providersDir = typeof options.providersDir === 'string' ? options.providersDir : '';
    this.path = null;
    this.document = newDocument();
    /**
     * Outcome of the last `open` that migrated a version-1 file: `null` when
     * nothing was migrated. The web layer shows the warnings once, so a silent
     * rewrite of the owner's file is impossible.
     *
     * @type {{snapshot: string|null, warnings: string[]}|null}
     */
    this.lastMigration = null;
    /**
     * Warnings of the last `open` that migrated the `sources` field into
     * `providers`. `null` when there was nothing to convert; the web layer shows
     * the lines once and a save makes them true no more.
     *
     * @type {{warnings: string[]}|null}
     */
    this.lastProvidersMigration = null;
    /**
     * Names of the fields of the removed Watchdog that were in the file at load
     * time. The web layer shows one line about them while they are still listed
     * here; a save clears the list, because after a save they are gone from the
     * file and the line would be a lie.
     *
     * @type {string[]}
     */
    this.lastRemoved = [];
    this.#dirty = false;
    if (options.path) this.open(options.path);
  }

  /** @type {boolean} */
  #dirty;

  /** True when the in-memory document differs from the file on disk. */
  get dirty() {
    return this.#dirty;
  }

  /**
   * The one line the editor shows about the fields of the removed Watchdog, or
   * `null` when the loaded file had none.
   *
   * It lives until a save on purpose: the fields are still in the file until then,
   * and the line says so. After a save the list is empty and the line is gone.
   *
   * @type {string|null}
   */
  get removedNotice() {
    return this.lastRemoved.length === 0 ? null : removedSettingsMessage(this.lastRemoved);
  }

  /**
   * The lines the editor shows about the `sources` → `providers` migration of the
   * last open, or `null` when there was none. They live until a save, exactly like
   * the removed-fields notice: the file still carries the old form until then.
   *
   * @type {string|null}
   */
  get providersMigrationNotice() {
    return this.lastProvidersMigration === null ||
      this.lastProvidersMigration.warnings.length === 0
      ? null
      : this.lastProvidersMigration.warnings.join(' ');
  }

  /** Marks the document as changed (reference: `mark_dirty`). */
  markDirty() {
    this.#dirty = true;
  }

  /** Marks the document as saved (reference: `mark_clean`). */
  markClean() {
    this.#dirty = false;
  }

  /** Reference: `display_name`. */
  get displayName() {
    return this.path ? path.basename(this.path) : 'webui.json (новый)';
  }

  /** Directory relative paths resolve against. Reference: `settings_dir`. */
  get settingsDir() {
    return this.path ? path.dirname(this.path) : process.cwd();
  }

  /**
   * True when the bound file is on disk. A document created by `newProject` is
   * not there yet, and the header says so instead of pretending it was saved.
   *
   * @returns {boolean}
   */
  get fileExists() {
    return this.path !== null && fs.existsSync(this.path);
  }

  // ------------------------------------------------------------------
  // New / Open / Save  (reference: new / open / save)
  // ------------------------------------------------------------------

  /**
   * Replaces the document with a fresh minimal one and forgets the file.
   * Reference: `ProjectModel.new`.
   *
   * @param {string|null} [target] Optional path the new document is bound to.
   * @returns {Record<string, unknown>}
   */
  newProject(target = null) {
    this.document = newDocument();
    this.path = target ? path.resolve(target) : null;
    this.lastMigration = null;
    this.lastProvidersMigration = null;
    this.lastRemoved = [];
    this.markClean();
    return this.document;
  }

  /**
   * Loads `webui.json`. A version-1 file is migrated in place, once: the old
   * bytes are snapshotted first, then the flat document is written, and the
   * warnings are kept on `lastMigration` for the UI to show.
   *
   * @param {string} target
   * @returns {Record<string, unknown>}
   */
  open(target) {
    const resolved = path.resolve(target);
    const settingsDir = path.dirname(resolved);
    // The root is resolved against the directory of the file being OPENED, not
    // against `this.settingsDir`, which still names the file the model was bound
    // to before this call.
    const root = resolvedProvidersRoot(this, settingsDir);
    const raw = this.#readJson(resolved);

    if (isLegacyDocument(raw)) {
      const {document, warnings, linksFile} = migrateLegacyDocument(raw, resolved);
      // A version-1 file kept the Watchdog fields per profile, so the migration
      // may carry them along: they are dropped from its RESULT as well.
      this.lastRemoved = dropRemovedSettings(document);
      // The `sources` → `providers` migration runs BEFORE validation, because the
      // schema no longer knows `sources` and `dropRemovedSettings` would otherwise
      // drop it without ever enabling a provider.
      const migrated = migrateProviders(document, root, settingsDir, linksFile !== null);
      validateSettings(document, resolved);
      const snapshot = takeSnapshot(resolved, this.stateDir, {keep: this.snapshotKeep});
      writeAtomic(resolved, canonicalJson(document));
      this.document = document;
      this.lastMigration = {
        snapshot: snapshot === null ? null : snapshot.path,
        warnings: [...warnings, ...migrated],
      };
      this.lastProvidersMigration = null;
    } else {
      // Migrated BEFORE `dropRemovedSettings`, for the same reason: `sources` must
      // become `providers`, not vanish. Neither touches the file here — the fields
      // leave it on the next ordinary save.
      const migrated = migrateProviders(raw, root, settingsDir, false);
      this.lastRemoved = dropRemovedSettings(raw);
      validateSettings(raw, resolved);
      this.document = raw;
      this.lastMigration = null;
      this.lastProvidersMigration = migrated.length > 0 ? {warnings: migrated} : null;
    }

    this.path = resolved;
    this.markClean();
    return this.document;
  }

  /**
   * Re-reads the bound file, dropping every unsaved change. Reference: the
   * "reload" the Qt window offered through `open_path`.
   *
   * @returns {Record<string, unknown>}
   */
  reload() {
    if (this.path === null) throw new ConfigError('файл ещё не открыт: перезагружать нечего');
    return this.open(this.path);
  }

  /**
   * Writes the document: a snapshot of the previous version first, then an
   * atomic replace.
   *
   * The document is validated BEFORE anything is written, so a broken edit can
   * never produce a `webui.json` the tool itself would refuse to open.
   *
   * @returns {{path: string, snapshot: string|null, removed: string[]}}
   */
  save() {
    if (this.path === null) throw new ConfigError('не задан путь для сохранения webui.json');
    validateSettings(this.document, this.path);

    const snapshot = takeSnapshot(this.path, this.stateDir, {keep: this.snapshotKeep});
    writeAtomic(this.path, canonicalJson(this.document));
    // Whatever the Watchdog left behind is gone from the file now, so the line the
    // editor shows about it must go as well. Same for the providers migration
    // notice: the file carries `providers` after this save.
    this.lastRemoved = [];
    this.lastProvidersMigration = null;
    this.markClean();
    return {
      path: this.path,
      snapshot: snapshot === null ? null : snapshot.path,
      removed: snapshot === null ? [] : snapshot.removed,
    };
  }

  /**
   * The document as the canonical `webui.json` text. Kept next to `save` so a
   * test can compare bytes without touching the disk.
   *
   * @returns {string}
   */
  toText() {
    return canonicalJson(this.document);
  }

  /**
   * Puts the in-memory document back to a canonical text taken earlier with
   * `toText`, without touching the file. It is the rollback the web layer needs
   * when one edit form maps to several routes and a later route refuses: the
   * model works on the live document, so without this a half-applied panel would
   * stay in memory while the owner only sees the refusal.
   *
   * The text comes from `toText`, i.e. from a document that already passed
   * validation, so it is parsed and checked with the same loader `reload` uses.
   * The dirty flag is left alone on purpose: the caller knows whether there were
   * unsaved edits before and restores it, because "not dirty" and "dirty since
   * before" are two different states.
   *
   * @param {string} text Canonical text produced by `toText`.
   * @returns {void}
   */
  restoreText(text) {
    const data = JSON.parse(text);
    validateSettings(data, this.path ?? this.displayName);
    this.document = data;
  }

  // ------------------------------------------------------------------
  // Effective settings  (reference: output_file / listen_ip)
  // ------------------------------------------------------------------

  /**
   * The flat body of the document, without the format-only keys (`version`) and
   * without the comments (`note`). This is the shape the core works on.
   *
   * @returns {Record<string, unknown>}
   */
  body() {
    return this.document;
  }

  /**
   * The effective settings with the format-only keys and the `note` fields
   * dropped — the exact shape `loadEffectiveSettings` of the core returns in its
   * `settings` property. The parity is asserted by a test, and duplicating six
   * lines here is cheaper than changing the accepted core.
   *
   * @returns {Record<string, unknown>}
   */
  effectiveSettings() {
    const settings = {};
    for (const [key, value] of Object.entries(this.document)) {
      if (key === 'version' || key === 'note') continue;
      settings[key] = value;
    }
    if (Array.isArray(settings.proxies)) {
      settings.proxies = settings.proxies.map((proxy) => {
        if (!isMapping(proxy) || !Object.hasOwn(proxy, 'note')) return proxy;
        const {note, ...rest} = proxy;
        return rest;
      });
    }
    return settings;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Reads and parses a JSON file, with the wording of the core.
   *
   * @param {string} resolved
   * @returns {unknown}
   */
  #readJson(resolved) {
    let text;
    try {
      text = fs.readFileSync(resolved, 'utf8');
    } catch (error) {
      throw new ConfigError(`ошибка чтения JSON ${resolved}: ${error.message}`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`ошибка чтения JSON ${resolved}: ${error.message}`);
    }
  }
}
