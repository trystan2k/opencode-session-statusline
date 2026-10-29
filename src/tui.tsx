/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createMemo, createSignal } from "solid-js"

/**
 * opencode-session-statusline
 *
 * A compact status row for subagent (child session) views:
 *
 *   GPT-6 Luna | ctx █▊········▏ 17% — 69.3k | in 4M | out 117.9k | ████████▎····▏ ↯ 4.1 · μ 25 tok/s | 3h39m
 *
 * The figures come straight from the session record, its messages and the
 * host's event stream:
 * - model name from the session/last assistant message, resolved against the
 *   model catalogue for a display name and context window
 * - context % from the last assistant request's own token record (the session
 *   total is cumulative across turns and would overstate the window)
 * - in/out from the session's cumulative token totals
 * - speed from the same maths the usage line draws: a sliding estimate over
 *   streamed deltas (`↯`) and the turn's exact mean (`μ`), on an animated
 *   eighth-cell gauge scaled to the session's high-water mark
 * - duration from session creation to the moment it went idle (live while it
 *   is still running)
 */

/** How often the line repaints; the speed meter needs finer steps than a second. */
const TICK_MS = 250

type Tone = "success" | "warning" | "error"

interface Part {
  readonly text: string
  readonly muted?: boolean
  readonly tone?: Tone
  /** A held or settled figure: the muted shade of its tone. */
  readonly dim?: boolean
}

interface TokenRecord {
  readonly input?: number
  readonly output?: number
  readonly reasoning?: number
  readonly cache?: { readonly read?: number; readonly write?: number }
}

/** `842`, `12.3k`, `1.2M` — compact enough for a footer. */
function compact(value: number | undefined): string {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0
  if (n < 1_000) return String(Math.round(n))
  const scaled = n < 1_000_000 ? n / 1_000 : n / 1_000_000
  const unit = n < 1_000_000 ? "k" : "M"
  return `${scaled.toFixed(1).replace(/\.0$/, "")}${unit}`
}

/** `45s`, `12m04s`, `2h07m` — coarse on purpose; it is a glance, not a stopwatch. */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
}

/** Everything that occupied the window: prompt, output, reasoning, both caches. */
function contextUsed(tokens: TokenRecord | undefined): number {
  if (!tokens) return 0
  return (
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0)
  )
}

/* ------------------------------------------------------------------ *
 * The speed meter.
 *
 * A port of @rashidrazak/opencode-status-line's `rate.ts`, so the ↯
 * sliding figure, the μ turn mean and the gauge animation behave the
 * same: deltas land in 100 ms buckets, each class of output converts at
 * its own calibrated characters-per-token ratio, a step's decode clock
 * advances only while tokens actually arrive, finished steps fold into
 * the turn's exact mean, and the gauge scales to a high-water mark that
 * only ever rises.
 * ------------------------------------------------------------------ */

const RATE = {
  windowMs: 3_000,
  maxGapMs: 3_000,
  minSpanMs: 800,
  minTps: 0.5,
  bucketMs: 100,
  charsPerToken: 4,
  ratioMin: 2.5,
  ratioMax: 7,
}
const MIN_STEP_MS = 50
const MAX_STEP_MS = 3_600_000
const RATIO_MIN_CHARS = 40
const RATIO_WEIGHT = 0.3
const FAST_TPS = 50

type DeltaSource = "text" | "reasoning" | "tool"

interface Sample {
  at: number
  outputChars: number
  reasoningChars: number
}

interface RatioEvidence {
  chars: number
  tokens: number
}

interface Step {
  assistantMessageID: string
  outputChars: number
  reasoningChars: number
  at: number
  arrivedAt: number
  tokenAt?: number
  tokenArrivedAt?: number
  fromFirstToken?: boolean
  streamedAt?: number
  decodeMs?: number
  lastDeltaAt?: number
  toolOpenAt?: number
}

interface Turn {
  tokens: number
  ms: number
}

interface Final {
  tps: number
  at: number
  kind: "turn" | "step"
}

interface TurnSample {
  tps: number
  at: number
  tokens: number
  ms: number
}

