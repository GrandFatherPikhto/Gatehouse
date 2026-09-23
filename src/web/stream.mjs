// Server-sent events: the frame writer, the headers and the shape of one
// outbound test row.
//
// The only stream of the editor is the mass outbound test, and it answers `200`
// ALWAYS, refusals included: `EventSource` does not reconnect after a non-200
// response, so a 409 would kill the panel until the page was reloaded. A refusal
// is therefore an event inside the stream.

/** Headers of every SSE response. `no-transform` stops a proxy from buffering. */
export const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});

/**
 * Writes one `text/event-stream` frame. Silently ignores a closed socket: the
 * browser closing a tab is normal, not an error of the editor.
 *
 * @param {import('express').Response} res
 * @param {string} event
 * @param {unknown} data
 */
export function writeEvent(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Shapes one outbound test result for the wire: the row of the table, without
 * the whole stdout of the command, which the SSE stream has no use for.
 *
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>}
 */
export function testResultView(result) {
  return {
    tag: result.tag,
    ok: Boolean(result.ok && result.parsed),
    exitOk: Boolean(result.ok),
    elapsed: typeof result.elapsed === 'number' ? result.elapsed : null,
    city: result.city ?? null,
    ip: result.ip ?? null,
    timedOut: Boolean(result.timedOut),
    error: result.error ?? null,
  };
}
