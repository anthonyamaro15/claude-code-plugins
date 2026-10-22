import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Amount, Breakdown, FontName, History, Mode, Provider, RangeId, RangeStats, Scan, Spend, Tokens } from '../types'

const PANE = 'usage-meter'
const MAX_WIDTH = 72
const CHART_ROWS = 4
const POPUP = { id: PANE, title: 'Usage', focus: true, closeOnEscape: true, rows: 30, columns: MAX_WIDTH + 4 } as const
/** How old a read of the transcripts may get before showing a history range reads them again. */
const HISTORY_TTL = 5 * 60_000
/** The `version` scripts/scan.py prints; see OUTPUT_VERSION there. */
const SCAN_VERSION = 4

const ZERO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {} }
const ZERO_SPEND: Spend = { usd: 0, rateLimits: [] }

const mode = atom({ plugin: 'usage-meter', key: 'mode' } as const, 'cost' as Mode)
const range = atom({ plugin: 'usage-meter', key: 'range' } as const, 'session' as RangeId)
const breakdown = atom({ plugin: 'usage-meter', key: 'breakdown' } as const, 'model' as Breakdown)
const font = atom({ plugin: 'usage-meter', key: 'font' } as const, 'smooth' as FontName)
const theme = atom({ plugin: 'usage-meter', key: 'theme' } as const, 'dark' as 'dark' | 'light')
const background = atom({ plugin: 'usage-meter', key: 'background' } as const, '')
const tokens = atom({ plugin: 'usage-meter', key: 'tokens' } as const, ZERO_TOKENS)
const spend = atom({ plugin: 'usage-meter', key: 'spend' } as const, ZERO_SPEND)
const turnMark = atom({ plugin: 'usage-meter', key: 'turnMark' } as const, { usd: 0, tokens: 0 } as Amount)
const turns = atom({ plugin: 'usage-meter', key: 'turnLog' } as const, [] as Amount[])
const turnCount = atom({ plugin: 'usage-meter', key: 'turnCount' } as const, 0)
const startedAt = atom({ plugin: 'usage-meter', key: 'startedAt' } as const, 0)
const now = atom({ plugin: 'usage-meter', key: 'now' } as const, 0)
const history = atom({ plugin: 'usage-meter', key: 'history' } as const, null as History | null)
const scan = atom({ plugin: 'usage-meter', key: 'scan' } as const, { isRunning: false } as Scan)

const MODES: { id: Mode; label: string; hotkey: string }[] = [
  { id: 'cost', label: 'Cost', hotkey: '1' },
  { id: 'tokens', label: 'Tokens', hotkey: '2' },
  { id: 'limits', label: 'Limits', hotkey: '3' },
]
const RANGES: { id: RangeId; label: string; title: string; days: number }[] = [
  { id: 'session', label: 'Session', title: 'this session', days: 0 },
  { id: '24h', label: '24h', title: 'last 24 hours', days: 1 },
  { id: '7d', label: '7d', title: 'last 7 days', days: 7 },
  { id: '30d', label: '30d', title: 'last 30 days', days: 30 },
  { id: '90d', label: '90d', title: 'last 90 days', days: 90 },
]
const LIMIT_NAMES: Record<string, string> = { five_hour: '5-hour limit', seven_day: '7-day limit' }
const SHORT_LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const LIMIT_WINDOWS_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }
const KINDS = [
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'output', label: 'Output' },
  { key: 'input', label: 'Input' },
] as const
const UNITS = { hour: ['Hour', 'Hourly'], day: ['Day', 'Daily'], week: ['Week', 'Weekly'] } as const
const PROVIDER_NAMES: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' }
/** Claude Code in Claude's orange, Codex in the text color, as T3 draws them; theme keys, so they follow the theme. */
const PROVIDER_COLORS: Record<Provider, string> = { claude: 'claude', codex: 'text' }
/**
 * Raw colors, by theme, where no theme key fits. The dark surface sits near black, below the engine's
 * pane gray; light keeps the engine's. Kinds of token are neutral steps, output the strongest, so they
 * never pass for a provider or a status; the calendar is one blue ramp from idle to busiest. Status
 * colors stay with the limits.
 */
const PALETTES = {
  dark: {
    surface: '#141414',
    kinds: { input: '#5e5e5e', cacheRead: '#8c8c8c', cacheWrite: '#b8b8b8', output: '#ececec' },
    calendar: ['#363636', '#1f4677', '#2a69bd', '#4b93ee', '#a2ccfb'],
  },
  light: {
    surface: undefined,
    kinds: { input: '#c9c9c9', cacheRead: '#9b9b9b', cacheWrite: '#6b6b6b', output: '#2e2e2e' },
    calendar: ['#ebedf0', '#b7d3f6', '#6da7ec', '#2a78d6', '#184f95'],
  },
} as const
/** The activity calendar's rows, Sunday first, labeled like GitHub's. */
const WEEKDAYS = ['', 'Mon', '', 'Wed', '', 'Fri', '']
/**
 * The headline fonts, for digits, `,` and `.`. A pixel font's glyphs are rows of `#`, drawn two rows to
 * a line in half blocks; a line font's glyphs are their lines as drawn.
 */
