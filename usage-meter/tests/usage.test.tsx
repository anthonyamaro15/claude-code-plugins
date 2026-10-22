import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const NOW = new Date(2026, 9, 19, 12).getTime()

const PANE = {
  plugin: 'usage-meter',
  component: 'Pane',
  requestId: 'usage-meter',
  props: {
    title: 'Usage',
    isFocused: false,
    bodyColumns: 72,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'usage-meter',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

/**
 * Starts a session and runs a main turn that costs $0.50 and a subagent's (1.5k tokens each), then
 * one measurement. `ledger` is the session's running cost, which a test grows before the next turn.
 */
async function twoTurns($: Engine, on: On) {
  const ledger = { usd: 0 }
  const clock = mock.clock(on, { now: NOW })
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'usage-meter' } }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: NOW - 3_600_000, context: { window: 200000 }, rateLimits: [], cost: { usd: ledger.usd } } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const turn = { answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as const
  ledger.usd = 0.5
  await $.turn.complete({ ...turn, turnId: 'a', usage: { ...USAGE, model: 'opus' } })
  await $.turn.complete({ ...turn, turnId: 'b', agentId: 'x', usage: { ...USAGE, model: 'haiku' } })
  await $.session.measure({
    context: { tokens: 50000, window: 200000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 134 * 60_000).toISOString() }],
    cost: { usd: 0.5 },
    changed: ['cost', 'context', 'rateLimits'],
  })
  await clock.settle()

  return { clock, opened, ledger, turn }
}

async function text(ui: { find: (q: { type: 'Text'; text: RegExp }) => Promise<{ text: string } | undefined> }, re: RegExp) {
  return (await ui.find({ type: 'Text', text: re }))?.text
}

test('session view: cost, tokens and limits with pace, on every surface', async ($, on) => {
  await twoTurns($, on)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // $0.5000 in the smooth headline font, its dollar sign small beside it.
    expect(await text(ui, /^\$ $/)).toBe('$ ')
    expect(await text(ui, /^▄▀▀▀▄ /)).toBe('▄▀▀▀▄   █▀▀▀▀ ▄▀▀▀▄ ▄▀▀▀▄ ▄▀▀▀▄')
    expect(await text(ui, /^1 turn/)).toBe('1 turn · 3.00k tokens · $0.50/hr')
    expect(await text(ui, /^\+\$/)).toBe('+$0.5000')
    expect(await text(ui, /^Cost per turn$/)).toBeUndefined()

    await ui.press({ key: 'tokens' })
    expect(await text(ui, /^ k tokens$/)).toBe(' k tokens')
    expect(await text(ui, /^1 turn/)).toBe('1 turn · $0.5000')
    expect(await text(ui, /^0%$/)).toBe('0%')
    expect(await text(ui, /^Tokens by type$/)).toBe('Tokens by type')
    expect((await text(ui, /^haiku\s*$/))?.trim()).toBe('haiku')

    await ui.press({ key: 'limits' })
    expect(await text(ui, /^50\.0k of/)).toBe('50.0k of 200k · this session')
    expect(await text(ui, /^5-hour limit$/)).toBe('5-hour limit')
    // 12% used 2h 46m into the 5-hour window is 22% by its reset.
    expect(await text(ui, /^resets in/)).toBe('resets in 2h 14m · on pace for 22%')

    await ui.press({ key: 'cost' })
    await ui.unmount()
  }
})

test('the band shows totals and the countdown, and a click opens the popup', async ($, on) => {
  const { opened } = await twoTurns($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await text(ui, /^3\.00k$/)).toBe('3.00k')
    expect(await text(ui, /^\$0\.5000$/)).toBe('$0.5000')
    expect(await text(ui, /^ 25%$/)).toBe(' 25%')
    expect(await text(ui, /^ 2h 14m$/)).toBe(' 2h 14m')
    await ui.press({ key: 'usage' })
    await ui.unmount()
  }

  expect(opened).toEqual(['usage-meter', 'usage-meter'])
})

