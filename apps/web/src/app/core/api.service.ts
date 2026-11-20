import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ApiError } from '@bt/shared';

/** Thin promise-based wrapper around HttpClient for the same-origin /api. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    const clean = Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
    return firstValueFrom(this.http.get<T>(`/api${path}`, { params: clean }));
  }
  post<T>(path: string, body: unknown = {}): Promise<T> {
    return firstValueFrom(this.http.post<T>(`/api${path}`, body));
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return firstValueFrom(this.http.put<T>(`/api${path}`, body));
  }
  /** Send a file as the raw request body (CSV / Excel import). */
  upload<T>(path: string, file: File): Promise<T> {
    return firstValueFrom(this.http.post<T>(`/api${path}`, file, { headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) } }));
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return firstValueFrom(this.http.patch<T>(`/api${path}`, body));
  }
  delete(path: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(`/api${path}`));
  }
}

/** Parsed error body, or null for network failures (server unreachable). */
export function apiError(e: unknown): (ApiError & { status: number }) | null {
  if (e instanceof HttpErrorResponse && e.status > 0 && e.error?.error) return { ...(e.error as ApiError), status: e.status };
  return null;
}

export function errorMessage(e: unknown): string {
  const err = apiError(e);
  if (err) {
    const details = Array.isArray(err.error.details)
      ? ': ' + (err.error.details as { path: string; message: string }[]).map((d) => `${d.path} ${d.message}`).join('; ')
      : '';
    return err.error.message + details;
  }
  if (e instanceof HttpErrorResponse && e.status === 0) return 'Cannot reach the server. Check the Wi-Fi connection.';
  return 'Something went wrong';
}
