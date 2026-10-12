import { createHash, randomBytes } from 'node:crypto';
import type { ManifestAuth } from './manifest';
import { RequestFailure } from './request';

type OAuth = Extract<ManifestAuth, { type: 'oauth2' }>;

/** What a token endpoint hands back. */
export interface TokenSet {
  accessToken: string;
  /** Missing when the service gives none, or keeps the one it gave before. */
  refreshToken: string | null;
  /** When the access token runs out. Null when the service doesn't say. */
  expiresAt: Date | null;
  scopes: string[];
}

/** A PKCE pair: the verifier stays here, and its challenge goes with the sign-in page. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** The page the user signs in on, in their own browser. */
export function authorizeUrl(
  auth: OAuth,
  input: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const url = new URL(auth.authorize_url);
  for (const [name, value] of Object.entries(auth.extra)) url.searchParams.set(name, value);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (auth.scopes.length > 0) url.searchParams.set('scope', auth.scopes.join(' '));
  return url.toString();
}

/** Swaps the code the sign-in page handed back for tokens. */
export function exchangeCode(
  auth: OAuth,
  input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    verifier: string;
  },
  options: { fetch: typeof fetch; signal: AbortSignal; now?: () => Date },
): Promise<TokenSet> {
  return token(
    auth,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    },
    options,
  );
}

/** Gets a new access token with a refresh token, when the old one has run out. */
export function refreshTokens(
  auth: OAuth,
  input: { clientId: string; clientSecret: string; refreshToken: string },
  options: { fetch: typeof fetch; signal: AbortSignal; now?: () => Date },
): Promise<TokenSet> {
  return token(
    auth,
    {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    },
    options,
  );
}

async function token(
  auth: OAuth,
  form: Record<string, string>,
  options: { fetch: typeof fetch; signal: AbortSignal; now?: () => Date },
): Promise<TokenSet> {
  const host = new URL(auth.token_url).host;
  let response: Response;
  try {
    response = await options.fetch(auth.token_url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'clanks',
      },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new RequestFailure(
      `Couldn't reach ${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Some services answer a failed exchange with a page; the status says enough.
  }
  const accessToken = body.access_token;
  if (!response.ok || typeof accessToken !== 'string' || accessToken === '') {
    const why =
      (typeof body.error_description === 'string' && body.error_description) ||
      (typeof body.error === 'string' && body.error) ||
      `it answered ${response.status}`;
    throw new RequestFailure(`${host} didn't give a token: ${why}`, response.status);
  }
  const expiresIn = Number(body.expires_in);
  const now = options.now?.() ?? new Date();
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(now.getTime() + expiresIn * 1000)
        : null,
    scopes: typeof body.scope === 'string' ? body.scope.split(/[\s,]+/).filter(Boolean) : [],
  };
}
