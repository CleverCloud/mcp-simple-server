import type { CcApiClient } from "@clevercloud/client/cc-api-client.js";

/** What the code run by the execute tool sees of the client */
export type ExecutionClient = Pick<CcApiClient, "send" | "stream">;

type Stream = Awaited<ReturnType<CcApiClient["stream"]>>;

/**
 * Wraps the shared client for one execution. Its requests are cancelled, even
 * if the code doesn't pass `signal`, and its streams closed, as soon as
 * `cancellation` aborts or `close()` is called once the execution is over.
 */
export function createExecutionClient(client: CcApiClient, cancellation: AbortSignal) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([cancellation, lifetime.signal]);
  const streams = new Set<Stream>();
  const withSignal = <T extends { signal?: AbortSignal }>(config: T | undefined) => ({
    ...config,
    signal: config?.signal ? AbortSignal.any([signal, config.signal]) : signal,
  });
  const closeStream = (stream: Stream) => {
    // Closing is best effort: a failure there must not turn the execution into one
    try {
      stream.close();
    } catch {}
  };

  const executionClient: ExecutionClient = {
    send: (command, config) => {
      signal.throwIfAborted();
      return client.send(command, withSignal(config));
    },
    stream: async (command, config) => {
      signal.throwIfAborted();
      const stream = await client.stream(command, withSignal(config));
      // The execution may have ended while the stream was being opened
      if (signal.aborted) closeStream(stream);
      else streams.add(stream);
      return stream;
    },
  };

  return {
    client: executionClient,
    /** Aborts on cancellation, and once the execution is over */
    signal,
    close: () => {
      lifetime.abort(new Error("The execution is over"));
      for (const stream of streams) closeStream(stream);
    },
  };
}
