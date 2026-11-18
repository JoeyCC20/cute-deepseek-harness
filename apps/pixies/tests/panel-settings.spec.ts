/** Result-panel settings parsing and the auto-hide policy. */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANEL_SETTINGS,
  MIN_PANEL_VISIBLE_MS,
  panelHideDelay,
  panelReadingMs,
  parsePanelSettings,
} from '../src/panel-settings.ts'

describe('parsePanelSettings', () => {
  it('defaults to an enabled panel hiding after ten seconds', () => {
    expect(parsePanelSettings(undefined)).toEqual(DEFAULT_PANEL_SETTINGS)
    expect(parsePanelSettings({})).toEqual({ enabled: true, autoHideMs: 10_000 })
    expect(parsePanelSettings([])).toEqual(DEFAULT_PANEL_SETTINGS)
    expect(parsePanelSettings('enabled')).toEqual(DEFAULT_PANEL_SETTINGS)
  })

  it('accepts the master switch and bounded hide delays', () => {
    expect(parsePanelSettings({ enabled: false })).toEqual({ enabled: false, autoHideMs: 10_000 })
    expect(parsePanelSettings({ autoHideMs: 2500 })).toEqual({ enabled: true, autoHideMs: 2500 })
    expect(parsePanelSettings({ autoHideMs: null })).toEqual({ enabled: true, autoHideMs: null })
    expect(parsePanelSettings({ autoHideMs: 0 })).toEqual({ enabled: true, autoHideMs: 0 })
    expect(parsePanelSettings({ autoHideMs: 1500.7 })).toEqual({ enabled: true, autoHideMs: 1500 })
  })

  it('falls back per field for hostile values', () => {
    expect(parsePanelSettings({ enabled: 'yes', autoHideMs: -1 })).toEqual(DEFAULT_PANEL_SETTINGS)
    expect(parsePanelSettings({ enabled: false, autoHideMs: Number.NaN }))
      .toEqual({ enabled: false, autoHideMs: 10_000 })
    expect(parsePanelSettings({ autoHideMs: Number.POSITIVE_INFINITY })).toEqual(DEFAULT_PANEL_SETTINGS)
    expect(parsePanelSettings({ autoHideMs: 'never' })).toEqual(DEFAULT_PANEL_SETTINGS)
  })
})

describe('panelReadingMs', () => {
  it('floors empty and tiny results at the minimum visible time', () => {
    expect(MIN_PANEL_VISIBLE_MS).toBe(10_000)
    expect(panelReadingMs(0)).toBe(10_000)
    expect(panelReadingMs(-5)).toBe(10_000)
    expect(panelReadingMs(1)).toBe(10_000)
    expect(panelReadingMs(Number.NaN)).toBe(10_000)
  })

  it('grows with the visible character count at a normal reading speed', () => {
    expect(panelReadingMs(100)).toBe(15_000)
    expect(panelReadingMs(200)).toBe(30_000)
  })
})

describe('panelHideDelay', () => {
  it('keeps a non-interactive result visible for at least ten seconds', () => {
    expect(panelHideDelay(DEFAULT_PANEL_SETTINGS, false)).toBe(10_000)
    expect(panelHideDelay({ enabled: true, autoHideMs: 2500 }, false)).toBe(10_000)
    expect(panelHideDelay({ enabled: true, autoHideMs: 2500 }, false, 0)).toBe(10_000)
  })

  it('extends the delay for longer results but honours a larger user floor', () => {
    expect(panelHideDelay(DEFAULT_PANEL_SETTINGS, false, 100)).toBe(15_000)
    expect(panelHideDelay(DEFAULT_PANEL_SETTINGS, false, 200)).toBe(30_000)
    expect(panelHideDelay({ enabled: true, autoHideMs: 30_000 }, false, 100)).toBe(30_000)
  })

  it('exempts choice panels, disabled panels, and disabled auto-hide', () => {
    expect(panelHideDelay(DEFAULT_PANEL_SETTINGS, true, 500)).toBeNull()
    expect(panelHideDelay({ enabled: false, autoHideMs: 1000 }, false, 500)).toBeNull()
    expect(panelHideDelay({ enabled: true, autoHideMs: null }, false, 500)).toBeNull()
    expect(panelHideDelay({ enabled: true, autoHideMs: 0 }, false, 500)).toBeNull()
  })
})
