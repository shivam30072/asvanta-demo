/**
 * Client for the AsvantaTech gateway (docs/pacs-integration.md).
 *
 * Live mode is on when the app is built with VITE_API_URL. Without it the app is
 * the self-contained demo and nothing here is called.
 */

export const API_URL = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '')
export const isLive = Boolean(API_URL)

const TOKEN_KEY = 'asvanta.token'
let token = null
try {
  token = sessionStorage.getItem(TOKEN_KEY)
} catch {
  /* storage unavailable: stay signed out between reloads */
}

export const getToken = () => token
export function setToken(t) {
  token = t
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** JSON request to the gateway. `auth` overrides the signed-in token (share links). */
export async function api(path, { method = 'GET', body, auth } = {}) {
  const headers = { Accept: 'application/json' }
  const bearer = auth === undefined ? token : auth
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_URL}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const detail = data?.detail
    const message =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((d) => d.msg).join('; ')
          : detail?.message || `Request failed (${res.status})`
    throw new ApiError(res.status, message, data)
  }
  return data
}

/** Raw fetch (binary / multipart) to a gateway path, with a bearer token. */
export async function apiRaw(path, { accept, auth } = {}) {
  const headers = {}
  if (accept) headers.Accept = accept
  const bearer = auth === undefined ? token : auth
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  const res = await fetch(`${API_URL}/api${path}`, { headers })
  if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`)
  return res
}
