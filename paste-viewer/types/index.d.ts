export type PastedImage = {
  mediaType: string
  /** The image's bytes, base64, as the prompt row stores them. */
  data: string
  /** Pixel size from the PNG header; 0 when unknown. */
  width: number
  height: number
  /** A PNG small enough for the terminal to draw. */
  isDrawable: boolean
}

export type Paste = { text: string; lines: number; images: PastedImage[] }

declare module 'claude-code' {
  interface PluginState {
    'paste-viewer': {
      /** Per transcript row (its uuid): what was pasted into it; null when nothing worth showing. */
      pastes: StateFamily<Paste | null>
      /** Row uuids that hold a paste, oldest first. */
      order: string[]
      /** The row the viewer shows. */
      viewing: string
    }
  }
}