interface Meter {
  samples: Sample[]
  lastDeltaAt: number
  step?: Step
  turn: Turn
  outputCharsPerToken: number
  reasoningCharsPerToken: number
  evidence: { output: RatioEvidence; reasoning: RatioEvidence }
  final?: Final
  sliding?: { tps: number; at: number }
  peak?: number
  history: TurnSample[]
}

function createMeter(): Meter {
  return {
    samples: [],
    lastDeltaAt: 0,
    turn: { tokens: 0, ms: 0 },
    outputCharsPerToken: RATE.charsPerToken,
    reasoningCharsPerToken: RATE.charsPerToken,
    evidence: { output: { chars: 0, tokens: 0 }, reasoning: { chars: 0, tokens: 0 } },
    history: [],
  }
}

function estimatedTokens(meter: Meter, outputChars: number, reasoningChars: number): number {
  return outputChars / meter.outputCharsPerToken + reasoningChars / meter.reasoningCharsPerToken
}

function prune(meter: Meter, now: number): void {
  const cutoff = now - RATE.windowMs
  while (meter.samples.length > 0 && meter.samples[0]!.at <= cutoff) meter.samples.shift()
}

function notePeak(meter: Meter, tps: number): void {
  if (tps > (meter.peak ?? 0)) meter.peak = tps
}

/** Records `chars` of streamed output at `now`; keeps the decode clock and the peak fed. */
function observe(
  meter: Meter,
  now: number,
  chars: number,
  eventNow?: number,
  assistantMessageID?: string,
  source: DeltaSource = "text",
): void {
  if (chars <= 0) return
  if (assistantMessageID !== undefined && meter.step?.assistantMessageID !== assistantMessageID) return
  const reasoning = source === "reasoning"
  const at = Math.floor(now / RATE.bucketMs) * RATE.bucketMs
  const last = meter.samples[meter.samples.length - 1]
  if (last && last.at === at) {
    if (reasoning) last.reasoningChars += chars
    else last.outputChars += chars
  } else {
    meter.samples.push({ at, outputChars: reasoning ? 0 : chars, reasoningChars: reasoning ? chars : 0 })
  }
  if (meter.step) {
    const gap = meter.step.lastDeltaAt === undefined ? 0 : Math.max(0, now - meter.step.lastDeltaAt)
    const counted = Math.min(gap, RATE.maxGapMs)
    meter.step.decodeMs = (meter.step.decodeMs ?? 0) + counted
    meter.step.lastDeltaAt = now
    if (reasoning) meter.step.reasoningChars += chars
    else meter.step.outputChars += chars
    if (meter.step.tokenAt === undefined) meter.step.fromFirstToken = true
    meter.step.tokenAt ??= eventNow ?? now
    meter.step.tokenArrivedAt ??= now
  }
  meter.lastDeltaAt = now
  prune(meter, now)
  const tps = liveRate(meter, now)
  if (tps !== undefined) notePeak(meter, tps)
}

/**
 * The sliding estimate: streamed characters over the span the retained deltas
 * cover, read as whichever of inter-arrival and density is lower — so a stream
 * that stops decays instead of freezing. Undefined once quiet for a window.
 */
function liveRate(meter: Meter, now: number): number | undefined {
  prune(meter, now)
  if (now - meter.lastDeltaAt > RATE.windowMs) return undefined
  if (meter.samples.length < 2) return undefined
  const oldest = meter.samples[0]!
  const newest = meter.samples[meter.samples.length - 1]!
  let total = 0
  for (const sample of meter.samples) total += estimatedTokens(meter, sample.outputChars, sample.reasoningChars)
  const afterOldest = total - estimatedTokens(meter, oldest.outputChars, oldest.reasoningChars)
  const interSpan = Math.min(Math.max(newest.at - oldest.at, RATE.minSpanMs), RATE.windowMs)
  const densitySpan = Math.min(Math.max(now - oldest.at, RATE.minSpanMs), RATE.windowMs)
  const tps = Math.min(afterOldest / (interSpan / 1_000), total / (densitySpan / 1_000))
  if (tps < RATE.minTps) return undefined
  meter.sliding = { tps, at: now }
  return tps
}

