/**
 * brain-protocol.ts
 *
 * Translation adapter between the Brain SSE protocol (used by the dashboard
 * and the engine's own brain-serve) and the OpenAI-compatible SSE protocol
 * (used by Hermes Agent's API server).
 *
 * Why this exists: the dashboard speaks Brain SSE; Hermes speaks OpenAI SSE.
 * Without a translation layer, the dashboard would need a separate adapter for
 * each brain, or the proxy would have to implement both protocols. With this
 * adapter, the proxy only speaks Brain SSE externally — internally, it can
 * forward to either brain in their native format.
 *
 * Format mapping:
 *
 *   REQUEST (dashboard → proxy):
 *     Brain:    POST /chats/:id/messages  { message, repo?, repoToken? }
 *     OpenAI:   POST /v1/chat/completions { model, messages, stream: true }
 *
 *   RESPONSE (brain → proxy → dashboard):
 *     Brain:    data: {"type":"chat","chatId":"..."}
 *               data: {"type":"text","text":"...","chatId":"...","seq":1}
 *               data: {"type":"done","chatId":"...","seq":2}
 *               data: {"type":"error","error":"...","chatId":"..."}
 *
 *     OpenAI:   data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"hi"}}]}
 *               data: {"id":"chatcmpl-...","choices":[{"delta":{}}],"finish_reason":"stop"}
 *               data: [DONE]
 *
 * Translation strategy:
 *   - Stream the upstream SSE byte-by-byte
 *   - For OpenAI streams: parse each chunk, project to Brain events
 *   - For Brain streams: pass through unchanged
 *   - Track chatId by using the URL path segment or a generated one
 */

import type { BrainEvent } from "./brain-serve.js"

// ────────────────────────────────────────────────────────────────────────────
// Brain SSE event shape (re-exported from brain-serve for callers).
// ────────────────────────────────────────────────────────────────────────────

export type { BrainEvent }

// ────────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions streaming chunk shape.
// ────────────────────────────────────────────────────────────────────────────

interface OpenAIDelta {
  content?: string | null
  role?: string
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: { name?: string; delta?: string }
  }>
}

interface OpenAIChoice {
  index: number
  delta: OpenAIDelta
  finish_reason?: string | null
}

interface OpenAIChatChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: OpenAIChoice[]
}

// ────────────────────────────────────────────────────────────────────────────
// REQUEST: Brain → OpenAI
// ────────────────────────────────────────────────────────────────────────────

export interface BrainToOpenAIInput {
  /** Brain chat ID (from URL path or generated). */
  chatId: string
  /** User message text. */
  message: string
  /** Model identifier (e.g. "anthropic/claude-sonnet-4"). */
  model?: string
}

/**
 * Translate a Brain chat message into an OpenAI Chat Completions request body.
 * The caller POSTs this to `/v1/chat/completions` with `stream: true`.
 */
