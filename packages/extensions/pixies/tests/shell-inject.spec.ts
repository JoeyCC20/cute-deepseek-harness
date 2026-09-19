/** Shell page-injection rows: the env-gated rows that turn the standard web page into the character surface. */
import { describe, expect, it } from 'vitest'
import {
  PIXIES_SHELL_ENV,
  PIXIES_SHELL_FLAG,
  PIXIES_SHELL_STYLE,
  pixiesIndexInjections,
} from '../src/shell-inject.ts'

describe('pixiesIndexInjections', () => {
  it('emits nothing for normal runs', () => {
    expect(pixiesIndexInjections(false)).toEqual([])
  })

  it('emits exactly the marker row and the hiding style row for shell runs', () => {
    expect(pixiesIndexInjections(true)).toEqual([
      { kind: 'global', name: PIXIES_SHELL_FLAG, value: true },
      { kind: 'style', text: PIXIES_SHELL_STYLE },
    ])
  })

  it('styles hide every standard-app element and keep the window transparent', () => {
    expect(PIXIES_SHELL_STYLE).toContain('background:transparent!important')
    expect(PIXIES_SHELL_STYLE).toContain('overflow:hidden!important')
    expect(PIXIES_SHELL_STYLE).toContain('body>*:not([data-pixies-shell]){display:none!important}')
  })

  it('uses the shell-only flag and environment names', () => {
    expect(PIXIES_SHELL_FLAG).toBe('__DSH_PIXIES_SHELL__')
    expect(PIXIES_SHELL_ENV).toBe('DSH_PIXIES_SHELL')
  })
})
