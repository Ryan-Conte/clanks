import { EMAIL_PASSWORD, type EmailSettings, GMAIL_SMTP } from '@clanks/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useTRPC } from '../../lib/trpc';
import { Button, Dot, ErrorText, Panel, Switch, inputClass } from '../ui';

const APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords';

/**
 * The account emails go out through, once the user approves them: any SMTP server, or Gmail's with
 * an app password. Only the app sends, only what was approved, and the password stays in the
 * keychain.
 */
export function EmailPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const settings = useQuery(trpc.settings.get.queryOptions());
  const status = useQuery(trpc.email.status.queryOptions());
  const secrets = useQuery(trpc.secrets.status.queryOptions());
  const password0 = useQuery(trpc.secrets.has.queryOptions(EMAIL_PASSWORD));
  const [draft, setDraft] = useState<EmailSettings | null>(null);
  const [password, setPassword] = useState('');
  const [tested, setTested] = useState(false);
  const saved = settings.data?.email;

  const refresh = () => {
    // What the server said was about the account as it was.
    setTested(false);
    void queryClient.invalidateQueries({ queryKey: trpc.email.status.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.secrets.has.queryKey(EMAIL_PASSWORD) });
  };
  const update = useMutation(
    trpc.settings.update.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(trpc.settings.get.queryKey(), next);
        setDraft(null);
        refresh();
      },
    }),
  );
  const savePassword = useMutation(
    trpc.secrets.set.mutationOptions({
      onSuccess: () => {
        setPassword('');
        refresh();
      },
    }),
  );
  const removePassword = useMutation(trpc.secrets.delete.mutationOptions({ onSuccess: refresh }));
  const test = useMutation(trpc.email.test.mutationOptions({ onSuccess: () => setTested(true) }));
  if (!saved) return null;
  const email = draft ?? saved;
  const set = (patch: Partial<EmailSettings>) => setDraft({ ...email, ...patch });
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const keychain = secrets.data?.available ?? false;
  const hasPassword = password0.data === true;
  const error = update.error ?? savePassword.error ?? removePassword.error;

  return (
    <Panel
      title="Email"
      description="For emails the crew drafts. Nothing is sent until you approve it on its ticket, and then it goes from this account exactly as written. Clanks have no way to send anything themselves."
      actions={
        status.data?.ready ? (
          <span className="flex items-center gap-2 text-[13px] text-dim">
            <Dot tone="mint" /> Ready
          </span>
        ) : undefined
      }
    >
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ['none', 'No account', 'Emails are approved without sending. Send them yourself.'],
            ['gmail', 'Gmail', 'Your Gmail or Google Workspace address, with an app password.'],
            ['smtp', 'SMTP', 'Any mail server: Fastmail, Outlook, your own.'],
          ] as const
        ).map(([kind, title, hint]) => (
          <button
            key={kind}
            type="button"
            aria-pressed={email.kind === kind}
            onClick={() =>
              set({
                kind,
                ...(kind === 'gmail' ? GMAIL_SMTP : {}),
                ...(kind === 'smtp' && email.kind === 'gmail'
                  ? { host: '', port: 587, secure: false }
                  : {}),
              })
            }
            className={`flex flex-col gap-1 rounded-2xl border p-3.5 text-left transition-colors ${email.kind === kind ? 'border-accent/50 bg-accent/[0.08]' : 'border-line hover:bg-white/[0.03]'}`}
          >
            <span className="text-sm font-medium">{title}</span>
            <span className="text-[12px] leading-snug text-white/60">{hint}</span>
          </button>
        ))}
      </div>

      {email.kind !== 'none' && (
        <div className="flex flex-col gap-3">
          <Field label="Your address" hint="Emails come from it.">
            <input
              aria-label="Your email address"
              placeholder="sam@example.com"
              className={`${inputClass} w-80`}
              value={email.from}
              onChange={(e) =>
                set({
                  from: e.target.value,
                  // Signing in is with the address, unless the user says otherwise.
                  ...(email.user === '' || email.user === email.from
                    ? { user: e.target.value }
                    : {}),
                })
              }
            />
          </Field>
          <Field label="Your name" hint="Shown beside it. Empty uses your profile's.">
            <input
              aria-label="Name emails come from"
              className={`${inputClass} w-80`}
              value={email.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          {email.kind === 'smtp' && (
            <>
              <Field label="Server" hint="Its name and port, as your mail provider gives them.">
                <span className="flex w-80 gap-2">
                  <input
                    aria-label="SMTP server"
                    placeholder="smtp.example.com"
                    className={`${inputClass} min-w-0 flex-1 font-mono`}
                    value={email.host}
                    onChange={(e) => set({ host: e.target.value.trim() })}
                  />
                  <input
                    type="number"
                    aria-label="Port"
                    className={`${inputClass} w-24 font-mono`}
                    value={email.port}
                    onChange={(e) => {
                      const port = Number(e.target.value);
                      set({ port, secure: port === 465 });
                    }}
                  />
                </span>
              </Field>
              <Field
                label="Encrypted from the start"
                hint="On for port 465. Off, the connection must upgrade with STARTTLS before anything is sent."
              >
                <Switch
                  checked={email.secure}
                  onChange={(secure) => set({ secure })}
                  label="Encrypted from the start"
                />
              </Field>
              <Field label="Sign in as" hint="Usually your address.">
                <input
                  aria-label="SMTP user"
                  className={`${inputClass} w-80`}
                  value={email.user}
                  onChange={(e) => set({ user: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field
            label={email.kind === 'gmail' ? 'App password' : 'Password'}
            hint={
              email.kind === 'gmail' ? (
                <>
                  Not your Google password:{' '}
                  <a
                    href={APP_PASSWORDS_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent hover:underline"
                  >
                    make an app password
                  </a>{' '}
                  for clanks. It needs 2-step verification on the account.
                </>
              ) : (
                'Kept in your keychain, and sent only to that server.'
              )
            }
          >
            {hasPassword ? (
              <span className="flex w-80 items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2">
                  <Dot tone="mint" /> Saved
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removePassword.mutate(EMAIL_PASSWORD)}
                >
                  Remove
                </Button>
              </span>
            ) : (
              <form
                className="flex w-80 gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  // Google shows app passwords in groups of four, with spaces that aren't part of them.
                  const value = email.kind === 'gmail' ? password.replace(/\s+/g, '') : password;
                  savePassword.mutate({ ref: EMAIL_PASSWORD, value });
                }}
              >
                <input
                  type="password"
                  aria-label="Email password"
                  autoComplete="off"
                  disabled={!keychain}
                  placeholder={keychain ? '' : 'No keychain, so it can’t be saved'}
                  className={`${inputClass} min-w-0 flex-1 font-mono`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button type="submit" disabled={!keychain || !password || savePassword.isPending}>
                  Save
                </Button>
              </form>
            )}
          </Field>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {dirty && (
          <>
            <Button
              variant="primary"
              disabled={update.isPending}
              onClick={() => update.mutate({ email: { ...email, port: email.port || 587 } })}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Discard changes
            </Button>
          </>
        )}
        {!dirty && status.data?.ready && (
          <Button disabled={test.isPending} onClick={() => test.mutate()}>
            {test.isPending ? 'Signing in…' : 'Check it works'}
          </Button>
        )}
        {tested && !test.isPending && (
          <span className="flex items-center gap-2 text-[13px] text-accent-2">
            <Dot tone="mint" /> The server took the sign-in.
          </span>
        )}
        {!dirty && email.kind !== 'none' && !status.data?.ready && status.data?.problem && (
          <span className="text-[13px] text-dim">{status.data.problem}</span>
        )}
      </div>
      {test.error && <ErrorText>{test.error.message}</ErrorText>}
      {error && <ErrorText>{error.message}</ErrorText>}
    </Panel>
  );
}

function Field({ label, hint, children }: { label: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-[13px] text-dim">{hint}</span>
      </span>
      {children}
    </div>
  );
}