test('the per-turn chart appears from the second turn, one bar a turn, scaled to its peak', async ($, on) => {
  const { ledger, turn } = await twoTurns($, on)
  // Steps report cost along the way; only the turn's end makes a bar.
  ledger.usd = 0.6
  await $.session.measure({ context: { tokens: 55000, window: 200000, percent: 27 }, rateLimits: [], cost: { usd: 0.6 }, changed: ['cost'] })
  ledger.usd = 0.75
  await $.turn.complete({ ...turn, turnId: 'c', usage: { ...USAGE, model: 'opus' } })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await text(ui, /^Cost per turn$/)).toBe('Cost per turn')
    expect(await text(ui, /┤$/)).toBe('$0.50 ┤')
    expect(await text(ui, /^\+\$/)).toBe('+$0.2500')

    await ui.press({ key: 'tokens' })
    expect(await text(ui, /^Tokens per turn$/)).toBe('Tokens per turn')
    expect(await text(ui, /┤$/)).toBe('3.00k ┤')
    await ui.press({ key: 'cost' })
    await ui.unmount()
  }
})

/** What scripts/scan.py prints, one made-up span for every range. */
const SPAN = {
  unit: 'day',
  when: 'Sep 21 – Oct 20',
  sessions: 2,
  providers: [
    { id: 'claude', sessions: 1, tokens: 2_500_000_000, usd: 2400 },
    { id: 'codex', sessions: 1, tokens: 500_010_000, usd: 198.76 },
  ],
  tokens: { input: 1000, output: 2000, cacheRead: 3_000_000_000, cacheWrite: 7000 },
  usd: 2598.76,
  costs: { input: 0.29, output: 522.92, cacheRead: 1203.09, cacheWrite: 872.46 },
  saved: 20714.35,
  unpriced: 500,
  models: [
    { model: 'claude-opus-5-5', provider: 'claude', tokens: 2_000_000_000, usd: 2097 },
    { model: 'claude-haiku-4-5-20251001', provider: 'claude', tokens: 500_000_000, usd: 303 },
    { model: 'gpt-6-astra', provider: 'codex', tokens: 500_010_000, usd: 198.76 },
  ],
  series: [
    { label: 'Sep 21', tokens: 1_000_000_000, usd: 600, byProvider: { claude: { tokens: 1_000_000_000, usd: 600 }, codex: { tokens: 0, usd: 0 } } },
    {
      label: 'Oct 20',
      tokens: 2_000_010_000,
      usd: 1998.76,
      byProvider: { claude: { tokens: 1_500_000_000, usd: 1800 }, codex: { tokens: 500_010_000, usd: 198.76 } },
    },
  ],
}
/** Two weeks of calendar from a Sunday, one busy Tuesday. */
const CALENDAR = Array.from({ length: 14 }, (_, i) => ({ label: `Oct ${4 + i}`, tokens: i === 2 ? 1000 : 0, usd: i === 2 ? 50 : 0 }))
const SCANNED = { version: 4, scannedAt: NOW, ranges: { '24h': SPAN, '7d': SPAN, '30d': SPAN, '90d': SPAN }, calendar: CALENDAR }

function answerScan(on: On, run: { exitCode: number; stdout?: string; stderr?: string }, argvs: string[][] = []) {
  on('process.run', (_, e) => {
    argvs.push([...e.argv])
    return { value: { stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...run } }
  })
  return argvs
}