/** The turn's running average, live: exact folded steps plus the step in flight. */
function cumulativeRate(meter: Meter): number | undefined {
  const step = meter.step
  if (!step) return undefined
  const tokens = meter.turn.tokens + estimatedTokens(meter, step.outputChars, step.reasoningChars)
  const ms = meter.turn.ms + (step.decodeMs ?? 0)
  if (ms < RATE.minSpanMs || tokens <= 0) return undefined
  const tps = tokens / (ms / 1_000)
  return tps >= RATE.minTps ? tps : undefined
}

function beginStep(meter: Meter, assistantMessageID: string, at: number, arrivedAt: number): void {
  if (meter.step?.assistantMessageID === assistantMessageID) return
  meter.step = { assistantMessageID, outputChars: 0, reasoningChars: 0, at, arrivedAt }
}

function recordStreamed(meter: Meter, assistantMessageID: string, at: number): void {
  const step = meter.step
  if (!step || step.assistantMessageID !== assistantMessageID) return
  step.streamedAt = at
}

function beginToolInput(meter: Meter, assistantMessageID: string | undefined, now: number): void {
  const step = meter.step
  if (!step) return
  if (assistantMessageID !== undefined && step.assistantMessageID !== assistantMessageID) return
  step.toolOpenAt = now
  step.lastDeltaAt = now
}

function endToolInput(meter: Meter, assistantMessageID: string | undefined, now: number): void {
  const step = meter.step
  if (!step) return
  if (assistantMessageID !== undefined && step.assistantMessageID !== assistantMessageID) return
  if (step.toolOpenAt === undefined) return
  step.toolOpenAt = undefined
  const gap = Math.max(0, now - (step.lastDeltaAt ?? now))
  const counted = Math.min(gap, RATE.maxGapMs)
  step.decodeMs = (step.decodeMs ?? 0) + counted
  step.lastDeltaAt = now
}

function stepSpan(step: Step, endedAt: number, now: number): number {
  const startAt = step.tokenAt ?? step.at
  const startArrived = step.tokenArrivedAt ?? step.arrivedAt
  const candidates: number[] = []
  if (step.fromFirstToken && step.decodeMs !== undefined) candidates.push(step.decodeMs)
  if (step.streamedAt !== undefined) candidates.push(step.streamedAt - startAt)
  candidates.push(endedAt - startAt)
  candidates.push(now - startArrived)
  const usable = candidates.find((ms) => ms >= MIN_STEP_MS && ms <= MAX_STEP_MS)
  if (usable !== undefined) return usable
  return Math.min(Math.max(candidates[0]!, MIN_STEP_MS), MAX_STEP_MS)
}

function calibrate(evidence: RatioEvidence, chars: number, tokens: number): number | undefined {
  if (chars <= 0 || tokens <= 0) return undefined
  evidence.chars += chars
  evidence.tokens += tokens
  if (evidence.chars < RATIO_MIN_CHARS) return undefined
  const ratio = evidence.chars / evidence.tokens
  evidence.chars = 0
  evidence.tokens = 0
  return ratio >= RATE.ratioMin && ratio <= RATE.ratioMax ? ratio : undefined
}

function endStep(
  meter: Meter,
  assistantMessageID: string,
  tokens: { output?: number; reasoning?: number },
  endedAt: number,
  now: number,
): number | undefined {
  const step = meter.step
  meter.step = undefined
  const output = tokens.output ?? 0
  const reasoning = tokens.reasoning ?? 0
  const total = output + reasoning
  if (!step || step.assistantMessageID !== assistantMessageID || total <= 0) return undefined
  const seconds = stepSpan(step, endedAt, now) / 1_000
  meter.turn.tokens += total
  meter.turn.ms += seconds * 1_000
  const tps = meter.turn.tokens / (meter.turn.ms / 1_000)
  meter.final = { tps, at: now, kind: "turn" }
  notePeak(meter, tps)
  const outputRatio = calibrate(meter.evidence.output, step.outputChars, output)
  if (outputRatio !== undefined) {
    meter.outputCharsPerToken = meter.outputCharsPerToken * (1 - RATIO_WEIGHT) + outputRatio * RATIO_WEIGHT
  }
  const reasoningRatio = calibrate(meter.evidence.reasoning, step.reasoningChars, reasoning)
  if (reasoningRatio !== undefined) {
    meter.reasoningCharsPerToken = meter.reasoningCharsPerToken * (1 - RATIO_WEIGHT) + reasoningRatio * RATIO_WEIGHT
  }
  return tps
}

