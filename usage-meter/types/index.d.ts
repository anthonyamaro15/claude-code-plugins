export type Mode = 'cost' | 'tokens' | 'limits'

/** What the breakdown table lists: models, or the chart's hours, days or weeks. */
export type Breakdown = 'model' | 'time'

/** What the popup covers: this session, or a span of this computer's Claude Code history. */
export type RangeId = 'session' | '24h' | '7d' | '30d' | '90d'

/** The headline number's typeface, picked with `/usage-meter font <name>`. */
export type FontName = 'smooth' | 'rounded' | 'bold' | 'blocky'

/** Whose logs a span of history came from. */
export type Provider = 'claude' | 'codex'

/** What one turn added (its subagents' and every step's), for the per-turn chart. */
export type Amount = { usd: number; tokens: number }

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  byModel: Record<string, number>
}

export type Spend = {
  usd: number
  context?: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

/** One span of local history as `scripts/scan.py` sums it, cost at API list prices. */
export type RangeStats = {
  unit: 'hour' | 'day' | 'week'
  /** `Sep 21 – Oct 20`, or `last 24 hours`. */
  when: string
  sessions: number
  providers: ({ id: Provider; sessions: number } & Amount)[]
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  usd: number
  /** `usd` split by the kind of token it paid for. */
  costs: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** What cache reads saved over full input price, less what writing the cache cost. */
  saved: number
  /** Tokens from models without a known price, left out of `usd`. */
  unpriced: number
  models: ({ model: string; provider: Provider } & Amount)[]
  /** One bar per hour, day or week, oldest first. */
  series: (Amount & { label: string; byProvider: Record<Provider, Amount> })[]
}

export type History = {
  /** scan.py's output shape; a read of another shape is re-read, never drawn. */
  version: number
  /** When the transcripts were read, ms since the epoch. */
  scannedAt: number
  ranges: Record<Exclude<RangeId, 'session'>, RangeStats>
  /** One cell per day for the activity calendar, oldest first: a Sunday 12 weeks back through today. */
  calendar: (Amount & { label: string })[]
}

export type Scan = { isRunning: boolean; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      mode: Mode
      range: RangeId
      breakdown: Breakdown
      font: FontName
      /** The panel's background from `/usage-meter bg`: a hex, `none` for the engine's own, '' for the palette's. */
      background: string
      /** The person's theme, which picks the raw colors that don't follow it on their own. */
      theme: 'dark' | 'light'
      tokens: Tokens
      spend: Spend
      /** The ledger's cost and the token total when the last turn ended, to make each turn's share. */
      turnMark: Amount
      /** One entry a turn, the newest last; `turnLog` because `turns` once held one a cost update. */
      turnLog: Amount[]
      /** Main-thread turns this session, uncapped (`turnLog` keeps only the chart's last few). */
      turnCount: number
      /** When the session began, ms since the epoch; 0 until known. */
      startedAt: number
      now: number
      /** The last read of the transcripts; null until a history range is first opened. */
      history: History | null
      scan: Scan
    }
  }
}
