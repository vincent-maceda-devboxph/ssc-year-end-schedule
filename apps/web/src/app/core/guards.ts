import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

export const adminGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  try {
    const me = await auth.load();
    if (me.admin) return true;
  } catch {
    /* fall through to login */
  }
  return router.createUrlTree(['/admin/login'], { queryParams: { next: state.url } });
};