function failStep(
  meter: Meter,
  assistantMessageID: string,
  tokens: { output?: number; reasoning?: number },
  endedAt: number,
  now: number,
): void {
  const step = meter.step
  if (!step || step.assistantMessageID !== assistantMessageID) return
  if ((tokens.output ?? 0) + (tokens.reasoning ?? 0) <= 0) {
    meter.step = undefined
    return
  }
  endStep(meter, assistantMessageID, tokens, endedAt, now)
}

function beginTurn(meter: Meter, now: number): void {
  if (meter.turn.ms > 0) endTurn(meter, now)
  meter.turn = { tokens: 0, ms: 0 }
  meter.step = undefined
}

function endTurn(meter: Meter, now: number): void {
  if (meter.turn.ms > 0) {
    const { tokens, ms } = meter.turn
    const tps = tokens / (ms / 1_000)
    meter.final = { tps, at: now, kind: "turn" }
    meter.history.push({ tps, at: now, tokens, ms })
    if (meter.history.length > 500) meter.history.splice(0, meter.history.length - 500)
  }
  meter.turn = { tokens: 0, ms: 0 }
  meter.step = undefined
}

function deliver(meter: Meter, delivery: unknown, now: number): void {
  if (delivery !== "queue" || meter.turn.ms <= 0) return
  beginTurn(meter, now)
}

/** Whether the live window still has something worth redrawing. */
function active(meter: Meter, now: number): boolean {
  return now - meter.lastDeltaAt <= RATE.windowMs
}

interface Reading {
  label: string
  tps: number
  live: boolean
}

interface Displayed {
  readings: Reading[]
  primary: number
}

/** What to show now: the sliding reading, the turn mean, or the last settled figure. */
function display(meter: Meter, now: number): Displayed | undefined {
  const shown: Reading[] = []
  const tps = liveRate(meter, now)
  if (tps !== undefined) shown.push({ label: "↯", tps, live: true })
  else shown.push({ label: "↯", tps: 0, live: false })
  const cumulative = cumulativeRate(meter)
  if (cumulative !== undefined) shown.push({ label: "μ", tps: cumulative, live: true })
  else if (meter.final?.kind === "turn") shown.push({ label: "μ", tps: meter.final.tps, live: false })
  if (shown.length === 0) return undefined
  return { readings: shown, primary: shown[0]!.tps }
}

function peakTps(meter: Meter): number {
  let peak = meter.peak ?? 0
  for (const sample of meter.history) if (sample.tps > peak) peak = sample.tps
  return peak
}

/** `8.3`, ` 47`, `198` — a fixed three-character field, so digits never shift the line. */
function formatRate(tps: number): string {
  const tenths = Math.round(tps * 10) / 10
  if (tenths < 10) return tenths.toFixed(1)
  const whole = Math.round(tenths)
  if (whole < 1_000) return String(whole).padStart(3, " ")
  return `${Math.round(whole / 1_000)}k`.padStart(3, " ")
}

/**
 * Green at a healthy clip, amber while slow — deliberately no third state:
 * the theme's error ink is a loud pink that a resting or slow figure wears
 * far too often for a glanceable line.
 */
function speedTone(tps: number): Tone {
  return tps >= FAST_TPS ? "success" : "warning"
}

/* ------------------------------------------------------------------ *
 * Seeding: a session this generation never watched (a resume, a reload)
 * still deserves its settled figure. Rebuild it from the records.
 * ------------------------------------------------------------------ */

interface StoredPart {
  type?: string
  text?: string
  time?: { created?: number }
}

interface StoredMessage {
  id?: string
  type?: string
  time?: { created?: number; streamed?: number; completed?: number }
  tokens?: { output?: number; reasoning?: number }
  content?: StoredPart[]
}

