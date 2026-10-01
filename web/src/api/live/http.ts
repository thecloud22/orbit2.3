/**
 * A small typed client for the Claims API (api/openapi.yaml).
 *
 *  - every call goes to API_BASE (in dev the Vite proxy strips `/api` and forwards to the backend; the API has no CORS)
 *  - the ETag of every response is remembered by URL, and `ifMatch` sends one back: state-changing calls need it (412 stale, 428 missing)
 *  - POSTs that create something take an Idempotency-Key
 *  - errors are application/problem+json, surfaced as an ApiError with the stable `code` and the human `detail`
 *  - a caller can pass an AbortSignal (useQuery aborts on unmount and when its inputs change)
 */
import { API_BASE } from './config'

export interface FieldError { field: string; message: string }

export class ApiError extends Error {
  /** HTTP status; 0 when the API could not be reached at all. */
  status: number
  /** The API's stable machine-readable code (`validation_failed`, `version_conflict`, ...); `network_error` when unreachable. */
  code: string
  title: string
  detail: string | undefined
  /** Field-level problems of a 422 `validation_failed`. */
  errors: FieldError[]

  constructor(status: number, code: string, title: string, detail: string | undefined, errors: FieldError[] = []) {
    super(detail ? `${detail} (${code})` : `${title} (${code})`)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.title = title
    this.detail = detail
    this.errors = errors
  }
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

export interface Reply<T> {
  data: T
  status: number
  /** The response's ETag, quoted, exactly as the server sent it. */
  etag: string | undefined
  /** True when an Idempotency-Key was replayed: the server returned the resource the first call created. */
  replayed: boolean
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>
  body?: unknown
  ifMatch?: string
  idempotencyKey?: string
  signal?: AbortSignal
}

let actor: string | undefined
/** Development placeholder for authentication: the API records this on history events (X-Actor). */
export function setActor(name: string | undefined): void {
  actor = name
}

const etags = new Map<string, string>()
/** The last ETag seen for a resource path (for example `/requirements/{id}`). */
export function knownEtag(path: string): string | undefined {
  return etags.get(path)
}

/** A quoted ETag for a resource whose `version` we hold. The API uses the version as its ETag (`"3"`). */
export function etagOf(version: number): string {
  return `"${version}"`
}

export async function api<T>(method: 'GET' | 'POST', path: string, opts: RequestOptions = {}): Promise<Reply<T>> {
  const qs = opts.query
    ? Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
    : ''
  const url = `${API_BASE}${path}${qs ? `?${qs}` : ''}`
  const headers: Record<string, string> = { Accept: 'application/json, application/problem+json' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  if (actor && method !== 'GET') headers['X-Actor'] = actor

  let res: Response
  try {
    res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal })
  } catch (e) {
    if (isAbort(e)) throw e
    throw new ApiError(0, 'network_error', 'The claims API is not reachable', `Can't reach the claims API at ${API_BASE || '/'}. Is the backend running?`)
  }

  const text = await res.text()
  let json: unknown
  if (text) {
    try { json = JSON.parse(text) } catch { json = undefined }
  }
  if (!res.ok) {
    const p = (json ?? {}) as { code?: string; title?: string; detail?: string; errors?: FieldError[] }
    throw new ApiError(
      res.status,
      p.code ?? `http_${res.status}`,
      p.title ?? res.statusText ?? 'Request failed',
      p.detail ?? (json === undefined && text ? text.slice(0, 200) : undefined),
      p.errors ?? [],
    )
  }
  const etag = res.headers.get('ETag') ?? undefined
  if (etag) etags.set(path, etag)
  return { data: json as T, status: res.status, etag, replayed: res.headers.get('Idempotent-Replayed') === 'true' }
}

export const get = <T>(path: string, opts?: RequestOptions) => api<T>('GET', path, opts).then((r) => r.data)

/** Every page of a `{items, nextCursor}` collection, up to `maxPages`. */
export async function getAll<T>(path: string, query: Record<string, string | number | undefined> = {}, signal?: AbortSignal, maxPages = 6): Promise<T[]> {
  const out: T[] = []
  let cursor: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const page = await get<{ items: T[]; nextCursor: string | null }>(path, { query: { ...query, cursor }, signal })
    out.push(...page.items)
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  return out
}

/** The signal of the query that is running right now (set by useQuery), so a live call can be aborted when the screen goes away. */
let ambient: AbortSignal | undefined
export function withAmbientSignal<T>(signal: AbortSignal, fn: () => T): T {
  ambient = signal
  try { return fn() } finally { ambient = undefined }
}
export function ambientSignal(): AbortSignal | undefined {
  return ambient
}
