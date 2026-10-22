import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Paste, PastedImage } from '../types'

const VIEWER = 'paste-viewer'
const LONG_LINES = 12
const LONG_CHARS = 1200
const MAX_PNG_BYTES = 2 * 1024 * 1024
const THUMB_COLUMNS = 30

const pastes = atom({ plugin: 'paste-viewer', key: 'pastes' } as const, null as Paste | null)
const order = atom({ plugin: 'paste-viewer', key: 'order' } as const, [] as string[])
const viewing = atom({ plugin: 'paste-viewer', key: 'viewing' } as const, '')

/** Width and height from a base64 PNG's header; undefined when it is not a PNG. */
function pngSize(data: string): { width: number; height: number } | undefined {
  try {
    const head = atob(data.slice(0, 32))
    if (head.slice(1, 4) !== 'PNG') return undefined

    const at = (i: number) =>
      ((head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) | (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3)) >>> 0

    return { width: at(16), height: at(20) }
  } catch {
    return undefined
  }
}

/** What a prompt row holds worth a viewer: its images, and its text when long; null otherwise. */
function pasteOf(content: readonly { type: string; [field: string]: unknown }[]): Paste | null {
  const text = content
    .filter(b => b.type === 'text')
    .map(b => String(b.text ?? ''))
    .join('\n')
  const images = content.flatMap((b): PastedImage[] => {
    const source = b.source as { type?: string; media_type?: string; data?: string } | undefined
    if (b.type !== 'image' || source?.type !== 'base64' || !source.data) return []

    const size = pngSize(source.data)
    const bytes = (source.data.length * 3) / 4

    return [{
      mediaType: source.media_type ?? 'image',
      data: source.data,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      isDrawable: size !== undefined && bytes <= MAX_PNG_BYTES,
    }]
  })
  const lines = text.split('\n').length
  const isLong = lines >= LONG_LINES || text.length >= LONG_CHARS

  return images.length > 0 || isLong ? { text, lines, images } : null
}

function isLong(paste: Paste): boolean {
  return paste.lines >= LONG_LINES || paste.text.length >= LONG_CHARS
}

/** Rows for an image `columns` wide, keeping its aspect: a cell is about twice as tall as wide. */
function rowsFor(image: PastedImage, columns: number, maxRows: number): number {
  if (image.width === 0 || image.height === 0) return Math.min(maxRows, Math.round(columns / 3))

  return Math.max(2, Math.min(maxRows, Math.round((columns * image.height) / image.width / 2)))
}

/**
 * The key a prompt row's paste is kept under: its id less the last group. The engine stores a
 * row under its uuid but draws it as `<first four groups>-<block index>`, so only that prefix matches.
 */
function rowKey(id: string): string {
  return id.slice(0, id.lastIndexOf('-'))
}

async function openViewer($: EngineInterface, id: string): Promise<void> {
  await update($, viewing, () => id)
  await $.ui.open({ id: VIEWER, title: 'Paste', focus: true, closeOnEscape: true, rows: 40 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pastes',
      description: 'Read the long prompts pasted this session in full',
    })

    return next(e)
  })

  on('command.run', { command: 'pastes' }, async $ => {
    const latest = (await read($, order)).at(-1)
    if (latest === undefined) return { text: 'No long prompts pasted yet this session.' }

    await openViewer($, latest)

    return { text: 'Paste viewer opened.' }
  })

  on('session.append', async ($, e, next) => {
    const kept = await next(e)
    const isTyped = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (kept.message === undefined || !isTyped || e.agentId !== undefined || e.message.type !== 'user' || e.message.isMeta) {
      return kept
    }

    const paste = pasteOf(kept.message.content)
    if (paste) {
      const key = rowKey(e.uuid)
      await update($, memberOf(pastes, { requestId: key }), () => paste)
      // The viewer reads text alone: only long prompts are stepped through there.
      if (isLong(paste)) await update($, order, list => [...list, key])
    }

    return kept
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const key = rowKey(e.requestId)
    const paste = await read($, memberOf(pastes, { requestId: key }))
    if (!paste || e.surface !== 'terminal') return next(e)

    const { Box, Text, Button, Image } = $.ui.resolve(e)
    const row = await next(e)
    const drawable = paste.images.filter(image => image.isDrawable)
    const n = paste.images.length
    const columns = Math.max(8, Math.min(THUMB_COLUMNS, (e.viewport?.columns ?? 80) - 4))

    // Thumbnails stay hidden until the pointer is on this line, then float over the rows above it.
    return (
      <Box flexDirection="column">
        {row}
        <Box key="paste" paddingLeft={2} gap={3}>
          {n > 0 && <Text dimColor>{`🖼 ${n === 1 ? '1 image' : `${n} images`} · hover to preview`}</Text>}
          {isLong(paste) && (
            <Button key="view" plain onPress={() => void openViewer($, key)}>
              <Text dimColor>{`⤢ View ${paste.lines} lines`}</Text>
            </Button>
          )}
          {drawable.length > 0 && (
            <Box position="absolute" bottom={1} left={2} gap={1} display="none" hover={{ display: 'flex' }}>
              {drawable.map((image, i) => (
                <Image
                  key={`thumb-${i}`}
                  source={{ png: image.data }}
                  columns={columns}
                  rows={rowsFor(image, columns, 12)}
                  alt={`Pasted image ${i + 1}`}
                />
              ))}
            </Box>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: VIEWER }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, order)
    const id = await read($, viewing)
    const paste = await read($, memberOf(pastes, { requestId: id }))
    if (!paste) return <Text dimColor>Nothing to show.</Text>

    const at = list.indexOf(id)
    const step = (by: number) => () => {
      const other = list[at + by]
      if (other !== undefined) void update($, viewing, () => other)
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text dimColor>{`Paste ${at + 1} of ${list.length} · ${paste.lines} lines`}</Text>
          <Box gap={2}>
            {at > 0 && <Button key="prev" plain hotkey="p" onPress={step(-1)}>Prev</Button>}
            {at < list.length - 1 && <Button key="next" plain hotkey="n" onPress={step(1)}>Next</Button>}
            <Text dimColor>esc to close</Text>
          </Box>
        </Box>
        <Text>{paste.text}</Text>
      </Box>
    )
  })
}
