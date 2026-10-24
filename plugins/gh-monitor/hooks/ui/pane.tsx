/**
 * The /gh-monitor pane: every watched item with its detail (check names and
 * timings, run link, tag, image digest, chart version, outcome) and a stop
 * button per live item. Lines come pre-fitted from ./text (`paneBlocks`).
 * `$`-free: elements and actions come from ../register.tsx.
 */
import type { Elements } from 'claude-code'

import type { ItemId } from '../engine/model'
import { TONE_COLOR } from './band'
import type { PaneBlock } from './text'

export type PaneElements = Pick<Elements['terminal'] | Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Link'>

export type PaneActions = {
  stop: (id: ItemId) => void
  bump: (id: ItemId, prompt: string) => void
  dismiss: (id: ItemId) => void
}

export const PANE_EMPTY = 'Nothing watched. /watch-pr or /watch-release to add one.'

export function pane(blocks: readonly PaneBlock[], els: PaneElements, actions: PaneActions) {
  const { Box, Text, Button, Link } = els
  if (blocks.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {PANE_EMPTY}
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {blocks.map(block => (
        <Box key={`item:${block.key}`} flexDirection="column" marginBottom={1}>
          <Text bold wrap="truncate-end">
            {block.header}
          </Text>
          {block.lines.map(line =>
            line.href ? (
              <Link href={line.href}>
                {line.text}
              </Link>
            ) : (
              <Text color={line.tone ? TONE_COLOR[line.tone] : undefined} dimColor={line.isDim} wrap="truncate-end">
                {line.text}
              </Text>
            ),
          )}
          {block.buttons.length > 0 ? (
            <Box flexDirection="row">
              {block.buttons.map(b => (
                <Button
                  key={b.key}
                  label={b.label}
                  {...(b.action === 'bump' ? { variant: 'primary' as const } : {})}
                  onPress={() =>
                    b.action === 'stop'
                      ? actions.stop(block.id)
                      : b.action === 'bump'
                        ? actions.bump(block.id, b.prompt ?? '')
                        : actions.dismiss(block.id)
                  }
                />
              ))}
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  )
}
