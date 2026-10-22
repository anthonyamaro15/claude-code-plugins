import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
// The engine stores a row under its uuid and draws it under that uuid with the last group
// replaced by the block's index, as seen in a live session.
const ROW_UUID = '69672e95-7e3d-441d-b786-a07504e2771f'
const ROW_DRAWN = '69672e95-7e3d-441d-b786-000000000000'
const SHORT_UUID = '11111111-2222-4333-8444-555555555555'
const LONG_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const drawn = (uuid: string) => `${uuid.slice(0, uuid.lastIndexOf('-'))}-000000000000`
const LONG = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

const ROW = {
  plugin: 'paste-viewer',
  component: 'UserMessage',
  surface: 'terminal',
  props: { text: 'what is this', origin: { kind: 'composer' }, isExpanded: false },
} as const

/** Stands in for the engine, which draws its own rows as `engine`; the kit stores appended rows. */
function engine(on: On) {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'pastes' } }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return opened
}

function prompt($: Engine, uuid: string, content: { type: string; [field: string]: unknown }[]) {
  return $.session.append({
    uuid,
    door: 'prompt',
    origin: { kind: 'composer' },
    message: { type: 'user', role: 'user', content },
  })
}

test('a pasted image keeps its thumbnail hidden for hover, with no viewer button', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await prompt($, ROW_UUID, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    { type: 'text', text: 'what is this' },
  ])

  const ui = await $.ui.mount({ ...ROW, requestId: ROW_DRAWN })
  expect((await ui.find({ type: 'Text', text: /^engine$/ }))?.text).toBe('engine')
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: /hover/ }))?.text).toBe('🖼 1 image · hover to preview')
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('a long pasted prompt reads in full in the viewer; a short one is left alone', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await prompt($, SHORT_UUID, [{ type: 'text', text: 'hi' }])
  await prompt($, LONG_UUID, [{ type: 'text', text: LONG }])

  const short = await $.ui.mount({ ...ROW, requestId: drawn(SHORT_UUID) })
  expect(await short.find({ type: 'Button' })).toBeUndefined()
  await short.unmount()

  const row = await $.ui.mount({ ...ROW, requestId: drawn(LONG_UUID) })
  expect((await row.find({ type: 'Text', text: /View/ }))?.text).toBe('⤢ View 20 lines')
  await row.press({ key: 'view' })
  await row.unmount()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const pane = await $.ui.mount({
      plugin: 'paste-viewer',
      component: 'Pane',
      requestId: 'paste-viewer',
      surface,
      props: {
        title: 'Paste',
        isFocused: true,
        bodyColumns: 80,
        placement: 'inline',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect((await pane.find({ type: 'Text', text: /^Paste / }))?.text).toBe('Paste 1 of 1 · 20 lines')
    expect((await pane.find({ type: 'Text', text: /line 20$/ }))?.text).toBe(LONG)
    await pane.unmount()
  }
})
