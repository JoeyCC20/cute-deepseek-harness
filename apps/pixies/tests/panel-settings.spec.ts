/** Result-panel settings parsing and the auto-hide policy. */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANEL_SETTINGS,
  panelHideDelay,
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

describe('panelHideDelay', () => {
  it('hides a non-interactive panel after the configured delay', () => {
    expect(panelHideDelay(DEFAULT_PANEL_SETTINGS, false)).toBe(10_000)
    expect(panelHideDelay({ enabled: true, autoHideMs: 2500 }, false)).toBe(2500)
  })

  it('exempts choice panels, disabled panels, and disabled auto-hide', () => {
    expect(panelHideDelay(DEFAULT_PANEL_SETTINGS, true)).toBeNull()
    expect(panelHideDelay({ enabled: false, autoHideMs: 1000 }, false)).toBeNull()
    expect(panelHideDelay({ enabled: true, autoHideMs: null }, false)).toBeNull()
    expect(panelHideDelay({ enabled: true, autoHideMs: 0 }, false)).toBeNull()
  })
})
