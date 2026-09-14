// The liveness watchdog of the editor.
//
// It lives in the editor PROCESS, outside `src/system/` (which stays the only
// module allowed to spawn a host command): the systemd unit already carries
// `Restart=always`, so the watchdog survives a crash without a unit of its own.
//
// The iron rule, and the reason this module reads a context instead of reaching
// for the model: the watchdog NEVER writes `webui.json` or `config.json`. Its whole
// power is closing connections of one proxy and restarting the daemon. The server
// a proxy uses lives in the config, so a watchdog that cannot touch the config
// cannot move the exit by accident — which is the one thing the owner forbids.
//
// The ladder and the fuses, exactly as the task states them:
//   1. after `failuresBeforeAction` (2 by default) consecutive failures — close
//      the connections of THAT proxy only, through the HTTP API;
//   2. if the next check fails again — `systemctl restart sing-box`, but only with
//      the second-rung switch on and only inside the daily limit.
// Fuses: a 10-minute interval, a pause between actions on one proxy, at most three
// restarts a day and then «сдаюсь», a global switch, and the per-proxy `watch` flag
// which is off by default. `api group select` is never used: moving a pinned proxy
// to another server is precisely what must not happen.

import {
  DEFAULT_WATCH_TIMEOUT,
  DEFAULT_WATCH_URL,
  restartSingBox,
  testInbound,
} from '../system/index.mjs';
import {closeInboundConnections} from './clash.mjs';

/** How many events the panel keeps. */
export const HISTORY_LIMIT = 20;

/** Watchdog defaults; the task fixes every number here. */
export const DEFAULT_WATCHDOG = Object.freeze({
  enabled: false,
  intervalSeconds: 600,
  failuresBeforeAction: 2,
  pauseSeconds: 1800,
  maxRestartsPerDay: 3,
  restartEnabled: false,
});

/** External API defaults; off by default, loopback only. */
export const DEFAULT_CLASH_API = Object.freeze({
  enabled: false,
  controller: '127.0.0.1:9090',
});

/** How long a restart counts towards the daily limit. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reads a positive integer with a floor, keeping the type out of the caller.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} [minimum]
 * @returns {number}
 */
