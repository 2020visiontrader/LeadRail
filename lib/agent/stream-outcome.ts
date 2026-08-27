// The SSE frame reader and the end-of-stream decision, pulled out of the
// console component so they can be tested against real bytes.
//
// WHY THIS IS ITS OWN MODULE. The bug it exists to stop was not a wrong
// calculation — every function involved was individually correct. It was
// CONTROL FLOW: the read loop broke on a clean `done` and fell straight to
// cleanup, closing nothing. Testing `closeOpenSteps` in isolation would have
// passed and caught nothing. What has to be testable is the whole path,
// including the ending where no terminal event ever arrives, and that means it
// cannot live inside a React callback.

export interface Step {
  kind: string;
  done?: boolean;
  ok?: boolean;
  text?: string;
}

/** The events that mean a turn actually reached a conclusion. Anything else is
 *  progress, and progress is not an ending. */
export function isTerminalEvent(e: any): boolean {
  return e?.type === 'final' || e?.type === 'needs_approval' || e?.type === 'error';
}

/** Mark every unfinished step finished. `failed` marks tool steps as failed
 *  rather than merely stopped, so the trace never shows a green tick on a call
 *  that never returned. */
export function closeOpenSteps(steps: Step[], failed = false): void {
  for (const step of steps || []) {
    if (step.kind === 'error' || step.done) continue;
    step.done = true;
    if (failed && step.kind === 'tool') step.ok = false;
  }
}

/** Pull whole SSE frames out of a buffer, returning the parsed events and the
 *  partial frame still waiting for more bytes. */
export function parseSseFrames(buf: string): { events: any[]; rest: string } {
  const frames = buf.split('\n\n');
  const rest = frames.pop() || '';
  const events: any[] = [];
  for (const frame of frames) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const data = line.slice(6);
    if (data === '[DONE]') continue;
    try { events.push(JSON.parse(data)); } catch { /* a torn frame is not an event */ }
  }
  return { events, rest };
}

// This is the copy shown when the CLIENT never received a terminal event at
// all — not even the server's own failure message, which means the
// connection itself broke (a platform edge cut it, the process died) rather
// than the turn completing with an error the server got to report. Because
// nothing reached the client, there is no health state to read here the way
// app/api/agent/stream/route.ts can (see lib/agent/failure-copy.ts) — this
// is intentionally the generic "could not be completed" case, not a guess at
// why. It must still be honest about what survived and must never point at
// an internal page: the previous copy ("ask again, or check Logs") sent a
// non-admin user to a page their role guard refuses to open, and told
// everyone to retry a request the system sometimes already knew would fail
// again. See app/api/agent/stream/route.ts and lib/agent/failure-copy.ts for
// the server-side, health-aware variants of the same principle.
export const DEAD_STREAM_MESSAGE =
  'Your message is saved, but this turn could not be completed. Try again in a moment.';

/**
 * Decide what a finished stream leaves behind.
 *
 * A stream that ends cleanly WITHOUT a terminal event is a failure, not a
 * success. When a turn dies server-side after the route has already opened the
 * stream, the connection closes politely and nothing further arrives — which
 * is how open steps were left spinning for hours on a turn that had already
 * errored and been logged as errored.
 *
 * An abort is excluded: that is the user pressing Stop, and it is reported
 * where the abort is raised.
 */
export function finalizeStream(args: {
  steps: Step[];
  sawTerminal: boolean;
  aborted: boolean;
}): { closed: boolean; note: Step | null } {
  if (args.sawTerminal || args.aborted) return { closed: false, note: null };
  closeOpenSteps(args.steps, true);
  const note: Step = { kind: 'error', text: DEAD_STREAM_MESSAGE };
  args.steps.push(note);
  return { closed: true, note };
}

/**
 * Read an SSE body to completion.
 *
 * THE LOOP ITSELF LIVES HERE, not in the component, so a test can drive real
 * bytes through the exact code the browser runs. A test that re-implemented
 * this loop could stay green while the shipped one drifted — which is the
 * failure mode that produced the original bug, where every part was correct
 * and the path between them was not.
 *
 * Returns whether a terminal event was seen. The caller decides what to do
 * about it via finalizeStream.
 */
export async function consumeEventStream(args: {
  reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> };
  onEvent: (e: any) => void;
  /** Reported rather than thrown, so one bad frame cannot strand a turn. */
  onTransportError?: (err: any) => void;
  isAborted?: () => boolean;
}): Promise<{ sawTerminal: boolean; transportFailed: boolean }> {
  const decoder = new TextDecoder();
  let buf = '';
  let sawTerminal = false;
  let transportFailed = false;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await args.reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parsed = parseSseFrames(buf);
      buf = parsed.rest;
      for (const e of parsed.events) {
        if (isTerminalEvent(e)) sawTerminal = true;
        args.onEvent(e);
      }
    }
  } catch (err: any) {
    // An abort mid-stream is the user pressing Stop, not a fault.
    if (err?.name !== 'AbortError' && !args.isAborted?.()) {
      transportFailed = true;
      args.onTransportError?.(err);
    }
  }
  return { sawTerminal, transportFailed };
}
