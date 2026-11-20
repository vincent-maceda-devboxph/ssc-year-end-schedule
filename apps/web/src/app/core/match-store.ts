import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { isFinal, isLive, type MatchDto } from '@bt/shared';
import { Api } from './api.service';
import { Realtime } from './realtime.service';

/**
 * Live list of a tournament's matches. Provide it per component (providers: [MatchStore]).
 * Socket updates are applied only if newer than what we hold (by version), so out-of-order
 * events and refetch/broadcast races cannot roll the score back.
 */
@Injectable()
export class MatchStore {
  private readonly api = inject(Api);
  private readonly rt = inject(Realtime);
  private readonly destroyRef = inject(DestroyRef);

  private readonly byId = signal(new Map<string, MatchDto>());
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  private tournamentId = '';

  readonly all = computed(() => [...this.byId().values()].sort((a, b) => a.matchNumber - b.matchNumber));
  readonly live = computed(() => this.all().filter((m) => isLive(m.status)));
  readonly upcoming = computed(() =>
    this.all()
      .filter((m) => m.status === 'scheduled' || m.status === 'ready' || m.status === 'called')
      .sort((a, b) => (a.courtName ?? '').localeCompare(b.courtName ?? '', undefined, { numeric: true }) || a.queuePosition - b.queuePosition),
  );
  readonly unassigned = computed(() => this.all().filter((m) => m.status === 'pending'));
  readonly finished = computed(() =>
    this.all()
      .filter((m) => isFinal(m.status))
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
  );

  /** Live match per court, else next queued. */
  byCourt(courtId: string) {
    const list = this.all().filter((m) => m.courtId === courtId && !isFinal(m.status));
    const live = list.find((m) => isLive(m.status));
    const queued = list.filter((m) => m !== live && m.status !== 'pending').sort((a, b) => a.queuePosition - b.queuePosition);
    const called = queued.find((m) => m.status === 'called');
    const current = live ?? called ?? queued[0] ?? null;
    return { current, next: queued.filter((m) => m !== current) };
  }

  connect(tournamentId: string) {
    this.tournamentId = tournamentId;
    this.rt.watch(`tournament:${tournamentId}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
    this.rt.match$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ match }) => {
      if (match.tournamentId === tournamentId) this.upsert(match);
    });
    this.rt.matchDeleted$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(({ id }) => {
      const next = new Map(this.byId());
      next.delete(id);
      this.byId.set(next);
    });
    this.rt.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.refresh());
    // Bulk changes (generation, regeneration) arrive as one notice instead of many match events.
    this.rt.tournamentEvent$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.event === 'schedule:updated' && e.tournamentId === tournamentId) void this.refresh();
    });
    return this.refresh();
  }

  async refresh() {
    try {
      const list = await this.api.get<MatchDto[]>('/matches', { tournamentId: this.tournamentId });
      const next = new Map<string, MatchDto>();
      for (const m of list) {
        const held = this.byId().get(m.id);
        next.set(m.id, held && held.version > m.version ? held : m);
      }
      this.byId.set(next);
      this.error.set(null);
    } catch {
      this.error.set('Could not load matches');
    } finally {
      this.loading.set(false);
    }
  }

  upsert(m: MatchDto) {
    const held = this.byId().get(m.id);
    if (held && held.version >= m.version) return;
    const next = new Map(this.byId());
    next.set(m.id, m);
    this.byId.set(next);
  }
}
