import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { TournamentDto } from '@bt/shared';
import { Api, errorMessage } from '../../core/api.service';

@Component({
  selector: 'bt-live-list',
  imports: [RouterLink],
  template: `
    <header class="hero">
      <div class="page">
        <a routerLink="/" class="back">← Home</a>
        <h1>Live scores</h1>
        <p>Pick a tournament to follow.</p>
      </div>
    </header>
    <div class="page body">
      @if (error()) { <p class="error-text">{{ error() }}</p> }
      @for (t of tournaments(); track t.id) {
        <a class="item" [routerLink]="['/live', t.id]">
          <span class="ic">🏸</span>
          <span class="txt"><strong>{{ t.name }}</strong><span class="muted small">{{ t.date }} {{ t.venue ? '· ' + t.venue : '' }}</span></span>
          @if (t.status === 'completed') { <span class="chip completed">Finished</span> } @else { <span class="chip live">Live</span> }
        </a>
      } @empty {
        @if (!loading()) { <p class="muted">No tournament is live right now.</p> }
      }
    </div>
  `,
  styles: `
    .hero { background: linear-gradient(135deg, #0f766e 0%, #0e7490 55%, #1d4ed8 100%); color: #fff; padding: 20px 0 48px; }
    .hero h1 { margin: 10px 0 2px; font-size: clamp(28px, 6vw, 40px); }
    .hero p { margin: 0; opacity: .9; }
    .back { color: rgba(255,255,255,.85); text-decoration: none; font-size: 13px; }
    .body { margin-top: -28px; display: grid; gap: 12px; }
    .item { display: flex; align-items: center; gap: 14px; text-decoration: none; color: inherit; background: #fff; border: 1px solid var(--bt-border);
      border-radius: 18px; padding: 16px; box-shadow: var(--bt-shadow); transition: transform .15s, box-shadow .15s; }
    .item:hover { transform: translateY(-2px); box-shadow: var(--bt-shadow-hover); }
    .ic { font-size: 28px; }
    .txt { flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .txt strong { font-size: 18px; }
  `,
})
export class LiveList {
  private readonly api = inject(Api);
  readonly tournaments = signal<TournamentDto[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');

  constructor() {
    this.api
      .get<TournamentDto[]>('/tournaments')
      .then((t) => this.tournaments.set(t))
      .catch((e) => this.error.set(errorMessage(e)))
      .finally(() => this.loading.set(false));
  }
}
