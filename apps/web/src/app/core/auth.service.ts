import { Injectable, computed, inject, signal } from '@angular/core';
import type { AdminUser, MeResponse, UmpireSession } from '@bt/shared';
import { Api } from './api.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(Api);
  readonly me = signal<MeResponse | null>(null);
  readonly admin = computed<AdminUser | null>(() => this.me()?.admin ?? null);
  readonly umpire = computed<UmpireSession | null>(() => this.me()?.umpire ?? null);
  private loading: Promise<MeResponse> | null = null;

  /** Loads the session once; pass force to re-check (e.g. after a 401). */
  async load(force = false): Promise<MeResponse> {
    if (!force && this.me()) return this.me()!;
    this.loading ??= this.api.get<MeResponse>('/auth/me').finally(() => (this.loading = null));
    const me = await this.loading;
    this.me.set(me);
    return me;
  }

  async loginAdmin(username: string, password: string) {
    await this.api.post('/auth/login', { username, password });
    await this.load(true);
  }

  async logoutAdmin() {
    await this.api.post('/auth/logout');
    await this.load(true);
  }

  async loginUmpire(courtId: string | undefined, code: string, name: string) {
    await this.api.post('/auth/umpire/login', { courtId: courtId || undefined, code, name });
    await this.load(true);
  }

  async logoutUmpire() {
    await this.api.post('/auth/umpire/logout');
    await this.load(true);
  }
}
