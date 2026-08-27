// Guards SSE writes against a client that has already gone away mid-turn.
//
// THE BUG THIS EXISTS TO STOP. `ReadableStream.cancel()` fires the moment the
// browser disconnects — a refresh, a closed tab, a dropped connection — but
// the agent run underneath keeps going; it does not (and must not) abort,
// because work already spent cannot be unspent. That run's next event used to
// call `enqueue` on a controller the platform had already closed, which
// throws `TypeError: Invalid state: Controller is already closed` (confirmed
// against the real Node ReadableStream, not assumed). That throw propagated
// into the route's own `catch`, whose own `send()` call threw AGAIN, and so
// did the `finally` block's — which rejected `start(controller)` before
// `saveConversation` ever ran. The user's message (saved early) survived;
// the assistant's answer did not.
//
// A pure module, importable on its own — the same reason stream-outcome.ts
// and json-envelope.ts are separate modules. The defect lived in the control
// flow connecting individually-correct pieces (enqueue works, saveConversation
// works), not in any one piece, so a test that re-implements the guard instead
// of importing it cannot see that class of bug.

export interface StreamGuardLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
}

export interface StreamGuardController {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
}

export interface StreamGuardEncoder {
  encode: (s: string) => Uint8Array;
}

export interface StreamGuard {
  /** Send one SSE event as JSON. A no-op — never throws — once the client is
   *  gone; the run keeps going, this just stops trying to talk to nobody. */
  send: (e: unknown) => void;
  /** Send a raw SSE line (used for the `data: [DONE]` sentinel, which is not
   *  JSON). Same guarantee as `send`. */
  sendRaw: (text: string) => void;
  /** Close the stream. Safe to call more than once, and safe once the client
   *  is already gone — closing an already-closed controller throws for the
   *  same reason enqueue does. */
  close: () => void;
  /** True once a write has failed because the client disconnected. */
  readonly clientGone: boolean;
}

/**
 * Wrap a ReadableStream controller so writes to a departed client are
 * swallowed instead of crashing the run that is still finishing server-side.
 *
 * Logs ONCE, at info, the moment the client is first discovered gone — not
 * once per suppressed event afterward, which on a long tool-heavy turn could
 * be dozens.
 */
export function createStreamGuard(args: {
  controller: StreamGuardController;
  encoder: StreamGuardEncoder;
  streamId: string;
  log: StreamGuardLogger;
}): StreamGuard {
  const { controller, encoder, streamId, log } = args;
  let clientGone = false;

  const markGone = () => {
    if (clientGone) return;
    clientGone = true;
    log.info('agent stream: client gone, finishing turn server-side', { streamId });
  };

  const write = (text: string) => {
    if (clientGone) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      // The one and only place this throw is expected: a cancelled
      // controller. Swallow it — the run must not stop because nobody is
      // listening anymore.
      markGone();
    }
  };

  return {
    get clientGone() {
      return clientGone;
    },
    send(e: unknown) {
      write(`data: ${JSON.stringify(e)}\n\n`);
    },
    sendRaw(text: string) {
      write(text);
    },
    close() {
      if (clientGone) return;
      try {
        controller.close();
      } catch {
        markGone();
      }
    },
  };
}
