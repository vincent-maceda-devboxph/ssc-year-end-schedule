import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';

interface Section {
  id: 'organiser' | 'matchday' | 'umpire' | 'spectator';
  title: string;
  icon: string;
  intro: string;
  steps: { title: string; text: string }[];
}

const SECTIONS: Section[] = [
  {
    id: 'organiser',
    title: 'Organiser: set up',
    icon: 'admin_panel_settings',
    intro: 'Do this once before the event, on the laptop that runs the server.',
    steps: [
      { title: 'Start the server and join the Wi-Fi', text: 'Run start-server.cmd. It prints the address to share. Phones must be on the same Wi-Fi. If they cannot connect, run "npm run doctor".' },
      { title: 'Sign in', text: 'Open /admin and sign in. The first-run password is printed in the server window.' },
      { title: 'Create the tournament', text: 'Tournaments → New. Set name, venue and status Active.' },
      { title: 'Add courts', text: 'Courts tab. Add one per court. Each court gets a 6-digit umpire code; give it to that court\'s umpire.' },
      { title: 'Import teams and lineups', text: 'Teams & lineup tab. Load a CSV/Excel file with Team, Division, Player 1, Player 2. Row order is the pair rank: first pair is A, then B. Leave Player 2 empty for singles. Click Check, fix problems, then Import.' },
      { title: 'Review divisions', text: 'Divisions tab: scoring rules and priority (a lower number is scheduled earlier).' },
      { title: 'Generate matches', text: 'Matches tab → Generate. Every team plays every other team; same-rank pairs meet; one team point per match won.' },
      { title: 'Plan the day', text: 'Schedule tab. Set start time, match duration, rest and courts, click Preview schedule, then Save and Publish.' },
      { title: 'Groups and knockout (optional)', text: 'Groups & knockout tab. Split a division into groups, play them, then add a knockout and Generate bracket.' },
      { title: 'Back up', text: 'System page → Create backup. Set a mirror folder (a USB stick) for a second copy.' },
    ],
  },
  {
    id: 'matchday',
    title: 'Organiser: match day',
    icon: 'event_available',
    intro: 'Run the day from the admin pages.',
    steps: [
      { title: 'Watch the Live tab', text: 'Every court, the match in progress and the one next.' },
      { title: 'Adjust the schedule', text: 'Drag a match to another court or time; drop on another match to swap. The padlock locks a match; the megaphone calls it to its court.' },
      { title: 'Delays', text: 'Enter the new earliest time and Reschedule. Matches in progress, called or finished do not move.' },
      { title: 'Find things', text: 'Use the List layout and the filters to find a player, pair, team or level such as MD-A. Export to Excel or Print for the court sheets.' },
      { title: 'Fix a result', text: 'Matches tab → Correct result. A reason is required and the change is logged.' },
      { title: 'Standings and reports', text: 'Standings update live. The Reports tab prints or exports results.' },
    ],
  },
  {
    id: 'umpire',
    title: 'Umpire',
    icon: 'sports',
    intro: 'On your phone, at your court.',
    steps: [
      { title: 'Sign in', text: 'Open Umpire. Choose the tournament and your court, type your name and the 6-digit court code, tap Start umpiring.' },
      { title: 'Start the match', text: 'Tap Start match. Tap the side that wins each rally; the app handles serving, interval, changing ends and the decider.' },
      { title: 'Mistakes', text: 'Undo last point. A repeated tap is ignored, so a slow connection is safe.' },
      { title: 'Stoppages', text: 'Pause match / Resume. "Swap sides on screen" matches where you sit.' },
      { title: 'Finish', text: 'Tap Submit result. The next match on your court appears as Next match.' },
    ],
  },
  {
    id: 'spectator',
    title: 'Spectator',
    icon: 'scoreboard',
    intro: 'No sign-in needed.',
    steps: [
      { title: 'Open the live page', text: 'Scan the QR code from the System page, or open /live and pick the tournament.' },
      { title: 'Follow the action', text: 'Courts (live scores), Upcoming, Results, Standings and Brackets. Undecided knockout sides show TBD.' },
      { title: 'Big screen', text: 'Open /board/<tournament id> on a TV for a large live scoreboard.' },
    ],
  },
];

@Component({
  selector: 'bt-help',
  imports: [RouterLink, MatIconModule],
  template: `
    <header class="hero">
      <div class="page">
        <a routerLink="/" class="back"><mat-icon>arrow_back</mat-icon> Home</a>
        <h1>How to use the app</h1>
        <p>Pick your role for step-by-step instructions.</p>
      </div>
    </header>
    <div class="page body">
      <div class="roles" role="tablist">
        @for (s of sections; track s.id) {
          <button type="button" role="tab" class="role" [class.on]="s.id === active()" [attr.aria-selected]="s.id === active()" (click)="active.set(s.id)">
            <mat-icon>{{ s.icon }}</mat-icon> {{ s.title }}
          </button>
        }
      </div>
      @for (s of sections; track s.id) {
        @if (s.id === active()) {
          <section class="panel">
            <h2>{{ s.title }}</h2>
            <p class="muted">{{ s.intro }}</p>
            <ol class="steps">
              @for (st of s.steps; track st.title) {
                <li><div><strong>{{ st.title }}</strong><span>{{ st.text }}</span></div></li>
              }
            </ol>
          </section>
        }
      }
    </div>
  `,
  styles: `
    .hero { background: linear-gradient(135deg, #0f766e, #0e7490 55%, #1d4ed8); color: #fff; padding: 28px 0 56px; }
    .hero h1 { margin: 12px 0 4px; font-size: clamp(26px, 5vw, 38px); }
    .hero p { margin: 0; opacity: .9; }
    .back { color: #fff; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; font-size: 14px; opacity: .9; }
    .body { margin-top: -32px; }
    .roles { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    .role { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--bt-border); background: #fff; color: var(--bt-ink); font: inherit;
      font-weight: 600; padding: 10px 16px; border-radius: 999px; cursor: pointer; box-shadow: var(--bt-shadow); }
    .role.on { background: var(--bt-brand); border-color: var(--bt-brand); color: #fff; }
    .role mat-icon { font-size: 20px; width: 20px; height: 20px; }
    h2 { margin: 0 0 4px; }
    .steps { list-style: none; counter-reset: s; margin: 16px 0 0; padding: 0; display: grid; gap: 12px; }
    .steps li { counter-increment: s; display: flex; gap: 14px; align-items: flex-start; }
    .steps li::before { content: counter(s); flex: none; width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
      background: #ccfbf1; color: #115e59; font-weight: 700; }
    .steps div { display: flex; flex-direction: column; gap: 2px; padding-top: 3px; }
    .steps span { color: var(--bt-muted); line-height: 1.5; }
  `,
})
export class Help {
  readonly sections = SECTIONS;
  readonly active = signal<Section['id']>('organiser');
}
