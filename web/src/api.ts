import type {
  ApiErrorBody,
  OwnerDrop,
  PublicDrop,
  SessionUser,
  UploadSettings,
} from './types.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly body: ApiErrorBody | null

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.message || `Request failed (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.code = body?.error
    this.body = body
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...options })

  if (res.status === 204) return null as T

  const body = (await res.json().catch(() => null)) as T | ApiErrorBody | null
  if (!res.ok) throw new ApiError(res.status, body as ApiErrorBody | null)
  return body as T
}

export type ProgressHandler = (fraction: number) => void

export const api = {
  config: () => request<UploadSettings>('/api/config'),

  me: () => request<SessionUser>('/api/me'),

  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  listUploads: () => request<OwnerDrop[]>('/api/uploads'),

  deleteUpload: (id: string) => request<null>(`/api/uploads/${id}`, { method: 'DELETE' }),

  drop: (id: string) => request<PublicDrop>(`/api/drops/${id}`),

  /**
   * XHR rather than fetch: upload progress has no fetch equivalent, and a
   * progress bar is the whole point of a drag-and-drop surface.
   */
  upload(file: File, ttlSeconds: number, onProgress?: ProgressHandler): Promise<OwnerDrop> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file, file.name)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/uploads?ttl=${encodeURIComponent(ttlSeconds)}`)
      xhr.withCredentials = true

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress?.(event.loaded / event.total)
      })

      xhr.addEventListener('load', () => {
        let body: unknown = null
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          /* non-JSON error page */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as OwnerDrop)
        else reject(new ApiError(xhr.status, body as ApiErrorBody | null))
      })

      xhr.addEventListener('error', () => reject(new ApiError(0, { message: 'Network error.' })))
      xhr.addEventListener('abort', () => reject(new ApiError(0, { message: 'Upload cancelled.' })))

      xhr.send(form)
    })
  },
}
