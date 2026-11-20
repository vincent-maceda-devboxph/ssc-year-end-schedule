import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'bt-home',
  imports: [RouterLink, MatIconModule],
  template: `
    <header class="hero">
      <div class="page">
        <span class="badge"><mat-icon>sports_tennis</mat-icon> Local tournament desk</span>
        <h1>Badminton Tournament</h1>
        <p>Schedules, live scoring and results for your venue. Everything runs on this laptop and your Wi-Fi; no internet needed.</p>
      </div>
    </header>
    <div class="page">
      <div class="tiles">
        <a routerLink="/live" class="tile t1"><span class="ic"><mat-icon>scoreboard</mat-icon></span><strong>Live scores</strong><span class="muted">Follow courts, results, standings and brackets.</span><span class="go">Open <mat-icon>arrow_forward</mat-icon></span></a>
        <a routerLink="/umpire" class="tile t2"><span class="ic"><mat-icon>sports</mat-icon></span><strong>Umpire</strong><span class="muted">Enter your court code and score the match.</span><span class="go">Open <mat-icon>arrow_forward</mat-icon></span></a>
        <a routerLink="/admin" class="tile t3"><span class="ic"><mat-icon>admin_panel_settings</mat-icon></span><strong>Admin</strong><span class="muted">Teams, schedule, courts, results and backups.</span><span class="go">Open <mat-icon>arrow_forward</mat-icon></span></a>
        <a routerLink="/help" class="tile t4"><span class="ic"><mat-icon>menu_book</mat-icon></span><strong>How to use</strong><span class="muted">Step-by-step guide for organisers, umpires and spectators.</span><span class="go">Read <mat-icon>arrow_forward</mat-icon></span></a>
      </div>
    </div>
  `,
  styles: `
    .hero { background: linear-gradient(135deg, #0f766e 0%, #0e7490 55%, #1d4ed8 100%); color: #fff; padding: 48px 0 72px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,255,255,.16); padding: 6px 14px; border-radius: 999px; font-size: 13px; font-weight: 500; }
    .badge mat-icon { font-size: 18px; width: 18px; height: 18px; }
    h1 { font-size: clamp(30px, 6vw, 46px); margin: 16px 0 8px; }
    .hero p { max-width: 560px; margin: 0; font-size: 17px; line-height: 1.5; opacity: .92; }
    .tiles { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-top: -44px; }
    .tile { display: flex; flex-direction: column; gap: 8px; padding: 22px; border-radius: 18px; background: var(--bt-surface);
      border: 1px solid var(--bt-border); box-shadow: var(--bt-shadow); text-decoration: none; color: inherit; }
    .tile strong { font-size: 18px; }
    .ic { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; color: #fff; margin-bottom: 4px; }
    .t1 .ic { background: linear-gradient(135deg, #10b981, #0d9488); }
    .t2 .ic { background: linear-gradient(135deg, #38bdf8, #2563eb); }
    .t3 .ic { background: linear-gradient(135deg, #8b5cf6, #6366f1); }
    .t4 .ic { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    .go { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; color: var(--bt-brand); font-weight: 600; font-size: 14px; }
    .go mat-icon { font-size: 18px; width: 18px; height: 18px; }
  `,
})
export class Home {}
