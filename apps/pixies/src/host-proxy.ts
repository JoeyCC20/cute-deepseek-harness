/** Loopback forwarder from the dsh-app:// protocol to the running dsh Host. */

/**
 * The desktop boot payload the Web entry expects from `dshDesktopBoot.ready()`.
 * `streamBaseUrl` must be the Host's real loopback origin: without it the API
 * gateway builds its Remote Event WebSocket from `location.origin`
 * (`ws://app/api/remote.mux`), which a custom protocol cannot serve, and the
 * client stays in a "connection lost, retry" loop — no prompt can reach a
 * session. The token query is deliberately dropped, exactly as
 * `apps/desktop/src/main.ts` does for its own boot handler.
 * @param hostUrl - the Host's ready URL (with its one-shot token).
 * @returns the injection-free boot payload with the Host origin.
 */
export function pixiesBootPayload(hostUrl: string): { readonly injections: readonly []; readonly streamBaseUrl: string } {
  return { injections: [], streamBaseUrl: new URL(hostUrl).origin }
}

/** The header decision Electron's `onBeforeSendHeaders` accepts for a request. */
export type PixiesWebSocketHeaders =
  | { readonly requestHeaders: Record<string, string> }
  | { readonly cancel: true }
  | Record<string, never>

/**
 * Authenticate the API gateway's Remote Event WebSocket upgrade.
 *
 * The renderer opens `ws://127.0.0.1:<host>/api/remote.mux` directly (a custom
 * `dsh-app://` scheme cannot serve WebSockets), so the request bypasses the
 * `protocol.handle` forwarder and carries neither the Host cookie nor a Host
 * Origin. Desktop rewrites exactly those three headers for its own window;
 * PIXIES does the same, scoped to its window and to this Host's port, and
 * cancels upgrades from any other origin.
 * @param details - Electron's pending request details.
 * @param hostUrl - the Host's ready URL.
 * @param hostCookie - the boot-time authentication cookie.
 * @param windowWebContentsId - the authenticated Pixies window's webContents id, if any.
 * @returns the callback payload: rewritten headers, a cancellation, or no-op.
 */
export function pixiesWebSocketHeaders(
  details: {
    readonly url: string
    readonly requestHeaders: Record<string, string | string[] | undefined>
    readonly webContentsId?: number
  },
  hostUrl: string,
  hostCookie: string,
  windowWebContentsId: number | undefined,
): PixiesWebSocketHeaders {
  if (windowWebContentsId === undefined || details.webContentsId !== windowWebContentsId) return {}
  const target = new URL(hostUrl)
  if (new URL(details.url).host !== target.host) return {}
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(details.requestHeaders)) {
    if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  if (headers.origin !== 'dsh-app://app') return { cancel: true }
  return {
    requestHeaders: {
      ...headers,
      origin: target.origin,
      cookie: hostCookie,
      'sec-fetch-site': 'same-origin',
    },
  }
}

/**
 * Forward one dsh-app://app request to the running dsh Host over loopback HTTP.
 *
 * The renderer cannot talk to the Host's authentication cookie directly, so we
 * attach the cookie PIXIES retrieved once at startup (`authenticatePixiesHost`)
 * to every forwarded request and strip the renderer-supplied Origin, Cookie,
 * Host and Sec-Fetch-Site headers — matching `apps/desktop/src/web-document.ts`
 * `forwardWebRequest`. The Host URL PIXIES receives at startup already carries
 * the one-shot token query; the cookie carries the rest of the session.
 *
 * @param request - the incoming renderer request from the dsh-app protocol.
 * @param hostUrl - the Host's authenticated URL reported in the `ready` event.
 * @param hostCookie - the cookie `authenticatePixiesHost` collected.
 * @returns the loopback Response from the Host, with hop-by-hop headers filtered.
 */
export async function forwardToPixiesHost(request: Request, hostUrl: string, hostCookie: string): Promise<Response> {
  const incoming = new URL(request.url)
  const target = new URL(hostUrl)
  // Replace only the path/query of the incoming request so the host's
  // authenticated query string (session token) survives every proxy hop.
  target.pathname = incoming.pathname
  target.search = incoming.search
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'sec-fetch-site']) headers.delete(name)
  headers.set('cookie', hostCookie)
  const method = request.method.toUpperCase()
  // Keep the renderer's cancellation: without the signal, long-lived streams
  // (and every retry after a page reload) stay open on the Host side forever.
  const init: RequestInit & { duplex?: 'half' } = { method, headers, redirect: 'manual', signal: request.signal }
  if (method !== 'GET' && method !== 'HEAD' && request.body !== null) {
    // Node's fetch (undici) refuses a ReadableStream body unless half-duplex
    // streaming is declared: without it every proxied POST with a body throws
    // "duplex option is required when sending a body", the catch below turns
    // that into a 502, and the renderer reports it as
    // "transport failure for /api/session/create: HTTP 502". Desktop's
    // `forwardWebRequest` declares the same, which is why only PIXIES saw it.
    init.body = request.body
    init.duplex = 'half'
  }
  try {
    const response = await fetch(target, init)
    const filtered = new Headers(response.headers)
    for (const name of ['set-cookie', 'content-encoding', 'content-length']) filtered.delete(name)
    return new Response(response.body, { status: response.status, headers: filtered })
  } catch (error) {
    return new Response(`pixies: host fetch failed: ${error instanceof Error ? error.message : String(error)}`, { status: 502 })
  }
}
