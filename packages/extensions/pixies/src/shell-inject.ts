/**
 * Pixies shell page injection: the rows the host half pushes onto
 * `webserver/index-inject` so the pixies shell window turns the standard web
 * client page into a character-only surface. Gated on the shell-only
 * `DSH_PIXIES_SHELL=1` environment, so desktop and web runs are untouched.
 * @module @deepseek-ai/dsh-pixies/shell-inject
 */

/** Structural slice of the webserver IndexInjection union (keeps this leaf standalone). */
export type PixiesIndexInjection =
  | { readonly kind: 'global'; readonly name: string; readonly value: unknown }
  | { readonly kind: 'style'; readonly text: string }

/** The global marker the pixies client half checks before mounting the overlay. */
export const PIXIES_SHELL_FLAG = '__DSH_PIXIES_SHELL__'

/** The shell-only environment the pixies Electron shell sets for its host child. */
export const PIXIES_SHELL_ENV = 'DSH_PIXIES_SHELL'

/** Hide the standard application mount and let the transparent window show only the character. */
export const PIXIES_SHELL_STYLE = [
  'html,body{background:transparent!important;margin:0!important;overflow:hidden!important}',
  'body>*:not([data-pixies-shell]){display:none!important}',
].join('')

/**
 * Build the injection rows for the pixies shell page.
 * @param shellEnabled - whether the host runs as the pixies shell backend.
 * @returns the marker and style rows, or an empty array for normal runs.
 */
export function pixiesIndexInjections(shellEnabled: boolean): readonly PixiesIndexInjection[] {
  if (!shellEnabled) return []
  return [
    { kind: 'global', name: PIXIES_SHELL_FLAG, value: true },
    { kind: 'style', text: PIXIES_SHELL_STYLE },
  ]
}
