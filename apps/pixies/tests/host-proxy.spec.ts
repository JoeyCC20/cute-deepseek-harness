/**
 * Facade tests for the dsh-app → Host loopback forwarder (test-validation
 * method 5): the packaged "session/create 502" regression.
 *
 * Node's fetch refuses a ReadableStream body unless `duplex: 'half'` is
 * declared, so a forwarder that drops it turns every proxied POST with a body
 * (session/create, prompt, upload) into the "pixies: host fetch failed" 502 the
 * renderer surfaces as "transport failure for /api/session/create: HTTP 502".
 * Desktop's `forwardWebRequest` declares it; PIXIES' copy did not.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forwardToPixiesHost, pixiesBootPayload, pixiesWebSocketHeaders } from '../src/host-proxy.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('pixiesWebSocketHeaders', () => {
  const HOST = 'http://127.0.0.1:19387/?token=one-shot'
  const details = (url: string, id: number | undefined = 7, origin = 'dsh-app://app') => ({
    url,
    webContentsId: id,
    requestHeaders: { Origin: origin, Host: '127.0.0.1:19387' },
  })

  it('authenticates the pixies window upgrade with the Host cookie and origin', () => {
    expect(pixiesWebSocketHeaders(details('ws://127.0.0.1:19387/api/remote.mux'), HOST, 'session=owned', 7))
      .toEqual({
        requestHeaders: {
          origin: 'http://127.0.0.1:19387',
          host: '127.0.0.1:19387',
          cookie: 'session=owned',
          'sec-fetch-site': 'same-origin',
        },
      })
  })

  it('leaves other windows, other ports, and absent windows untouched', () => {
    const url = 'ws://127.0.0.1:19387/api/remote.mux'
    expect(pixiesWebSocketHeaders(details(url, 8), HOST, 'session=owned', 7)).toEqual({})
    expect(pixiesWebSocketHeaders(details(url), HOST, 'session=owned', undefined)).toEqual({})
    expect(pixiesWebSocketHeaders(
      details('ws://127.0.0.1:9999/api/remote.mux'), HOST, 'session=owned', 7,
    )).toEqual({})
  })

  it('cancels an upgrade whose origin is not the pixies app', () => {
    expect(pixiesWebSocketHeaders(
      details('ws://127.0.0.1:19387/api/remote.mux', 7, 'https://evil.example'), HOST, 'session=owned', 7,
    )).toEqual({ cancel: true })
  })
})

describe('forwardToPixiesHost', () => {
  it('declares half-duplex streaming so a POST body does not fold into a 502', async () => {
    const seen: { cookie: string | null; origin: string | null; body: string } = { cookie: null, origin: null, body: '' }
    const fetch = vi.fn(async (_target: URL, init: RequestInit & { duplex?: 'half' }) => {
      // undici raises exactly this when a stream body arrives without duplex.
      if (init.body !== null && init.body !== undefined && init.duplex !== 'half') {
        throw new TypeError('RequestInit: duplex option is required when sending a body.')
      }
      seen.cookie = new Headers(init.headers).get('cookie')
      seen.origin = new Headers(init.headers).get('origin')
      seen.body = await new Response(init.body).text()
      return new Response('{"ok":true}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const request = new Request('dsh-app://app/api/session/create?x=1', {
      method: 'POST',
      body: '{"payload":1}',
      headers: { origin: 'dsh-app://app', cookie: 'untrusted', 'content-type': 'application/json' },
    })
    const response = await forwardToPixiesHost(request, 'http://127.0.0.1:4321/?token=secret', 'session=owned')
    expect(response.status).toBe(200)
    const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit & { duplex?: 'half' }]
    expect(target.href).toBe('http://127.0.0.1:4321/api/session/create?x=1')
    expect(init.duplex).toBe('half')
    expect(seen.cookie).toBe('session=owned')
    expect(seen.origin).toBeNull()
    expect(seen.body).toBe('{"payload":1}')
  })

  it('forwards the renderer abort signal so streams do not leak into the Host', async () => {
    const fetch = vi.fn((_target: URL, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return Promise.resolve(new Response('ok', { status: 200 }))
    })
    vi.stubGlobal('fetch', fetch)
    const response = await forwardToPixiesHost(
      new Request('dsh-app://app/api/session/list'), 'http://127.0.0.1:4321/?token=secret', 'session=owned',
    )
    expect(response.status).toBe(200)
  })

  it('builds the desktop boot payload from the real Host origin', () => {
    expect(pixiesBootPayload('http://127.0.0.1:19387/?token=one-shot'))
      .toEqual({ injections: [], streamBaseUrl: 'http://127.0.0.1:19387' })
  })

  it('completes a real loopback POST with a streaming body end to end', async () => {
    const received: string[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address() as AddressInfo
    try {
      const request = new Request('dsh-app://app/api/session/create', { method: 'POST', body: '{"payload":1}' })
      const response = await forwardToPixiesHost(request, `http://127.0.0.1:${String(port)}/`, 'session=owned')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(received).toEqual(['{"payload":1}'])
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
})