export function brainToOpenAIRequest(input: BrainToOpenAIInput): {
  model: string
  messages: Array<{ role: "user"; content: string }>
  stream: true
} {
  return {
    model: input.model ?? "anthropic/claude-sonnet-4",
    messages: [{ role: "user", content: input.message }],
    stream: true,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// RESPONSE: OpenAI SSE → Brain SSE
// ────────────────────────────────────────────────────────────────────────────

export interface OpenAIToBrainOptions {
  /** Brain chat ID to stamp on every emitted event. */
  chatId: string
  /** Function to write a single Brain SSE `data:` line (no trailing flush). */
  write: (line: string) => void
}

/**
 * Consume an OpenAI SSE stream and project its chunks to Brain SSE events.
 *
 * Each upstream `data: {...}` line is parsed as an OpenAIChatChunk. The
 * accumulated `delta.content` becomes a Brain `text` event with monotonic seq.
 * A non-empty `finish_reason` (typically "stop") closes the stream with a
 * Brain `done` event.
 *
 * The caller is responsible for writing the initial `chat` handshake before
 * calling this (it is unsequenced per the Brain protocol) and for flushing
 * the underlying response after `write` returns.
 */
export function translateOpenAISseToBrain(opts: OpenAIToBrainOptions): {
  /**
   * Feed a single chunk of the upstream SSE body. Newline-delimited chunks are
   * expected (e.g. each fetch() reader.read() payload). Handles partial lines
   * correctly via internal buffering.
   */
  feed: (chunk: string) => void
  /**
   * Signal the upstream stream ended. Emits `done` if no terminal event was
   * already emitted by the upstream.
   */
  end: () => void
} {
  let buffer = ""
  let seq = 0
  let doneEmitted = false

  // OpenAI streams tool_calls incrementally: `function.name` arrives in
  // the first chunk for an index, then `function.delta` streams as a JSON
  // string over subsequent chunks. We accumulate the name + arguments
  // string per-index and emit one Brain `tool_use` event when the model
  // signals `finish_reason: "tool_calls"` (or sooner if the args JSON
  // parses cleanly on a later chunk).
  const toolCallAccumulator = new Map<number, { id: string; name: string; argsBuffer: string }>()

  const emit = (event: Omit<BrainEvent, "chatId"> & { seq?: number }) => {
    seq++
    const full: BrainEvent & { seq: number } = {
      ...event,
      chatId: opts.chatId,
      seq,
    }
    opts.write(`data: ${JSON.stringify(full)}\n\n`)
  }

  const flushToolCall = (tc: { id: string; name: string; argsBuffer: string }) => {
    // Parse the accumulated JSON arguments string. The upstream streams
    // fragments of a JSON object; we try to parse on every flush. If the
    // JSON is incomplete (mid-stream), we just emit whatever parsed cleanly
    // — the dashboard's tool_use consumer should treat it as the final
    // args on `finish_reason: "tool_calls"`.
    let input: unknown = {}
    if (tc.argsBuffer.length > 0) {
      try {
        input = JSON.parse(tc.argsBuffer)
      } catch {
        // Args still streaming — emit the partial string so the consumer
        // can see what's been seen so far. Better than dropping.
        input = { _partial: tc.argsBuffer }
      }
    }
    emit({
      type: "tool_use",
      name: tc.name || "tool",
      input,
    })
  }

  const processLine = (line: string) => {
    if (line.startsWith(":")) return // SSE comment
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (data === "[DONE]") {
      if (!doneEmitted) {
        emit({ type: "done" })
        doneEmitted = true
      }
      return
    }
    let chunk: OpenAIChatChunk
    try {
      chunk = JSON.parse(data)
    } catch {
      return // skip malformed
    }
    const choice = chunk.choices?.[0]
    if (!choice) return
    if (choice.delta.content) {
      emit({ type: "text", text: choice.delta.content, seq: 0 })
    }
    if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
      // Accumulate tool call fragments. OpenAI guarantees `index` is
      // stable across the stream; `id` and `function.name` arrive once;
      // `function.delta` may arrive over multiple chunks.
      for (const tc of choice.delta.tool_calls) {
        const existing = toolCallAccumulator.get(tc.index) ?? { id: "", name: "", argsBuffer: "" }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name = tc.function.name
        if (tc.function?.delta) existing.argsBuffer += tc.function.delta
        toolCallAccumulator.set(tc.index, existing)
      }
    }
    if (choice.finish_reason === "tool_calls") {
      // The model has finished the tool_calls stream. Flush every
      // accumulated call as a Brain tool_use event. After this, Hermes
      // will execute the tools and continue with a new stream that
      // contains the tool results + final assistant text.
      for (const tc of toolCallAccumulator.values()) {
        flushToolCall(tc)
      }
      toolCallAccumulator.clear()
    } else if (choice.finish_reason) {
      emit({ type: "done" })
      doneEmitted = true
    }
  }

  return {
    feed: (chunk: string) => {
      buffer += chunk
      // SSE is line-delimited; split on \n and process each.
      let newlineIdx: number
      // biome-ignore lint/suspicious/noAssignInExpressions: SSE framing
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        processLine(line)
      }
    },
    end: () => {
      // Process any trailing partial line.
      if (buffer.length > 0) {
        processLine(buffer)
        buffer = ""
      }
      // No `done` emitted: the upstream closed without a terminal event. The
      // HTTP layer in the proxy will close the SSE connection cleanly, which
      // is the correct "stream ended" signal for the dashboard. We do NOT
      // emit a Brain `error` here — the stream ending normally is not an
      // error, and the dashboard interprets `error` as a real failure
      // requiring user attention.
    },
  }
}
