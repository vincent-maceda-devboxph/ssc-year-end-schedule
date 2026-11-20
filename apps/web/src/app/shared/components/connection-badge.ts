import { Component, inject } from '@angular/core';
import { Realtime } from '../../core/realtime.service';

@Component({
  selector: 'bt-connection',
  template: `
    <span class="conn" [class.off]="!rt.connected()" role="status">
      <span class="dot"></span>{{ rt.connected() ? 'Live' : 'Offline – reconnecting…' }}
    </span>
  `,
  styles: `
    .conn { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--bt-ok); }
    .conn.off { color: #b71c1c; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  `,
})
export class ConnectionBadge {
  readonly rt = inject(Realtime);
}
