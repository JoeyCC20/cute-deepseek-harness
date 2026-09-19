/**
 * @vitest-environment jsdom
 *
 * Character component render tests (test-validation phase2b method 5): the
 * panel shows the latest speech or the pending interaction, and nothing while
 * the store is idle.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PixiesBubble, PixiesCharacter, PixiesPanel } from '../../src/client/character.tsx'
import { createPixiesStore } from '../../src/client/store.ts'
import type { PixiesPresentation } from '../../src/types.ts'

const MESSAGES = { approval: '需要你的批准', question: '想问你' }

afterEach(cleanup)

describe('PixiesCharacter', () => {
  it('renders an svg mark', () => {
    render(<PixiesCharacter />)
    expect(screen.getByTestId('pixies-character')).not.toBeNull()
  })
})

describe('PixiesBubble', () => {
  it('renders the text with a mood marker', () => {
    render(<PixiesBubble text="你好" mood="neutral" />)
    const bubble = screen.getByTestId('pixies-bubble')
    expect(bubble.textContent).toBe('你好')
    expect(bubble.getAttribute('data-mood')).toBe('neutral')
  })
})

describe('PixiesPanel', () => {
  it('renders nothing while the store is idle', () => {
    const store = createPixiesStore()
    const { container } = render(<PixiesPanel state={store.getState()} messages={MESSAGES} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the bare character while idle when showIdleCharacter is set', () => {
    const store = createPixiesStore()
    render(<PixiesPanel state={store.getState()} messages={MESSAGES} showIdleCharacter />)
    expect(screen.getByTestId('pixies-character')).not.toBeNull()
    expect(screen.queryByTestId('pixies-bubble')).toBeNull()
  })

  it('shows the latest speech presentation', () => {
    const store = createPixiesStore()
    const presentation: PixiesPresentation = {
      id: 'session-1#1',
      sessionId: 'session-1',
      character: 'spider-man',
      kind: 'speech',
      mood: 'neutral',
      text: '我是蜘蛛侠',
      seq: 1,
    }
    store.speak(presentation)
    render(<PixiesPanel state={store.getState()} messages={MESSAGES} />)
    expect(screen.getByTestId('pixies-bubble').textContent).toBe('我是蜘蛛侠')
    expect(screen.getByTestId('pixies-character')).not.toBeNull()
  })

  it('shows the pending interaction when nothing is being spoken', () => {
    const store = createPixiesStore()
    store.setInteraction({ kind: 'approval', sessionId: 'session-1', summary: 'echo' })
    render(<PixiesPanel state={store.getState()} messages={MESSAGES} />)
    expect(screen.getByTestId('pixies-bubble').textContent).toBe('需要你的批准：echo')
    expect(screen.getByTestId('pixies-bubble').getAttribute('data-mood')).toBe('asking')
  })
})
