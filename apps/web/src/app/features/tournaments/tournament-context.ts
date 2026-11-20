import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  bracketLabel,
  courtStatus,
  type CourtStatus,
  type CategoryDto,
  type CourtDto,
  type EntryDto,
  type PlayerDto,
  type TeamDto,
  type TournamentDto,
  type UmpirePresence,
} from '@bt/shared';
import { Api } from '../../core/api.service';
import { MatchStore } from '../../core/match-store';
import { Realtime } from '../../core/realtime.service';

export type AdminCourt = CourtDto & { umpire?: UmpirePresence };

/** Shared state for the admin tournament screen and its tabs. Provided by TournamentDetail. */
@Injectable()
export class TournamentContext {
  private readonly api = inject(Api);
  private readonly rt = inject(Realtime);
  private readonly destroyRef = inject(DestroyRef);
  readonly matches = inject(MatchStore);

  readonly id = signal('');
  readonly tournament = signal<TournamentDto | null>(null);
  readonly categories = signal<CategoryDto[]>([]);
  readonly courts = signal<AdminCourt[]>([]);
  readonly players = signal<PlayerDto[]>([]);
  readonly entries = signal<EntryDto[]>([]);
  readonly teams = signal<TeamDto[]>([]);

  async init(id: string) {
    this.id.set(id);
    this.rt.tournamentEvent$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (e.event === 'court:updated' && e.tournamentId === id) void this.loadCourts();
    });
    this.rt.presence$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) =>
      this.courts.update((cs) => cs.map((c) => (c.id === p.courtId ? { ...c, umpire: p } : c))),
    );
    await Promise.all([
      this.loadTournament(),
      this.loadCategories(),
      this.loadCourts(),
      this.loadPlayers(),
      this.loadEntries(),
      this.loadTeams(),
      this.matches.connect(id),
    ]);
  }

  async loadTournament() {
    this.tournament.set(await this.api.get<TournamentDto>(`/tournaments/${this.id()}`));
  }
  async loadCategories() {
    this.categories.set(await this.api.get<CategoryDto[]>('/categories', { tournamentId: this.id() }));
  }
  async loadCourts() {
    this.courts.set(await this.api.get<AdminCourt[]>('/courts', { tournamentId: this.id() }));
  }
  async loadPlayers() {
    this.players.set(await this.api.get<PlayerDto[]>('/players', { tournamentId: this.id() }));
  }
  async loadEntries() {
    this.entries.set(await this.api.get<EntryDto[]>('/entries', { tournamentId: this.id() }));
  }

  async loadTeams() {
    this.teams.set(await this.api.get<TeamDto[]>(`/tournaments/${this.id()}/teams`));
  }
  /** Reload everything a lineup import can touch. */
  async reloadRoster() {
    await Promise.all([this.loadTeams(), this.loadCategories(), this.loadPlayers(), this.loadEntries()]);
  }
  team(id: string | null) {
    return id ? this.teams().find((t) => t.id === id) ?? null : null;
  }

  /** Live status of a court from the matches on it. */
  courtStatusOf(c: { id: string; active: boolean }): CourtStatus {
    return courtStatus(c.active, this.matches.all().filter((m) => m.courtId === c.id && m.status !== 'cancelled').map((m) => m.status));
  }

  /** "MD-A" for the first pair of a team in Men's Doubles. */
  levelLabel(e: EntryDto): string {
    const c = this.categories().find((x) => x.id === e.categoryId);
    return e.rank ? bracketLabel(c?.code ?? '', c?.name ?? '', e.rank) : '';
  }

  categoryName(id: string) {
    return this.categories().find((c) => c.id === id)?.name ?? '';
  }
  playerName(id: string) {
    const p = this.players().find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : '?';
  }
}