function integer(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * Normalises the `watchdog` section of a profile/defaults.
 *
 * @param {unknown} value
 * @returns {{enabled: boolean, intervalSeconds: number, failuresBeforeAction: number,
 *   pauseSeconds: number, maxRestartsPerDay: number, restartEnabled: boolean}}
 */
export function normalizeWatchdog(value) {
  const data = typeof value === 'object' && value !== null ? value : {};
  return {
    enabled: data.enabled === true,
    intervalSeconds: integer(data.interval_seconds, DEFAULT_WATCHDOG.intervalSeconds, 10),
    failuresBeforeAction: integer(
      data.failures_before_action,
      DEFAULT_WATCHDOG.failuresBeforeAction,
      1,
    ),
    pauseSeconds: integer(data.pause_seconds, DEFAULT_WATCHDOG.pauseSeconds, 0),
    maxRestartsPerDay: integer(
      data.max_restarts_per_day,
      DEFAULT_WATCHDOG.maxRestartsPerDay,
      0,
    ),
    restartEnabled: data.restart_enabled === true,
  };
}

/**
 * Normalises the `clash_api` section of a profile/defaults.
 *
 * @param {unknown} value
 * @returns {{enabled: boolean, controller: string}}
 */
export function normalizeClashApi(value) {
  const data = typeof value === 'object' && value !== null ? value : {};
  const controller =
    typeof data.controller === 'string' && data.controller.length > 0
      ? data.controller
      : DEFAULT_CLASH_API.controller;
  return {enabled: data.enabled === true, controller};
}

/**
 * Normalises one proxy into the shape the watchdog uses.
 *
 * @param {Record<string, unknown>} proxy
 * @returns {{tag: string, type: string, port: number, watch: boolean, pinned: boolean, url: string}}
 */
export function normalizeProxy(proxy) {
  return {
    tag: typeof proxy?.tag === 'string' ? proxy.tag : '',
    type: typeof proxy?.type === 'string' ? proxy.type : 'socks',
    port: Number(proxy?.port),
    watch: proxy?.watch === true,
    pinned: proxy?.pinned === true,
    url:
      typeof proxy?.watch_url === 'string' && proxy.watch_url.length > 0
        ? proxy.watch_url
        : DEFAULT_WATCH_URL,
  };
}

/**
 * Human readable label of a proxy state, for the panel.
 *
 * @param {Record<string, unknown>} state
 * @returns {string}
 */
export function describeState(state) {
  if (state.givenUp) return 'сдаюсь';
  if (state.paused) return 'в паузе';
  if (state.lastOk === false && state.failures > 0) return 'не отвечает';
  if (state.lastOk === true) return 'отвечает';
  return 'ещё не проверялся';
}

/** The default journal sink: whatever the process prints lands in journald. */
function defaultLogger(line) {
  process.stdout.write(`[watchdog] ${line}\n`);
}

/**
 * The watchdog state machine. It owns no timers unless `start()` is called, so a
 * test can drive `checkAll()` by hand and never leaves a background loop behind.
 */
export class Watchdog {
  /**
   * @param {{context?: () => (Record<string, unknown>|null),
   *   env?: Record<string, string|undefined>, now?: () => number,
   *   runner?: (proxy: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<Record<string, unknown>>,
   *   api?: {closeInboundConnections: Function},
   *   restart?: () => Promise<Record<string, unknown>>,
   *   logger?: (line: string) => void}} [options]
   */
  constructor(options = {}) {
    this.getContext = options.context ?? (() => null);
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? defaultLogger;
    this.api = options.api ?? {closeInboundConnections};
    this.restart = options.restart ?? (() => restartSingBox({env: this.env}));
    this.runner =
      options.runner ??
      ((proxy, ctx) =>
        testInbound({
          env: this.env,
          listenIp: ctx.listenIp,
          port: proxy.port,
          proxyType: proxy.type,
          url: proxy.url,
          timeout: DEFAULT_WATCH_TIMEOUT,
        }));

    this.timer = null;
    this.running = false;
    this.reset();
  }

  /** Forgets every counter, the history and the restarts. */
  reset() {
    this.proxies = new Map();
    this.history = [];
    this.restarts = [];
    this.lastRun = null;
  }

  /** Starts the interval loop. The timer is unref'ed: it never holds the process. */
  start(intervalSeconds = null) {
    if (this.timer !== null) return;
    const context = this.#context();
    const seconds =
      intervalSeconds ?? context?.watchdog?.intervalSeconds ?? DEFAULT_WATCHDOG.intervalSeconds;
    this.timer = setInterval(() => {
      this.checkAll().catch(() => {});
    }, Math.max(10, seconds) * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stops the interval loop. */
  stop() {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Checks every watched proxy once. Records nothing when the global switch is off.
   *
   * @returns {Promise<Record<string, unknown>>}
   */
  async checkAll() {
    const context = this.#context();
    if (context === null || context.watchdog.enabled !== true) {
      this.lastRun = {at: new Date(this.now()).toISOString(), skipped: 'disabled', checked: 0};
      return this.lastRun;
    }

    if (this.running) {
      this.lastRun = {at: new Date(this.now()).toISOString(), skipped: 'busy', checked: 0};
      return this.lastRun;
    }

    this.running = true;
    try {
      const watched = (context.proxies ?? []).filter((proxy) => proxy.watch === true);
      const events = [];
      for (const proxy of watched) {
        events.push(await this.#checkProxy(proxy, context));
      }
      this.lastRun = {
        at: new Date(this.now()).toISOString(),
        skipped: null,
        checked: watched.length,
        events,
      };
      return this.lastRun;
    } finally {
      this.running = false;
    }
  }

  /**
   * A snapshot for the panel: the state of every proxy the context knows and the
   * history of the last decisions.
   *
   * @returns {Record<string, unknown>}
   */
  snapshot() {
    const context = this.#context();
    const proxies = (context?.proxies ?? []).map((proxy) => {
      const state = this.#state(proxy.tag);
      return {
        tag: proxy.tag,
        watch: proxy.watch,
        pinned: proxy.pinned,
        url: proxy.url,
        port: proxy.port,
        failures: state.failures,
        checks: state.checks,
        lastCheckAt: state.lastCheckAt,
        lastOk: state.lastOk,
        lastError: state.lastError,
        lastAction: state.lastAction,
        lastActionAt: state.lastActionAt,
        rung: state.rung,
        givenUp: state.givenUp,
        paused: state.paused,
        label: describeState(state),
      };
    });

    return {
      running: this.running,
      lastRun: this.lastRun,
      restartsLastDay: this.#pruneRestarts().length,
      history: [...this.history].reverse(),
      proxies,
    };
  }

  /**
   * The proxy state record, created on first use.
   *
   * @param {string} tag
   * @returns {Record<string, unknown>}
   */
  #state(tag) {
    let state = this.proxies.get(tag);
    if (state === undefined) {
      state = {
        failures: 0,
        checks: 0,
        lastCheckAt: null,
        lastOk: null,
        lastError: null,
        rung: 0,
        lastAction: null,
        lastActionAt: null,
        paused: false,
        givenUp: false,
      };
      this.proxies.set(tag, state);
    }
    return state;
  }

  /** @returns {Record<string, unknown>|null} */
  #context() {
    let context;
    try {
      context = this.getContext();
    } catch {
      // A document that cannot be read right now means "nothing to watch", never
      // a 500 in front of the owner.
      return null;
    }
    if (context === null || context === undefined) return null;
    return {
      ...context,
      watchdog: normalizeWatchdog(context.watchdog),
      api: normalizeClashApi(context.api),
    };
  }

  /**
   * Runs one check and applies the ladder to its result.
   *
   * @param {Record<string, unknown>} proxy
   * @param {Record<string, unknown>} context
   * @returns {Promise<Record<string, unknown>>}
   */
  async #checkProxy(proxy, context) {
    const state = this.#state(proxy.tag);
    const at = new Date(this.now()).toISOString();

    let result;
    try {
      result = await this.runner(proxy, context);
    } catch (error) {
      result = {ok: false, error: error.message, timedOut: false};
    }

    state.checks += 1;
    state.lastCheckAt = at;
    state.lastOk = Boolean(result.ok);
    state.lastError = result.ok ? null : result.error ?? null;
    state.paused = false;

    const event = {
      time: at,
      tag: proxy.tag,
      url: proxy.url,
      check: result.ok ? 'ok' : result.timedOut ? 'timeout' : 'fail',
      action: null,
      reason: null,
      helped: null,
    };

    if (result.ok) {
      const helped = state.rung > 0;
      state.failures = 0;
      state.rung = 0;
      state.givenUp = false;
      event.helped = helped;
      return this.#record(event);
    }

    state.failures += 1;
    event.failures = state.failures;

    const wd = context.watchdog;
    if (state.givenUp) {
      event.reason = 'сдаюсь: суточный предел перезапусков исчерпан';
      return this.#record(event);
    }

    if (state.failures < wd.failuresBeforeAction) return this.#record(event);

    if (this.#inPause(state, wd)) {
      state.paused = true;
      event.reason = 'пауза между действиями этого прокси ещё не истекла';
      return this.#record(event);
    }

    // Rung 1 once, then rung 2 on every further failure — until the daily limit
    // makes the watchdog give up. `rung` records the highest step reached, not the
    // number of times it ran, so a restart that did not help is retried after the
    // pause instead of leaving the proxy stuck at step one forever.
    if (state.rung === 0) return this.#closeConnections(proxy, context, state, event);
    if (state.failures >= wd.failuresBeforeAction + 1) {
      return this.#restartDaemon(context, state, event);
    }

    event.reason = 'первая ступень уже выполнена, ждём следующей проверки';
    return this.#record(event);
  }

  /**
   * Rung 1: close the connections of this ONE proxy. The server is untouched.
   *
   * @param {Record<string, unknown>} proxy
   * @param {Record<string, unknown>} context
   * @param {Record<string, unknown>} state
   * @param {Record<string, unknown>} event
   * @returns {Promise<Record<string, unknown>>}
   */
  async #closeConnections(proxy, context, state, event) {
    if (context.api.enabled !== true) {
      event.reason = 'HTTP-API выключен: закрыть соединения нельзя';
      return this.#record(event);
    }

    try {
      const outcome = await this.api.closeInboundConnections(
        context.api.controller,
        context.api.secret ?? '',
        {tag: proxy.tag, port: proxy.port},
      );
      state.rung = 1;
      state.lastAction = 'close';
      state.lastActionAt = this.now();
      event.action = 'close';
      event.closed = outcome.closed;
      event.reason = `закрыто соединений этого прокси: ${outcome.closed}`;
    } catch (error) {
      event.reason = `не удалось закрыть соединения: ${error.message}`;
    }
    return this.#record(event);
  }

  /**
   * Rung 2: restart the daemon. Global, hence the daily limit and the switch.
   *
   * @param {Record<string, unknown>} context
   * @param {Record<string, unknown>} state
   * @param {Record<string, unknown>} event
   * @returns {Promise<Record<string, unknown>>}
   */
  async #restartDaemon(context, state, event) {
    const wd = context.watchdog;
    if (!wd.restartEnabled || wd.maxRestartsPerDay <= 0) {
      event.reason = 'вторая ступень (перезапуск демона) выключена';
      return this.#record(event);
    }

    if (this.#pruneRestarts().length >= wd.maxRestartsPerDay) {
      state.givenUp = true;
      event.reason = `сдаюсь: больше ${wd.maxRestartsPerDay} перезапусков в сутки не делаю`;
      return this.#record(event);
    }

    try {
      const outcome = await this.restart();
      state.rung = 2;
      state.lastAction = 'restart';
      state.lastActionAt = this.now();
      this.restarts.push(this.now());
      event.action = 'restart';
      event.reason = outcome?.ok
        ? 'демон перезапущен (рвутся соединения у ВСЕХ прокси)'
        : `перезапуск не удался: ${outcome?.error ?? outcome?.stderr ?? 'без вывода'}`;
    } catch (error) {
      event.reason = `перезапуск не удался: ${error.message}`;
    }
    return this.#record(event);
  }

  /**
   * True when an action on this proxy happened too recently.
   *
   * @param {Record<string, unknown>} state
   * @param {Record<string, unknown>} wd
   * @returns {boolean}
   */
  #inPause(state, wd) {
    if (state.lastActionAt === null) return false;
    return this.now() - state.lastActionAt < wd.pauseSeconds * 1000;
  }

  /** Drops the restarts older than a day and returns what is left. */
  #pruneRestarts() {
    const floor = this.now() - DAY_MS;
    this.restarts = this.restarts.filter((stamp) => stamp > floor);
    return this.restarts;
  }

  /**
   * Appends an event to the history, logs it and keeps the ring buffer bounded.
   *
   * @param {Record<string, unknown>} event
   * @returns {Record<string, unknown>} The same event.
   */
  #record(event) {
    this.history.push(event);
    while (this.history.length > HISTORY_LIMIT) this.history.shift();
    const action = event.action === null ? 'без действия' : event.action;
    this.logger(
      `${event.time} ${event.tag}: проверка ${event.check}, ${action}` +
        (event.reason === null ? '' : ` — ${event.reason}`),
    );
    return event;
  }
}
