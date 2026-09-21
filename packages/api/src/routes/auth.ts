import { Hono } from 'hono';
import type { ApiEnv } from '../ports';
import { createSession, destroySession } from '../sessions';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

const OAUTH_STATE_COOKIE = 'codra_oauth_state';
const OAUTH_STATE_TTL_SECONDS = 60 * 10;

function stateMatchesCookie(state: string, cookieState: string) {
  if (state.length !== cookieState.length) return false;
  let difference = 0;
  for (let index = 0; index < state.length; index += 1) {
    difference |= state.charCodeAt(index) ^ cookieState.charCodeAt(index);
  }
  return difference === 0;
}

function clearOAuthStateCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, OAUTH_STATE_COOKIE, {
    path: '/auth/github/callback',
    secure: true,
    sameSite: 'Lax',
  });
}

function redirectToLogin(reason: string) {
  const params = new URLSearchParams({ error: reason });
  return `/login?${params.toString()}`;
}

export function parseAllowedUsers(input: string) {
  return new Set(
    input
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function createAuthRouter() {
  const app = new Hono<ApiEnv>();

  app.get('/github', async (c) => {
    const state = await c.env.deps.authProvider.createOAuthState();
    const result = await c.env.deps.authProvider.beginAuthorization(c.env.AUTH_CALLBACK_URL, state);
    setCookie(c, OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/auth/github/callback',
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
    return c.redirect(result.url, 302);
  });

  app.get('/github/callback', async (c) => {
    const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
    clearOAuthStateCookie(c);
    const error = c.req.query('error');
    if (error) {
      return c.redirect(redirectToLogin(error), 302);
    }

    const code = c.req.query('code')?.trim();
    const state = c.req.query('state')?.trim();
    if (!state || !cookieState || !stateMatchesCookie(state, cookieState)) {
      return c.redirect(redirectToLogin('invalid_state'), 302);
    }
    if (!code) {
      return c.redirect(redirectToLogin('invalid_callback'), 302);
    }

    const stateMatches = await c.env.deps.authProvider.consumeOAuthState(state);
    if (!stateMatches) {
      return c.redirect(redirectToLogin('invalid_state'), 302);
    }

    try {
      const { identity } = await c.env.deps.authProvider.completeAuthorization(code, state, state);
      const allowedUsers = parseAllowedUsers(c.env.DASHBOARD_ALLOWED_USERS);

      if (!allowedUsers.has(identity.login.toLowerCase())) {
        return c.redirect(redirectToLogin('not_allowed'), 302);
      }

      await destroySession(c);
      await createSession(c, identity);

      // Best-effort: a DB hiccup must not block sign-in (the account page self-heals on next load).
      try {
        await c.env.deps.repositories.accounts.upsertAccountSettings(c.env as any, {
          githubUserId: Number(identity.providerUserId),
          githubUsername: identity.login,
          accountName: identity.name,
          accountEmail: identity.email,
        });
      } catch (err) {
        c.env.deps.platform.logger.warn('Failed to persist account settings on sign-in', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return c.redirect('/dashboard', 302);
    } catch {
      return c.redirect(redirectToLogin('oauth_failed'), 302);
    }
  });

  app.post('/logout', async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  });

  return app;
}