const FONTS: Record<FontName, { pixels: Record<string, string[]> } | { lines: Record<string, string[]> }> = {
  smooth: {
    pixels: {
      '0': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
      '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
      '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
      '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
      '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
      '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
      '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
      '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
      '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
      '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
      ',': ['..', '..', '..', '..', '..', '.#', '#.'],
      '.': ['.', '.', '.', '.', '.', '.', '#'],
    },
  },
  rounded: {
    lines: {
      '0': ['╭─╮', '│ │', '╰─╯'],
      '1': ['╶╮ ', ' │ ', '╶┴╴'],
      '2': ['╶─╮', '╭─╯', '╰─╴'],
      '3': ['╶─╮', ' ─┤', '╶─╯'],
      '4': ['╷ ╷', '╰─┤', '  ╵'],
      '5': ['╭─╴', '╰─╮', '╶─╯'],
      '6': ['╭─╴', '├─╮', '╰─╯'],
      '7': ['╶─╮', '  │', '  ╵'],
      '8': ['╭─╮', '├─┤', '╰─╯'],
      '9': ['╭─╮', '╰─┤', '╶─╯'],
      ',': [' ', ' ', '╯'],
      '.': [' ', ' ', '•'],
    },
  },
  bold: {
    lines: {
      '0': ['┏━┓', '┃ ┃', '┗━┛'],
      '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
      '2': ['╺━┓', '┏━┛', '┗━╸'],
      '3': ['╺━┓', ' ━┫', '╺━┛'],
      '4': ['╻ ╻', '┗━┫', '  ╹'],
      '5': ['┏━╸', '┗━┓', '╺━┛'],
      '6': ['┏━╸', '┣━┓', '┗━┛'],
      '7': ['╺━┓', '  ┃', '  ╹'],
      '8': ['┏━┓', '┣━┫', '┗━┛'],
      '9': ['┏━┓', '┗━┫', '╺━┛'],
      ',': [' ', ' ', '┛'],
      '.': [' ', ' ', '•'],
    },
  },
  blocky: {
    pixels: {
      '0': ['###', '#.#', '#.#', '#.#', '###'],
      '1': ['.#.', '##.', '.#.', '.#.', '###'],
      '2': ['###', '..#', '###', '#..', '###'],
      '3': ['###', '..#', '###', '..#', '###'],
      '4': ['#.#', '#.#', '###', '..#', '..#'],
      '5': ['###', '#..', '###', '..#', '###'],
      '6': ['###', '#..', '###', '#.#', '###'],
      '7': ['###', '..#', '..#', '..#', '..#'],
      '8': ['###', '#.#', '###', '#.#', '###'],
      '9': ['###', '#.#', '###', '..#', '###'],
      ',': ['..', '..', '..', '.#', '#.'],
      '.': ['.', '.', '.', '.', '#'],
    },
  },
}
const HALF_BLOCKS = [' ', '▄', '▀', '█']
const BLOCKS = ' ▁▂▃▄▅▆▇█'
const SCALES = [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']] as const

/** Three significant digits: `52.1k`, `114M`, `6.00B`. */
function count(n: number): string {
  const scale = SCALES.find(([size]) => n >= size)
  if (!scale) return String(Math.round(n))

  const v = n / scale[0]
  return `${v.toFixed(Math.max(0, 2 - Math.floor(Math.log10(v))))}${scale[1]}`
}

function dollars(n: number): string {
  if (n < 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

function limitColor(percent: number): string {
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'
  return 'success'
}

function sum(t: Omit<Tokens, 'byModel'>): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

/** `claude-haiku-4-5-20251001` as `haiku-4-5`. */
function modelName(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** `$0.50`, `$210`, `$2.0k`: short enough for a chart's scale. */
function shortDollars(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 10) return `$${Math.round(n)}`
  return `$${n.toFixed(2)}`
}

/** A `theme` config value as the palette to draw with: `light`, `light-daltonized` and the like are light. */
function themeOf(value: unknown): 'dark' | 'light' {
  return String(value ?? '').startsWith('light') ? 'light' : 'dark'
}

/** One glyph's lines: a line font's as drawn, a pixel font's two pixel rows to a line in half blocks. */
function glyphLines(name: FontName, ch: string): string[] | undefined {
  const face = FONTS[name]
  if ('lines' in face) return face.lines[ch]

  const rows = face.pixels[ch]
  if (!rows) return undefined

  const pixel = (row: number, x: number) => rows[row]?.[x] === '#'
  return Array.from({ length: Math.ceil(rows.length / 2) }, (_, line) =>
    [...(rows[0] ?? '')].map((_, x) => HALF_BLOCKS[(pixel(line * 2, x) ? 2 : 0) + (pixel(line * 2 + 1, x) ? 1 : 0)]).join(''),
  )
}

/** `text` (digits, `,` and `.`) in a headline font, a column apart; undefined when a character has no glyph. */
function bigText(text: string, name: FontName): string[] | undefined {
  const glyphs: string[][] = []
  for (const ch of text) {
    const glyph = glyphLines(name, ch)
    if (!glyph) return undefined
    glyphs.push(glyph)
  }

  const height = Math.max(0, ...glyphs.map(g => g.length))
  return Array.from({ length: height }, (_, line) => glyphs.map(g => g[line] ?? ' '.repeat(g[0]?.length ?? 0)).join(' '))
}

/** `n` as a percent of `total`, one decimal; `<0.1%` for a sliver. */
function share(n: number, total: number): string {
  if (total <= 0 || n <= 0) return '0%'
  const percent = (n / total) * 100
  return percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`
}

/** Splits `cells` among `values` (largest first) in proportion, every non-zero value getting at least one. */
function allot(values: number[], cells: number): number[] {
  const total = values.reduce((a, v) => a + v, 0)
  const out = values.map(v => (v > 0 ? Math.max(1, Math.floor((v / total) * cells)) : 0))
  out[0] = (out[0] ?? 0) + cells - out.reduce((a, n) => a + n, 0)
  return out
}

/** A line of `width` with each label at its column, dropping any that would touch the one before. */
function ticks(marks: { at: number; text: string }[], width: number): string {
  let line = ''
  for (const { at, text } of marks) {
    const col = Math.max(0, Math.min(width - text.length, at))
    if (line === '' || col >= line.length + 2) line = line.padEnd(col) + text
  }
  return line
}

/** `3d 4h`, `2h 14m` or `9m`. */
function duration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins >= 48 * 60) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  return `${mins}m`
}

/** How long until `resetsAt`; undefined when unknown. */
function until(resetsAt: string | undefined, nowMs: number): string | undefined {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  if (Number.isNaN(at) || nowMs === 0) return undefined

  return duration(at - nowMs)
}

/**
 * Where a limit lands by its reset if use keeps the rate it has had this window, and how long until
 * it runs out at that rate; undefined for an unknown window or one too young to tell.
 */
function pace(limit: Spend['rateLimits'][number], nowMs: number): { percent: number; outInMs: number } | undefined {
  const windowMs = LIMIT_WINDOWS_MS[limit.kind]
  const at = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)
  if (windowMs === undefined || Number.isNaN(at) || nowMs === 0) return undefined

  const elapsed = windowMs - (at - nowMs)
  if (elapsed < windowMs * 0.05 || limit.percentUsed <= 0) return undefined

  const perMs = limit.percentUsed / elapsed
  return { percent: perMs * windowMs, outInMs: (100 - limit.percentUsed) / perMs }
}

/** Sums this computer's transcripts through `scripts/scan.py`, unless a fresh read is in hand or under way. */
async function refreshHistory($: EngineInterface): Promise<void> {
  const last = await read($, history)
  const isFresh = last?.version === SCAN_VERSION && (await $.clock.now()) - last.scannedAt < HISTORY_TTL
  if (isFresh || (await read($, scan)).isRunning) return

  await update($, scan, () => ({ isRunning: true }))
  try {
    const run = await $.process.run(['python3', '-I', `${$.plugin.root}/scripts/scan.py`], { timeoutMs: 120_000 })
    if (run.exitCode !== 0) throw new Error(run.stderr.trim().split('\n').pop() || `scan.py exited with ${run.exitCode}`)

    const result = JSON.parse(run.stdout) as History
    await update($, history, () => result)
    await update($, scan, () => ({ isRunning: false }))
  } catch (err) {
    await update($, scan, () => ({ isRunning: false, error: err instanceof Error ? err.message : String(err) }))
  }
}

async function pickRange($: EngineInterface, id: RangeId): Promise<void> {
  await update($, range, () => id)
  if (id !== 'session') await refreshHistory($)
}

/** Opens the popup; a history range on show gets a fresh read in the background. */
async function openPopup($: EngineInterface): Promise<void> {
  await $.ui.open(POPUP)
  if ((await read($, range)) !== 'session') void refreshHistory($)
}

/** Opens the popup, or closes it when it is already open; resolves whether it is open now. */
async function togglePopup($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPopup($)
  return true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-meter',
      description: 'Toggle the usage popup; pass cost, tokens or limits and session, 24h, 7d, 30d or 90d to open on that view; font smooth, rounded, bold or blocky; bg #hex, none or default',
    })

    // Raw colors follow the theme by hand, and the headline font is kept across sessions.
    const rows = await $.config.list().catch(() => [])
    await update($, theme, () => themeOf(rows.find(row => row.key === 'theme')?.value))
    const saved = await $.store.get('font').catch(() => undefined)
    if (typeof saved === 'string' && saved in FONTS) await update($, font, () => saved as FontName)
    const savedBackground = await $.store.get('background').catch(() => undefined)
    if (typeof savedBackground === 'string') await update($, background, () => savedBackground)

    // Seed cost from the ledger so a resumed session isn't $0 until its next turn.
    const usage = await $.session.usage()
    await update($, spend, s => ({ ...s, usd: usage.cost?.usd ?? s.usd, context: usage.context, rateLimits: usage.rateLimits }))
    await update($, startedAt, () => usage.startedAt)
    const total = sum(await read($, tokens))
    await update($, turnMark, () => ({ usd: usage.cost?.usd ?? 0, tokens: total }))

    // A minute tick keeps the reset countdowns and the spend rate current while nothing else redraws.
    const t = await $.clock.now()
    await update($, now, () => t)
    $.clock.every(60_000, () => void $.clock.now().then(ms => update($, now, () => ms)))

    return next(e)
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) await update($, theme, () => themeOf(result.value))
    return result
  })

  on('command.run', { command: 'usage-meter' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/)
    if (words[0] === 'font') {
      const picked = words[1]
      if (picked === undefined || !(picked in FONTS)) return { text: `Fonts: ${Object.keys(FONTS).join(', ')}. Usage: /usage-meter font rounded` }

      await update($, font, () => picked as FontName)
      await $.store.set('font', picked).catch(() => {})
      await openPopup($)
      return { text: `Headline font: ${picked}.` }
    }
    if (words[0] === 'bg') {
      const picked = words[1]?.toLowerCase() ?? ''
      if (!/^(#[0-9a-f]{6}|none|default)$/.test(picked)) {
        return { text: 'Usage: /usage-meter bg #141414 (any hex), none for Claude Code\'s own gray, or default.' }
      }

      const value = picked === 'default' ? '' : picked
      await update($, background, () => value)
      await $.store.set('background', value).catch(() => {})
      await openPopup($)
      return { text: `Background: ${picked}.` }
    }

    const pickedMode = MODES.find(m => words.includes(m.id))
    const pickedRange = RANGES.find(r => words.includes(r.id))

    if (pickedMode || pickedRange) {
      if (pickedMode) await update($, mode, () => pickedMode.id)
      if (pickedRange) await update($, range, () => pickedRange.id)
      await openPopup($)
    } else if (!(await togglePopup($))) {
      return { text: 'Usage popup closed.' }
    }

    const shown = await read($, range)
    return { text: `Usage popup showing ${await read($, mode)} for ${RANGES.find(r => r.id === shown)?.title ?? shown}.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Button, Text } = $.ui.resolve(e)
    const t = await read($, tokens)
    const s = await read($, spend)
    const nowMs = await read($, now)
    const percent = s.context?.percent
    const sep = () => <Text dimColor>{'  ·  '}</Text>
    const items = [
      <Text color="claude">{'◆ '}</Text>,
      <Text>{count(sum(t))}</Text>,
      <Text dimColor> tokens</Text>,
      sep(),
      <Text color="success">{dollars(s.usd)}</Text>,
    ]

    if (percent !== undefined) {
      const filled = Math.round(Math.min(100, percent) / 10)
      items.push(
        sep(),
        <Text dimColor>ctx </Text>,
        <Text color={limitColor(percent)}>{'━'.repeat(filled)}</Text>,
        <Text dimColor>{'─'.repeat(10 - filled)}</Text>,
        <Text>{` ${percent}%`}</Text>,
      )
    }
    for (const r of s.rateLimits) {
      const left = until(r.resetsAt, nowMs)
      items.push(sep(), <Text dimColor>{`${SHORT_LIMIT_NAMES[r.kind] ?? r.kind} `}</Text>)
      items.push(<Text color={limitColor(r.percentUsed)}>{`${r.percentUsed}%`}</Text>)
      if (left) items.push(<Text dimColor>{` ${left}`}</Text>)
    }

    return (
      <Button key="usage" plain onPress={() => void togglePopup($)}>
        {items}
      </Button>
    )
  })

  on('turn.complete', async ($, e, next) => {
    // Every loop's end is heard here, subagents' too, so the sum covers them.
    const u = e.usage
    if (u) {
      const all = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await update($, tokens, t => ({
        input: t.input + u.input_tokens,
        output: t.output + u.output_tokens,
        cacheRead: t.cacheRead + u.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
        byModel: { ...t.byModel, [u.model]: (t.byModel[u.model] ?? 0) + all },
      }))
    }
    if (e.agentId === undefined) {
      await update($, turnCount, n => n + 1)

      // The ledger reports cost after every step; a turn's share is what it grew by since the last
      // turn ended, its tool calls and subagents included. A total below the mark is a fresh ledger.
      const usd = (await $.session.usage()).cost?.usd ?? (await read($, spend)).usd
      const total = sum(await read($, tokens))
      const mark = await read($, turnMark)
      const turn = { usd: usd >= mark.usd ? usd - mark.usd : usd, tokens: Math.max(0, total - mark.tokens) }
      await update($, turns, list => [...list, turn].slice(-MAX_WIDTH))
      await update($, turnMark, () => ({ usd, tokens: total }))
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, spend, s => ({ usd: e.cost?.usd ?? s.usd, context: e.context, rateLimits: e.rateLimits }))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const metric = await read($, mode)
    const picked = await read($, range)
    const listing = await read($, breakdown)
    const t = await read($, tokens)
    const s = await read($, spend)
    const turnList = await read($, turns)
    const turnTotal = await read($, turnCount)
    const began = await read($, startedAt)
    const nowMs = await read($, now)
    const kept = await read($, history)
    const last = kept?.version === SCAN_VERSION ? kept : null
    const scanState = await read($, scan)
    const width = Math.max(24, Math.min(MAX_WIDTH, e.props.bodyColumns))
    const isCost = metric === 'cost'
    const show = isCost ? dollars : count
    const pick = (a: Amount) => (isCost ? a.usd : a.tokens)
    const palette = PALETTES[await read($, theme)]
    // `/usage-meter bg` wins over the palette; `none` leaves the engine's own gray.
    const chosen = await read($, background)
    let surface: string | undefined = chosen
    if (chosen === '') surface = palette.surface
    else if (chosen === 'none') surface = undefined
    const face = await read($, font)
    const providerColor = (provider?: Provider) => PROVIDER_COLORS[provider ?? 'claude']
    const span = RANGES.find(r => r.id === picked)
    const stats = picked === 'session' ? undefined : last?.ranges[picked]

    const heading = (label: string, right?: string) => (
      <Box justifyContent="space-between">
        <Text weight="bold">{label}</Text>
        {right && <Text dimColor>{right}</Text>}
      </Box>
    )

    const tab = (key: string, label: string, isActive: boolean, onPress: () => void, hotkey?: string) => (
      <Button key={key} plain {...(hotkey ? { hotkey } : {})} onPress={onPress}>
        <Text weight={isActive ? 'bold' : 'regular'} dimColor={!isActive}>{label}</Text>
      </Button>
    )

    /** Used so far in `color`, then up to `projected` in a dashed line, then the rest. */
    const meter = (percent: number, color: string, projected = 0) => {
      const cells = (p: number) => Math.round((Math.min(100, Math.max(0, p)) / 100) * width)
      const filled = cells(percent)
      const ahead = Math.max(0, cells(projected) - filled)

      return (
        <Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color={color} dimColor>{'╌'.repeat(ahead)}</Text>
          <Text dimColor>{'─'.repeat(width - filled - ahead)}</Text>
        </Text>
      )
    }

    /**
     * The headline in the picked font when it fits beside `right`, in the text color as T3 draws it: a
     * price's `$` small at the top like a price tag, `suffix` small on the baseline; captions under.
     */
    const hero = (big: string, suffix: string, right: string, caption: string, extra?: RenderChildren) => {
      const isPrice = big.startsWith('$')
      const lines = bigText(isPrice ? big.slice(1) : big, face)
      const lead = isPrice ? 2 : 0
      const fits = lines !== undefined && lead + (lines[0] ?? '').length + suffix.length + right.length + 2 <= width

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            {fits ? (
              <Box>
                {isPrice && <Text dimColor>$ </Text>}
                <Box flexDirection="column">
                  {lines.map((line, i) => (
                    <Text>
                      <Text weight="bold">{line}</Text>
                      {i === lines.length - 1 && suffix && <Text dimColor>{suffix}</Text>}
                    </Text>
                  ))}
                </Box>
              </Box>
            ) : (
              <Text>
                <Text weight="bold">{big}</Text>
                {suffix && <Text dimColor>{suffix}</Text>}
              </Text>
            )}
            <Text dimColor>{right}</Text>
          </Box>
          <Text dimColor>{caption}</Text>
          {extra}
        </Box>
      )
    }

    /**
     * Bars oldest to newest across the full width, on a scale from 0 to the peak; hovering a bar shows
     * its value above it. Bars keep a gap, so a long list shows only its newest that fit.
     */
    const chart = (items: (Amount & { label?: string; byProvider?: Record<Provider, Amount> })[], title: string, ends?: [string, string]) => {
      if (items.length < 2) return null

      const scale = (n: number) => (isCost ? shortDollars(n) : count(n))
      const gutter = scale(Math.max(...items.map(pick))).length
      const room = width - gutter - 2
      const shown = items.slice(-Math.floor((room + 1) / 2))
      const values = shown.map(pick)
      const peak = Math.max(...values)
      const top = scale(peak)
      const barWidth = Math.max(1, Math.floor((room + 1) / shown.length) - 1)
      const left = (i: number) => Math.round((i * (room - barWidth)) / (shown.length - 1))
      const mid = Math.floor((shown.length - 1) / 2)
      const midLabel = shown[mid]?.label ?? ''
      const oldest = shown.length < items.length ? `${shown.length - 1} turns ago` : ends?.[0] ?? ''
      const marks = ends
        ? [{ at: 0, text: oldest }, { at: room, text: ends[1] }]
        : [
            { at: 0, text: shown[0]?.label ?? '' },
            { at: Math.round(left(mid) + (barWidth - midLabel.length) / 2), text: midLabel },
            { at: room, text: shown.at(-1)?.label ?? '' },
          ]

      return (
        <Box flexDirection="column">
          {heading(title, 'hover for values')}
          <Box>
            <Box flexDirection="column">
              {Array.from({ length: CHART_ROWS }, (_, r) => (
                <Text dimColor>{`${(r === 0 ? top : '').padStart(gutter)} ${r === 0 ? '┤' : '│'}`}</Text>
              ))}
            </Box>
            <Box width={room} justifyContent="space-between">
              {shown.map((item, i) => {
                const v = values[i] ?? 0
                const codex = item.byProvider ? pick(item.byProvider.codex) : 0
                // In eighths of a row: anything above zero gets at least a sliver, so small values stay visible.
                const eighths = (n: number) => (peak > 0 && n > 0 ? Math.max(1, Math.round((n / peak) * CHART_ROWS * 8)) : 0)
                const level = eighths(v)
                const below = codex > 0 ? Math.min(level, eighths(v - codex)) : level
                const isRightHalf = i >= shown.length / 2
                let hover = item.label ? ` ${item.label} · ${show(v)} ` : ` ${show(v)} `
                if (codex > 0) hover += `· Codex ${show(codex)} `

                return (
                  <Box key={`bar-${i}`} flexDirection="column">
                    {Array.from({ length: CHART_ROWS }, (_, r) => {
                      const floor = (CHART_ROWS - 1 - r) * 8
                      const claude = Math.min(8, Math.max(0, below - floor))
                      const total = Math.min(8, Math.max(0, level - floor))
                      // Claude Code fills from the bottom; Codex stacks on top, behind a partial cell as its background.
                      if (claude === 0) return <Text color={providerColor('codex')}>{(BLOCKS[total] ?? ' ').repeat(barWidth)}</Text>

                      return (
                        <Text color={providerColor('claude')} {...(total > claude ? { backgroundColor: providerColor('codex') } : {})}>
                          {(BLOCKS[claude] ?? ' ').repeat(barWidth)}
                        </Text>
                      )
                    })}
                    <Box
                      position="absolute"
                      top={-1}
                      {...(isRightHalf ? { right: 0 } : { left: 0 })}
                      display="none"
                      hover={{ display: 'flex' }}
                    >
                      <Text inverse>{hover}</Text>
                    </Box>
                  </Box>
                )
              })}
            </Box>
          </Box>
          <Text dimColor>{`${'0'.padStart(gutter)} └${'─'.repeat(room)}`}</Text>
          <Text dimColor>{' '.repeat(gutter + 2) + ticks(marks, room)}</Text>
        </Box>
      )
    }

    /** A row of label-over-value cells that wraps on a narrow pane. */
    const statRow = (cells: [string, string][]) => {
      const perRow = Math.max(1, Math.min(cells.length, Math.floor(width / 12)))

      return (
        <Box flexWrap="wrap">
          {cells.map(([label, value]) => (
            <Box width={Math.floor(width / perRow)} flexDirection="column">
              <Text dimColor>{label}</Text>
              <Text weight="bold">{value}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    /** One bar across the pane split by kind of token, with a legend under it. */
    const byType = (title: string, amounts: Omit<Tokens, 'byModel'>, format: (n: number) => string) => {
      const parts = KINDS.map(k => ({ ...k, n: amounts[k.key], color: palette.kinds[k.key] }))
        .filter(p => p.n > 0)
        .sort((a, b) => b.n - a.n)
      if (parts.length === 0) return null

      // A column of surface between segments keeps neighboring steps apart.
      const cells = allot(parts.map(p => p.n), width - (parts.length - 1))

      return (
        <Box flexDirection="column">
          {heading(title)}
          <Text>
            {parts.map((p, i) => (
              <Text color={p.color}>{(i > 0 ? ' ' : '') + '█'.repeat(cells[i] ?? 0)}</Text>
            ))}
          </Text>
          <Box flexWrap="wrap">
            {parts.map(p => (
              <Box paddingRight={3}>
                <Text>
                  <Text color={p.color}>■ </Text>
                  <Text dimColor>{`${p.label} `}</Text>
                  <Text>{format(p.n)}</Text>
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    type Row = { name: string; tokens: number; usd?: number; provider?: Provider }

    /** `#  name  ━━━━━━  $2,097.00  80.7%  4.91B`; the line is relative to the largest row. */
    const table = (label: string, rows: Row[], isRanked: boolean) => {
      const hasCost = rows.some(r => r.usd !== undefined)
      const amount = (r: Row) => (isCost && hasCost ? (r.usd ?? 0) : r.tokens)
      const ordered = isRanked ? [...rows].sort((a, b) => amount(b) - amount(a)) : rows
      const total = ordered.reduce((a, r) => a + amount(r), 0)
      const top = Math.max(0, ...ordered.map(amount))
      const lead = isRanked ? 4 : 0
      const nameWidth = Math.min(19, Math.max(label.length, ...ordered.map(r => r.name.length)) + 2)
      const costWidth = hasCost ? 11 : 0
      const lineWidth = width - lead - nameWidth - costWidth - 7 - 8

      return (
        <Box flexDirection="column">
          <Text dimColor>
            {(isRanked ? ' #  ' : '') +
              label.padEnd(nameWidth) +
              ' '.repeat(Math.max(0, lineWidth)) +
              (hasCost ? 'Cost'.padStart(costWidth) : '') +
              'Share'.padStart(7) +
              'Tokens'.padStart(8)}
          </Text>
          {ordered.map((r, i) => {
            const cells = top > 0 ? Math.max(1, Math.round((amount(r) / top) * (lineWidth - 2))) : 0
            let cost = ''
            if (r.usd !== undefined) cost = r.usd > 0 || r.tokens === 0 ? dollars(r.usd) : 'unpriced'

            return (
              <Text>
                {isRanked && <Text dimColor>{`${String(i + 1).padStart(2)}  `}</Text>}
                <Text>{r.name.slice(0, nameWidth - 1).padEnd(nameWidth)}</Text>
                {lineWidth > 2 && <Text color={providerColor(r.provider)}>{'━'.repeat(amount(r) > 0 ? cells : 0).padEnd(lineWidth)}</Text>}
                {hasCost && <Text>{cost.padStart(costWidth)}</Text>}
                <Text dimColor>{share(amount(r), total).padStart(7)}</Text>
                <Text>{count(r.tokens).padStart(8)}</Text>
              </Text>
            )
          })}
        </Box>
      )
    }

    const breakdownOf = (st: RangeStats) => {
      const [unitName] = UNITS[st.unit]
      const byTime = listing === 'time'
      const rows = byTime
        ? [...st.series].reverse().filter(b => b.tokens > 0).map(b => ({ name: b.label, tokens: b.tokens, usd: b.usd }))
        : st.models.map(m => ({ name: modelName(m.model), tokens: m.tokens, usd: m.usd, provider: m.provider }))

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text weight="bold">Breakdown</Text>
            <Box gap={2}>
              {tab('by-model', 'Model', !byTime, () => void update($, breakdown, () => 'model'))}
              {tab('by-time', unitName, byTime, () => void update($, breakdown, () => 'time'))}
            </Box>
          </Box>
          {table(byTime ? unitName : 'Model', rows, !byTime)}
        </Box>
      )
    }

    /** One line a provider, T3-style, once more than one has use in the span. */
    const providerRows = (st: RangeStats) => {
      const used = st.providers.filter(p => p.tokens > 0)
      if (used.length < 2) return null

      const total = used.reduce((a, p) => a + pick(p), 0)

      return (
        <Box flexDirection="column" marginTop={1}>
          {used.map(p => (
            <Box justifyContent="space-between">
              <Text>
                <Text color={providerColor(p.id)}>● </Text>
                <Text>{PROVIDER_NAMES[p.id].padEnd(13)}</Text>
                <Text dimColor>{`${p.sessions} ${p.sessions === 1 ? 'session' : 'sessions'}`.padEnd(14)}</Text>
                <Text dimColor>{`${share(pick(p), total).padStart(5)} of ${isCost ? `cost · ${count(p.tokens)} tokens` : `tokens · ${dollars(p.usd)}`}`}</Text>
              </Text>
              <Text weight="bold">{show(pick(p))}</Text>
            </Box>
          ))}
        </Box>
      )
    }

    /**
     * GitHub-style: a column a week, a row a weekday, each day a square shaded by its quartile among
     * active days. A square is two cells wide and one row tall; odd weekdays straddle two rows in half
     * blocks, so the gaps run half a row and a cell, even both ways. Its highlights sit beside it.
     */
    const activity = (days: (Amount & { label: string })[]) => {
      const weeks = Math.ceil(days.length / 7)
      const values = days.map(pick)
      const active = values.filter(v => v > 0).sort((a, b) => a - b)
      const cuts = [0.25, 0.5, 0.75].map(q => active[Math.floor(q * active.length)] ?? 0)
      const shade = (v: number) => (v > 0 ? 1 + cuts.filter(c => v > c).length : 0)
      const square = (d: number, color: string, isBlank = false) => {
        const draw = (glyph: string) => (isBlank ? <Text>{'  '}</Text> : <Text color={color}>{glyph.repeat(2)}</Text>)
        return d % 2 === 0 ? [draw('█')] : [draw('▄'), draw('▀')]
      }
      // A month's name goes over its first week to start on one of its Sundays, as GitHub's does; the
      // first column's month, when it is only a tail, gives way to the next one's.
      const months = Array.from({ length: weeks }, (_, w) => {
        const [month = '', date = ''] = days[w * 7]?.label.split(' ') ?? []
        return Number(date) <= 7 || (w === 0 && Number(days[7]?.label.split(' ')[1]) > 7) ? { at: w * 3, text: month } : undefined
      }).filter(m => m !== undefined)

      const peak = Math.max(0, ...values)
      const busiest = days[values.indexOf(peak)]
      let streak = 0
      // Today still at zero doesn't break a streak that ran through yesterday.
      for (let i = values.length - ((values.at(-1) ?? 0) > 0 ? 1 : 2); i >= 0 && (values[i] ?? 0) > 0; i--) streak++
      const highlights: [string, string][] = [
        ['Busiest day', busiest && peak > 0 ? `${busiest.label} · ${show(peak)}` : '—'],
        ['Active days', `${active.length} of ${days.length}`],
        ['Streak', `${streak} ${streak === 1 ? 'day' : 'days'}`],
        ['Average active day', active.length > 0 ? show(active.reduce((a, v) => a + v, 0) / active.length) : '—'],
      ]

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text weight="bold">Activity</Text>
            <Text>
              <Text dimColor>less </Text>
              {palette.calendar.map(color => (
                <Text color={color}>{'██ '}</Text>
              ))}
              <Text dimColor>more</Text>
            </Text>
          </Box>
          <Text dimColor>{'    ' + ticks(months, weeks * 3)}</Text>
          <Box flexWrap="wrap" columnGap={4}>
            <Box>
              <Box flexDirection="column" width={4}>
                {WEEKDAYS.flatMap((name, d) => {
                  // A blank Text draws no row, so every row holds at least a space.
                  const label = <Text dimColor>{name || ' '}</Text>
                  return d % 2 === 0 ? [label] : [label, <Text> </Text>]
                })}
              </Box>
              <Box gap={1}>
                {Array.from({ length: weeks }, (_, w) => (
                  <Box flexDirection="column">
                    {WEEKDAYS.map((_, d) => {
                      const i = w * 7 + d
                      const day = days[i]
                      if (!day) return <Box flexDirection="column">{square(d, '', true)}</Box>

                      const v = pick(day)

                      return (
                        <Box key={`day-${i}`} flexDirection="column">
                          {square(d, palette.calendar[shade(v)] ?? '')}
                          <Box
                            position="absolute"
                            top={-1}
                            {...(w >= weeks / 2 ? { right: 0 } : { left: 0 })}
                            display="none"
                            hover={{ display: 'flex' }}
                          >
                            <Text inverse>{` ${day.label} · ${show(v)} `}</Text>
                          </Box>
                        </Box>
                      )
                    })}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box flexDirection="column" gap={1}>
              {highlights.map(([label, value]) => (
                <Box flexDirection="column">
                  <Text dimColor>{label}</Text>
                  <Text>{value}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      )
    }

    const minutesOld = last ? Math.max(0, Math.round((nowMs - last.scannedAt) / 60_000)) : 0
    let status: string | undefined
    if (picked !== 'session') {
      if (scanState.isRunning) status = 'reading…'
      else if (scanState.error) status = 'refresh failed'
      else if (last) status = minutesOld === 0 ? 'updated just now' : `updated ${minutesOld}m ago`
    }

    const tabs = (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box gap={3}>{MODES.map(m => tab(m.id, m.label, metric === m.id, () => void update($, mode, () => m.id), m.hotkey))}</Box>
          {e.props.placement === 'inline' && <Text dimColor>esc to close</Text>}
        </Box>
        {metric !== 'limits' && (
          <Box justifyContent="space-between">
            <Box gap={2}>{RANGES.map(r => tab(`range-${r.id}`, r.label, picked === r.id, () => void pickRange($, r.id)))}</Box>
            {status && <Text dimColor>{status}</Text>}
          </Box>
        )}
      </Box>
    )

    // The surface fills the whole body when docked; inline, the frame fits the tree anyway.
    const isDocked = e.props.placement === 'dock'
    const frame = (...sections: RenderChildren[]) => (
      <Box
        width={e.props.bodyColumns}
        {...(isDocked ? { minHeight: e.props.scroll.bodyRows } : {})}
        {...(surface ? { backgroundColor: surface } : {})}
      >
        <Box flexDirection="column" width={width} gap={1}>
          {tabs}
          {sections}
        </Box>
      </Box>
    )

    /** `9.84B` as the big `9.84` and a small `B tokens`. */
    const tokenHeadline = (n: number): [string, string] => {
      const [, digits = '', unit = ''] = /^([\d.,]+)(\D*)$/.exec(count(n)) ?? []
      return [digits, ` ${unit} tokens`.replace('  ', ' ')]
    }

    const cacheHit = (k: Omit<Tokens, 'byModel'>) => {
      const inputSide = k.input + k.cacheRead + k.cacheWrite
      return `${inputSide > 0 ? Math.round((k.cacheRead / inputSide) * 100) : 0}%`
    }

    const totals = (k: Omit<Tokens, 'byModel'>, lastCell: [string, string]) =>
      statRow([
        ['Cache read', count(k.cacheRead)],
        ['Cache write', count(k.cacheWrite)],
        ['Input', count(k.input)],
        ['Output', count(k.output)],
        lastCell,
      ])

    if (metric === 'limits') {
      const { context } = s

      return frame(
        context?.tokens !== undefined && (
          <Box flexDirection="column">
            {heading('Context window', `${context.percent ?? 0}%`)}
            {meter(context.percent ?? 0, limitColor(context.percent ?? 0))}
            <Text dimColor>{`${count(context.tokens)} of ${count(context.window)} · this session`}</Text>
          </Box>
        ),
        ...s.rateLimits.map(r => {
          const left = until(r.resetsAt, nowMs)
          const ahead = pace(r, nowMs)
          let outlook = ''
          if (ahead) outlook = ahead.percent < 100 ? ` · on pace for ${Math.round(ahead.percent)}%` : ` · at this pace, out in ${duration(ahead.outInMs)}`

          return (
            <Box flexDirection="column">
              {heading(LIMIT_NAMES[r.kind] ?? r.kind.replaceAll('_', ' '), `${r.percentUsed}%`)}
              {meter(r.percentUsed, limitColor(Math.max(r.percentUsed, ahead?.percent ?? 0)), ahead?.percent)}
              {left && <Text dimColor>{`resets in ${left}${outlook}`}</Text>}
            </Box>
          )
        }),
        s.rateLimits.length === 0 && context?.tokens === undefined && <Text dimColor>No limits reported yet</Text>,
      )
    }

    if (picked === 'session') {
      const elapsedHours = began > 0 && nowMs > began ? (nowMs - began) / 3_600_000 : 0
      const rate = elapsedHours >= 1 / 60 ? `$${(s.usd / elapsedHours).toFixed(2)}/hr` : undefined
      const total = sum(t)
      const turnsText = `${turnTotal} ${turnTotal === 1 ? 'turn' : 'turns'}`
      const caption = isCost ? [turnsText, `${count(total)} tokens`, rate].filter(Boolean).join(' · ') : `${turnsText} · ${dollars(s.usd)}`
      const models = Object.entries(t.byModel).map(([model, n]) => ({ name: modelName(model), tokens: n }))

      return frame(
        isCost ? hero(dollars(s.usd), '', 'this session', caption) : hero(...tokenHeadline(total), 'this session', caption),
        chart(turnList, isCost ? 'Cost per turn' : 'Tokens per turn', ['oldest', 'now']),
        totals(t, isCost ? ['Last turn', `+${dollars(turnList.at(-1)?.usd ?? 0)}`] : ['Cache hit', cacheHit(t)]),
        !isCost && byType('Tokens by type', t, count),
        models.length > 0 && (
          <Box flexDirection="column">
            {heading('Models')}
            {table('Model', models, true)}
          </Box>
        ),
        isCost && <Text dimColor>At API list prices</Text>,
      )
    }

    if (!stats) {
      return frame(
        scanState.error && !scanState.isRunning ? (
          <Text color="error">{`Couldn't read your history: ${scanState.error}`}</Text>
        ) : (
          <Text dimColor>Reading your history…</Text>
        ),
      )
    }

    const days = span?.days ?? 1
    const rate = days === 1 ? `${dollars(stats.usd / 24)}/hr` : `${dollars(stats.usd / days)}/day`
    const sessions = `${stats.sessions} ${stats.sessions === 1 ? 'session' : 'sessions'}`
    const total = sum(stats.tokens)
    const [, unitTitle] = UNITS[stats.unit]

    const hasCodex = stats.providers.some(p => p.id === 'codex' && p.tokens > 0)

    return frame(
      isCost
        ? hero(dollars(stats.usd), '', stats.when, `${sessions} · ${count(total)} tokens · ${rate} · API list prices`, providerRows(stats))
        : hero(...tokenHeadline(total), stats.when, `${sessions} · ${dollars(stats.usd)} at API list prices`, providerRows(stats)),
      chart(stats.series, `${unitTitle} ${isCost ? 'cost' : 'tokens'}`),
      picked === '90d' && activity(last?.calendar ?? []),
      totals(stats.tokens, isCost ? ['Cache saved', dollars(stats.saved)] : ['Cache hit', cacheHit(stats.tokens)]),
      isCost ? byType('Cost by type', stats.costs, dollars) : byType('Tokens by type', stats.tokens, count),
      breakdownOf(stats),
      stats.unpriced > 0 && <Text dimColor>{`${count(stats.unpriced)} tokens from models without a known price aren't in the total`}</Text>,
      <Text dimColor>{hasCodex ? 'Claude Code and Codex on this computer' : 'Claude Code on this computer'}</Text>,
    )
  })
}
