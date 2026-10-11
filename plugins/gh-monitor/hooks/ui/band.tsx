/**
 * The band above the prompt: one row per active PR or release, failures
 * first, a `+N more · /gh-monitor for all` row past `maxRows`. Rows come
 * pre-fitted from ./text (`bandRows`); this only lays them out. `$`-free: the
 * element table and the button actions come from ../register.tsx.
 */
import type { Elements } from 'claude-code'

import type { ItemId } from '../engine/model'
import type { BandRow, Tone } from './text'

export type BandElements = Pick<Elements['terminal'] | Elements['desktop'], 'Box' | 'Text' | 'Button'>

export type BandActions = {
  /** Drafts `prompt` (the row's deploy request) in the prompt box. */
  bump: (id: ItemId, prompt: string) => void
  dismiss: (id: ItemId) => void
}

export const TONE_COLOR: Record<Tone, string | undefined> = {
  bad: 'red',
  busy: 'yellow',
  wait: undefined,
  good: 'green',
  neutral: undefined,
  offer: 'cyan',
}

export function band(rows: readonly BandRow[], els: BandElements, actions: BandActions) {
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Box key={`row:${row.key}`} flexDirection="row">
          {row.marker ? (
            <Text color={TONE_COLOR[row.tone]} dimColor={row.isDim}>
              {`${row.marker} `}
            </Text>
          ) : null}
          <Text dimColor={row.isDim} wrap="truncate-end">
            {row.text}
          </Text>
          {row.buttons.map(b => (
            <Box key={`btn:${b.key}`} flexDirection="row">
              <Text> </Text>
              <Button
                key={b.key}
                label={b.label}
                {...(b.hotkey ? { hotkey: b.hotkey } : {})}
                {...(b.action === 'bump' ? { variant: 'primary' as const } : { dimColor: true })}
                onPress={() => (b.action === 'bump' ? actions.bump(row.id as ItemId, b.prompt ?? '') : actions.dismiss(row.id as ItemId))}
              />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  )
}