function firstTokenAt(message: StoredMessage): number | undefined {
  let first: number | undefined
  for (const part of message.content ?? []) {
    if (part?.type !== "reasoning") continue
    const at = part.time?.created
    if (typeof at === "number" && (first === undefined || at < first)) first = at
  }
  return first
}

interface RecordedStep {
  tokens: number
  at: number
  endedAt: number
}

/** The last turn's steps, oldest first; undefined while the record has no user message yet. */
function recordedSteps(messages: StoredMessage[]): RecordedStep[] | undefined {
  const steps: RecordedStep[] = []
  let bounded = false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message?.type === "user") {
      bounded = true
      break
    }
    if (message?.type !== "assistant") continue
    const started = firstTokenAt(message) ?? message.time?.created
    const ended = message.time?.streamed ?? message.time?.completed
    const tokens = (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0)
    if (typeof started !== "number" || typeof ended !== "number" || tokens <= 0) continue
    steps.push({ tokens, at: started, endedAt: ended })
  }
  if (!bounded) return undefined
  return steps.reverse()
}

function measurable(step: RecordedStep): boolean {
  if (step.tokens <= 0) return false
  const span = step.endedAt - step.at
  return span >= MIN_STEP_MS && span <= MAX_STEP_MS
}

function restoreFinal(meter: Meter, steps: RecordedStep[], now: number): number | undefined {
  let tokens = 0
  let ms = 0
  for (const step of steps) {
    if (!measurable(step)) continue
    tokens += step.tokens
    ms += step.endedAt - step.at
  }
  if (tokens <= 0 || ms <= 0) return undefined
  const tps = tokens / (ms / 1_000)
  meter.final = { tps, at: now, kind: "turn" }
  meter.sliding = { tps: 0, at: now }
  notePeak(meter, tps)
  return tps
}

/* ------------------------------------------------------------------ *
 * Bars: the eighth-cell drawing the usage line uses, `████▋···▏`.
 * ------------------------------------------------------------------ */

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
const BAR_CELLS = 11

function bar(ratio: number, tone: Tone | undefined): Part[] {
  const fraction = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
  const eighths = Math.round(fraction * BAR_CELLS * 8)
  const full = Math.floor(eighths / 8)
  const rest = eighths % 8
  const fill = `${"█".repeat(Math.min(full, BAR_CELLS))}${full < BAR_CELLS && rest > 0 ? EIGHTHS[rest] : ""}`
  const track = "·".repeat(Math.max(0, BAR_CELLS - fill.length))
  return [
    ...(fill ? [{ text: fill, tone }] : []),
    ...(track ? [{ text: track, muted: true }] : []),
    { text: "▏", muted: true },
  ]
}

const percentTone = (percent: number): Tone => (percent >= 90 ? "error" : percent >= 70 ? "warning" : "success")