test('a history range reads the transcripts once and shows totals, types and a breakdown', async ($, on) => {
  const argvs = answerScan(on, { exitCode: 0, stdout: JSON.stringify(SCANNED) })
  await twoTurns($, on)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'range-30d' })

    expect(await text(ui, /^2 sessions/)).toBe('2 sessions · 3.00B tokens · $86.63/day · API list prices')
    expect((await text(ui, /^Claude Code\s*$/))?.trim()).toBe('Claude Code')
    expect(await text(ui, /^\s*[\d.]+% of cost/)).toBe('92.4% of cost · 2.50B tokens')
    expect(await text(ui, /^\$198\.76$/)).toBe('$198.76')
    expect(await text(ui, /· Codex/)).toBe(' Oct 20 · $1,998.76 · Codex $198.76 ')
    expect(await text(ui, /^Sep 21 – /)).toBe('Sep 21 – Oct 20')
    expect(await text(ui, /^updated/)).toBe('updated just now')
    expect(await text(ui, /^Daily cost$/)).toBe('Daily cost')
    expect(await text(ui, /┤$/)).toBe('$2.0k ┤')
    expect(await text(ui, /^\$20,714\.35$/)).toBe('$20,714.35')
    expect(await text(ui, /^Cost by type$/)).toBe('Cost by type')
    expect(await text(ui, /^\$1,203\.09$/)).toBe('$1,203.09')
    expect((await text(ui, /^\s*\$2,097\.00$/))?.trim()).toBe('$2,097.00')
    expect((await text(ui, /^haiku-4-5\s*$/))?.trim()).toBe('haiku-4-5')
    expect(await text(ui, /without a known price/)).toBe("500 tokens from models without a known price aren't in the total")
    expect(await text(ui, /on this computer$/)).toBe('Claude Code and Codex on this computer')
    expect(await text(ui, /^Activity$/)).toBeUndefined()

    await ui.press({ key: 'by-time' })
    expect((await text(ui, /^Oct 20\s*$/))?.trim()).toBe('Oct 20')
    expect((await text(ui, /^\s*\$1,998\.76$/))?.trim()).toBe('$1,998.76')

    await ui.press({ key: 'tokens' })
    expect(await text(ui, /^ B tokens$/)).toBe(' B tokens')
    expect(await text(ui, /^2 sessions/)).toBe('2 sessions · $2,598.76 at API list prices')
    expect(await text(ui, /^Daily tokens$/)).toBe('Daily tokens')
    expect(await text(ui, /^\s*[\d.]+% of tokens/)).toBe('83.3% of tokens · $2,400.00')

    await ui.press({ key: 'by-model' })
    await ui.press({ key: 'cost' })
    await ui.press({ key: 'range-90d' })
    expect(await text(ui, /^Activity$/)).toBe('Activity')
    expect(await text(ui, /^Mon$/)).toBe('Mon')
    expect(await text(ui, /^ Oct 6 /)).toBe(' Oct 6 · $50.00 ')
    expect((await text(ui, /^ {4}Oct/))?.trim()).toBe('Oct')
    expect(await text(ui, /^Oct 6 · /)).toBe('Oct 6 · $50.00')
    expect(await text(ui, /^1 of 14$/)).toBe('1 of 14')
    // The busy day was a Tuesday; nothing since, so no streak runs into today.
    expect(await text(ui, /^0 days$/)).toBe('0 days')

    await ui.press({ key: 'range-session' })
    expect(await text(ui, /^this session$/)).toBe('this session')
    await ui.unmount()
  }

  // Later opens within five minutes reuse the first read.
  expect(argvs).toHaveLength(1)
  expect(argvs[0]?.slice(0, 2)).toEqual(['python3', '-I'])
  expect(argvs[0]?.[2]).toMatch(/\/scripts\/scan\.py$/)
})

test('a failed read says why', async ($, on) => {
  answerScan(on, { exitCode: 1, stderr: 'Traceback (most recent call last):\nPermissionError: denied' })
  await twoTurns($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'range-7d' })

    expect(await text(ui, /^Couldn't read/)).toBe("Couldn't read your history: PermissionError: denied")
    expect(await text(ui, /^refresh failed$/)).toBe('refresh failed')
    await ui.unmount()
  }
})

/** `/usage-meter <args>` as typed at the prompt of a fullscreen terminal. */
function typed(args: string) {
  return { command: 'usage-meter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 190 } } as const
}

test('the font command switches the headline font and remembers it', async ($, on) => {
  const stored: unknown[] = []
  on('store.set', (_, e) => (stored.push([e.key, e.value]), { value: undefined }))
  await twoTurns($, on)

  expect((await $.command.run(typed('font rounded'))).text).toBe('Headline font: rounded.')
  expect(stored).toEqual([['font', 'rounded']])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await text(ui, /^╭─╮ /)).toBe('╭─╮   ╭─╴ ╭─╮ ╭─╮ ╭─╮')
    await ui.unmount()
  }

  const unknown = await $.command.run(typed('font comic'))
  expect(unknown.text).toBe('Fonts: smooth, rounded, bold, blocky. Usage: /usage-meter font rounded')
})

test('the bg command picks the background and remembers it', async ($, on) => {
  const stored: unknown[] = []
  on('store.set', (_, e) => (stored.push([e.key, e.value]), { value: undefined }))
  await twoTurns($, on)

  expect((await $.command.run(typed('bg #0D1117'))).text).toBe('Background: #0d1117.')
  expect((await $.command.run(typed('bg none'))).text).toBe('Background: none.')
  expect((await $.command.run(typed('bg default'))).text).toBe('Background: default.')
  expect(stored).toEqual([['background', '#0d1117'], ['background', 'none'], ['background', '']])
  expect((await $.command.run(typed('bg blue'))).text).toMatch(/^Usage: \/usage-meter bg/)
})
