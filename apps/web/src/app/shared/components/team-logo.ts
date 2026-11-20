import { Component, computed, input } from '@angular/core';

/** A team's logo, or its initials on the team colour when it has none. */
@Component({
  selector: 'bt-team-logo',
  template: `
    @if (team()?.logoUrl; as url) {
      <img [src]="url" [alt]="team()!.name + ' logo'" [style.width.px]="size()" [style.height.px]="size()" />
    } @else {
      <span class="ini" [style.width.px]="size()" [style.height.px]="size()" [style.background]="team()?.color ?? '#e2e8f0'" [style.font-size.px]="size() * 0.42" aria-hidden="true">{{ initials() }}</span>
    }
  `,
  styles: `
    :host { display: inline-flex; flex: none; vertical-align: middle; }
    img { object-fit: contain; border-radius: 22%; background: #fff; border: 1px solid #0001; box-sizing: border-box; }
    .ini { display: inline-grid; place-items: center; border-radius: 22%; font-weight: 800; color: #0f172a; border: 1px solid #0001; box-sizing: border-box; }
  `,
})
export class TeamLogo {
  readonly team = input<{ name: string; color?: string; logoUrl?: string | null } | null | undefined>(null);
  readonly size = input(24);
  readonly initials = computed(() =>
    (this.team()?.name ?? '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join(''),
  );
}