export default Plugin.define({
  id: "opencode-session-statusline",
  setup(context) {
    const location = context.location ?? context.data.location.default()
    // The catalogue supplies model display names and context windows.
    void context.data.location.model.sync(location).catch(() => {})

    // `scope: "subagents"` keeps the line to subagent (child) sessions; the
    // default shows it in every session view, the main session included.
    const showEverywhere = context.options.scope !== "subagents"
    // Where the line lives:
    // - `app` (default): the bottom-of-window slot, the same strip as the
    //   status line; the only slot that survives the composer tab views.
    // - `composer`: directly above the prompt.
    // - `footer`: the prompt footer row, which the composer tab views replace.
    const placement =
      context.options.placement === "composer" || context.options.placement === "footer"
        ? context.options.placement
        : "app"
    const inFooter = placement === "footer"

    const [tick, setTick] = createSignal(0, { equals: false })
    const heartbeat = setInterval(() => setTick((value) => value + 1), TICK_MS)
    const repaint = () => setTick((value) => value + 1)

    const currentSession = (): string | undefined => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const modelEntry = (ref: ModelRefLike | undefined) => {
      if (!ref?.id) return undefined
      const models = context.data.location.model.list(location) ?? []
      const sameProvider = models.filter((entry) => entry.providerID === ref.providerID)
      // A catalogue can hold several entries for one model id (`foo`, `foo-fast`,
      // …) that share `modelID`. Prefer the exact id so the label never comes
      // from a sibling entry.
      return sameProvider.find((entry) => entry.id === ref.id) ?? sameProvider.find((entry) => entry.modelID === ref.id)
    }

    /** The newest assistant message that reported usage: the current occupant. */
    const lastAssistant = (sessionID: string) => {
      const messages = context.data.session.message.list(sessionID)
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message?.type !== "assistant" || !message.tokens) continue
        return message
      }
      return undefined
    }

    // A session opened through the subagent picker is synced by the host, but a
    // first paint can beat that request. Ask once, then repaint on arrival.
    const requested = new Set<string>()
    const ensureMessages = (sessionID: string) => {
      if (requested.has(sessionID)) return
      if ((context.data.session.message.list(sessionID) ?? []).length > 0) return
      requested.add(sessionID)
      void context.data.session.message.sync(sessionID).then(repaint, () => {})
    }

    /* --- the meters: one per session, fed by the host's event stream --- */

    const meters = new Map<string, Meter>()
    const meter = (sessionID: string): Meter => {
      let existing = meters.get(sessionID)
      if (!existing) {
        existing = createMeter()
        meters.set(sessionID, existing)
      }
      return existing
    }

    const seeding = new Set<string>()
    const synced = new Set<string>()
    const seedMeter = async (sessionID: string) => {
      if (seeding.has(sessionID)) return
      seeding.add(sessionID)
      try {
        if (meters.get(sessionID)?.step || meters.get(sessionID)?.final) return
        if (!synced.has(sessionID)) {
          synced.add(sessionID)
          await context.data.session.message.sync(sessionID)
        }
        if (meters.get(sessionID)?.step || meters.get(sessionID)?.final) return
        const messages = (context.data.session.message.list(sessionID) ?? []) as unknown as StoredMessage[]
        let streaming: StoredMessage | undefined
        for (const message of messages) {
          if (message?.type === "assistant" && message.time?.completed === undefined) streaming = message
        }
        if (streaming?.id) {
          let outputChars = 0
          let reasoningChars = 0
          for (const part of streaming.content ?? []) {
            if (typeof part.text !== "string") continue
            if (part.type === "text") outputChars += part.text.length
            else if (part.type === "reasoning") reasoningChars += part.text.length
          }
          const at = firstTokenAt(streaming) ?? streaming.time?.created ?? Date.now()
          const each = meter(sessionID)
          each.step = {
            assistantMessageID: streaming.id,
            outputChars,
            reasoningChars,
            at,
            arrivedAt: Date.now(),
            tokenAt: at,
            tokenArrivedAt: Date.now(),
          }
          repaint()
          return
        }
        const steps = recordedSteps(messages)
        if (!steps) return
        if (restoreFinal(meter(sessionID), steps, Date.now()) !== undefined) repaint()
      } catch {
        // A seed that fails costs the figure, not the line.
      } finally {
        seeding.delete(sessionID)
      }
    }

    const stops = [
      context.data.on("session.text.delta", (event) => {
        const data = event?.data
        if (!data || typeof data.delta !== "string" || data.delta.length === 0) return
        observe(meter(data.sessionID), Date.now(), data.delta.length, event.created, data.assistantMessageID, "text")
        repaint()
      }),
      context.data.on("session.reasoning.delta", (event) => {
        const data = event?.data
        if (!data || typeof data.delta !== "string" || data.delta.length === 0) return
        observe(meter(data.sessionID), Date.now(), data.delta.length, event.created, data.assistantMessageID, "reasoning")
        repaint()
      }),
      // Tool arguments stream as visible output tokens too; they count in the
      // output class, the host's own split.
      context.data.on("session.tool.input.delta", (event) => {
        const data = event?.data
        if (!data || typeof data.delta !== "string" || data.delta.length === 0) return
        observe(meter(data.sessionID), Date.now(), data.delta.length, event.created, data.assistantMessageID, "tool")
        repaint()
      }),
      context.data.on("session.tool.input.started", (event) => {
        beginToolInput(meter(event.data.sessionID), event.data.assistantMessageID, Date.now())
      }),
      context.data.on("session.tool.input.ended", (event) => {
        endToolInput(meter(event.data.sessionID), event.data.assistantMessageID, Date.now())
      }),
      context.data.on("session.step.started", (event) => {
        const started = event.created > 0 ? event.created : Date.now()
        beginStep(meter(event.data.sessionID), event.data.assistantMessageID, started, Date.now())
      }),
      context.data.on("session.step.streamed", (event) => {
        if (event.created <= 0) return
        recordStreamed(meter(event.data.sessionID), event.data.assistantMessageID, event.created)
      }),
      context.data.on("session.step.ended", (event) => {
        const endedAt = event.created > 0 ? event.created : Date.now()
        endStep(meter(event.data.sessionID), event.data.assistantMessageID, event.data.tokens, endedAt, Date.now())
        repaint()
      }),
      context.data.on("session.step.failed", (event) => {
        const endedAt = event.created > 0 ? event.created : Date.now()
        failStep(meter(event.data.sessionID), event.data.assistantMessageID, event.data.tokens ?? {}, endedAt, Date.now())
        repaint()
      }),
      // Turn boundaries: a prompt starts an execution, its settlement ends it.
      context.data.on("session.execution.started", (event) => {
        beginTurn(meter(event.data.sessionID), Date.now())
      }),
      context.data.on("session.execution.succeeded", (event) => {
        endTurn(meter(event.data.sessionID), Date.now())
        repaint()
      }),
      context.data.on("session.execution.failed", (event) => {
        endTurn(meter(event.data.sessionID), Date.now())
        repaint()
      }),
      context.data.on("session.execution.interrupted", (event) => {
        endTurn(meter(event.data.sessionID), Date.now())
        repaint()
      }),
      // A late belt for a turn whose settlement never arrived.
      context.data.on("session.idle", (event) => {
        endTurn(meter(event.data.sessionID), Date.now())
        repaint()
      }),
      // A queued prompt is a turn boundary of its own; a steer is not.
      context.data.on("session.inbox.enqueued", (event) => {
        const item = event.data.item as { delivery?: unknown } | undefined
        if (item?.delivery === "queue" || item?.delivery === "steer") {
          deliveries.set(event.data.inboxID, item.delivery)
        }
      }),
      context.data.on("session.inbox.delivery.changed", (event) => {
        if (typeof event.data?.delivery === "string") deliveries.set(event.data.inboxID, event.data.delivery)
      }),
      context.data.on("session.inbox.delivered", (event) => {
        const delivery = deliveries.get(event.data.inboxID)
        deliver(meter(event.data.sessionID), delivery, Date.now())
        deliveries.delete(event.data.inboxID)
        repaint()
      }),
      context.data.on("session.inbox.cancelled", (event) => {
        deliveries.delete(event.data.inboxID)
      }),
    ]
    const deliveries = new Map<string, unknown>()

    /* --- drawing --- */

    /** The meter segment, exactly as the usage line draws it. */
    const meterParts = (sessionID: string): Part[] => {
      const each = meters.get(sessionID)
      if (!each) {
        // A session this generation met mid-history: rebuild its last figure
        // from the records; the seed repaints when it lands.
        void seedMeter(sessionID)
        return []
      }
      const view = display(each, Date.now())
      if (!view) return []
      const parts: Part[] = bar(view.primary / Math.max(peakTps(each), GAUGE_FLOOR_VALUE), speedTone(view.primary))
      view.readings.forEach((reading, index) => {
        const lead = index > 0 ? " · " : parts.length > 0 ? " " : ""
        // A live figure takes its speed tone; a resting one (`↯ 0.0` between
        // turns) draws in plain muted ink — the tone's own dim shade is a loud
        // pink in several themes.
        const text = `${lead}${reading.label} ${formatRate(reading.tps)}`
        parts.push(reading.live ? { text, tone: speedTone(reading.tps) } : { text, muted: true })
      })
      parts.push({ text: " tok/s", muted: true })
      return parts
    }

    const build = (sessionID: string): Line | undefined => {
      const session = context.data.session.get(sessionID)
      if (!session) return undefined
      if (!showEverywhere && !session.parentID) return undefined

      ensureMessages(sessionID)

      const message = lastAssistant(sessionID)
      const model = message?.model ?? session.model
      const entry = modelEntry(model)
      const used = message?.tokens ? contextUsed(message.tokens) : 0
      const limit = entry?.limit?.context
      const percent = typeof limit === "number" && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : undefined

      const running = context.data.session.status(sessionID) === "running"
      const created = session.time.created
      const idle = session.time.idle
      const end =
        running
          ? Date.now()
          : typeof idle === "number" && idle >= created
            ? idle
            : session.time.updated

      const variant = typeof model?.variant === "string" && model.variant.length > 0 ? model.variant : undefined
      // The provider's display name comes from the catalogue; the id is the fallback.
      const providerName =
        (context.data.location.provider
          .list(location)
          ?.find((provider) => provider.id === model?.providerID)?.name) ?? model?.providerID
      const modelParts: Part[] = [{ text: entry?.name ?? model?.id ?? "no model" }]
      if (providerName) modelParts.push({ text: ` ${providerName}`, muted: true })
      if (variant) {
        modelParts.push({ text: " · ", muted: true }, { text: variant, tone: "warning" })
      }
      const contextParts: Part[] = [
        { text: "ctx ", muted: true },
        ...(percent === undefined ? bar(0, undefined) : bar(percent / 100, percentTone(percent))),
        percent === undefined
          ? { text: ` — ${compact(used)}`, muted: true }
          : { text: ` ${percent}%`, tone: percentTone(percent) },
        ...(percent === undefined ? [] : [{ text: ` — ${compact(used)}`, muted: true }]),
      ]
      const inParts: Part[] = [
        { text: "in ", muted: true },
        { text: compact(session.tokens?.input) },
      ]
      const outParts: Part[] = [
        { text: "out ", muted: true },
        { text: compact(session.tokens?.output) },
      ]
      const speedParts = meterParts(sessionID)
      const timeParts: Part[] = [{ text: elapsed(end - created), muted: true }]

      const separator: Part = { text: " | ", muted: true }
      const sections = [modelParts, contextParts, inParts, outParts, speedParts, timeParts].filter(
        (section) => section.length > 0,
      )
      const parts: Part[] = []
      sections.forEach((section, index) => {
        if (index > 0) parts.push(separator)
        parts.push(...section)
      })

      return { parts }
    }

    const color = (part: Part) => {
      if (part.tone) {
        const feedback = context.theme.text.feedback[part.tone]
        return part.dim ? (feedback.muted ?? context.theme.text.muted) : feedback.base
      }
      return part.muted || part.dim ? context.theme.text.muted : context.theme.text.base
    }

    const renderLine = (input: { sessionID?: string }) => {
      const view = createMemo<Line | undefined>(() => {
        // The heartbeat keeps the duration live while a subagent runs.
        tick()
        // The app slot carries no session; the route knows what is on screen.
        const sessionID = input?.sessionID ?? currentSession()
        return sessionID ? build(sessionID) : undefined
      })

      return (
        <Show when={view()}>
          <box flexDirection="row" flexShrink={0} paddingLeft={inFooter ? 1 : 2}>
            <text wrapMode="none">
              <For each={view()!.parts}>{(part) => <span style={{ fg: color(part) }}>{part.text}</span>}</For>
            </text>
          </box>
        </Show>
      )
    }

    if (placement === "footer") {
      context.ui.slot({ append: "prompt.footer.status", render: renderLine })
    } else if (placement === "composer") {
      context.ui.slot({ append: "session.composer.top", render: renderLine })
    } else {
      context.ui.slot({ append: "app", render: renderLine })
    }

    return () => {
      clearInterval(heartbeat)
      for (const stop of stops) stop()
    }
  },
})

interface ModelRefLike {
  readonly id?: string
  readonly providerID?: string
  readonly variant?: string
}

interface Line {
  readonly parts: readonly Part[]
}

/** The speed the gauge reads full at: the session's high-water mark, never under this. */
const GAUGE_FLOOR_VALUE = 40
