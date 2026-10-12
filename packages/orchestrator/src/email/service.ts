import {
  EMAIL_PASSWORD,
  type EmailDraft,
  type EmailSettings,
  GMAIL_SMTP,
  type Settings,
  emailConfigured,
  parseAddress,
} from '@clanks/core';
import { createTransport } from 'nodemailer';
import type { SecretStore } from '../secrets';

/** An email problem worded for the user. */
export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailError';
  }
}

/** What goes to the mail server for one email. */
export interface OutgoingEmail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
}

/** A connection to a mail server, as the service uses one. Tests stand one in. */
export interface MailTransport {
  verify(): Promise<void>;
  send(message: OutgoingEmail): Promise<{ messageId: string | null }>;
}

export interface EmailServiceOptions {
  settings: { get(): Settings };
  secrets: SecretStore;
  /** Tests swap the mail server for a stand-in. */
  transport?: (config: SmtpConfig) => MailTransport;
}

/** Where and how to reach the mail server. */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

/** Whether the app can send, as Settings shows it. */
export interface EmailStatus {
  /** There's an account, with its password in the keychain. */
  ready: boolean;
  kind: EmailSettings['kind'];
  /** Who emails come from, as recipients see it. */
  from: string | null;
  /** What's missing, when it isn't ready. */
  problem: string | null;
}

const TIMEOUT_MS = 30_000;

/**
 * Sends the emails the user approves, through their own account: any SMTP server, or Gmail's with
 * an app password. Nothing here is a tool, and no clank can reach it: the board calls it when the
 * user approves an email ticket, with exactly the draft they saw. The password stays in the
 * keychain and goes only to that server.
 */
export class EmailService {
  constructor(private readonly options: EmailServiceOptions) {}

  status(): EmailStatus {
    const email = this.options.settings.get().email;
    if (email.kind === 'none') {
      return { ready: false, kind: 'none', from: null, problem: 'No email account is set up.' };
    }
    const config = this.smtp(email);
    const from = this.from();
    // Gmail's server is known, and signing in to it is with the address.
    if (!emailConfigured({ ...email, host: config.host, user: config.user })) {
      return {
        ready: false,
        kind: email.kind,
        from,
        problem: 'The email account is missing its server, sign-in or address.',
      };
    }
    if (!this.options.secrets.has(EMAIL_PASSWORD)) {
      return {
        ready: false,
        kind: email.kind,
        from,
        problem: "The account's password isn't saved.",
      };
    }
    return { ready: true, kind: email.kind, from, problem: null };
  }

  /** Signs in to the mail server and out again, to check the account works. */
  async test(): Promise<void> {
    const transport = this.transport();
    try {
      await transport.verify();
    } catch (error) {
      throw new EmailError(`The mail server turned it down: ${reason(error)}`);
    }
  }

  /** Sends an email as it's written. Resolves with who it came from and the server's id for it. */
  async send(draft: EmailDraft): Promise<{ from: string; messageId: string | null }> {
    const to = addressList(draft.to);
    const cc = addressList(draft.cc);
    if (to.length === 0) throw new EmailError('Add who the email goes to before sending it.');
    if (!draft.subject.trim()) throw new EmailError('The email has no subject.');
    if (!draft.body.trim()) throw new EmailError('The email has nothing in it.');
    // A header can't hold a line break: one in a subject would start another header.
    const subject = draft.subject.replace(/[\r\n]+/g, ' ').trim();
    const from = this.from()!;
    const transport = this.transport();
    try {
      const sent = await transport.send({ from, to, cc, subject, text: draft.body });
      return { from, messageId: sent.messageId };
    } catch (error) {
      throw new EmailError(`The email didn't go out: ${reason(error)}`);
    }
  }

  /** Who emails come from: the account's address, with the name beside it. */
  private from(): string | null {
    const { email, profile } = this.options.settings.get();
    if (!email.from) return null;
    const name = (email.name || profile.name).replace(/["<>\r\n]/g, '').trim();
    return name ? `"${name}" <${email.from}>` : email.from;
  }

  private smtp(email: EmailSettings): Omit<SmtpConfig, 'password'> {
    return email.kind === 'gmail'
      ? { ...GMAIL_SMTP, user: email.user || email.from }
      : { host: email.host, port: email.port, secure: email.secure, user: email.user };
  }

  private transport(): MailTransport {
    const status = this.status();
    if (!status.ready) {
      throw new EmailError(`${status.problem} Set it up in Settings, under Email.`);
    }
    const config: SmtpConfig = {
      ...this.smtp(this.options.settings.get().email),
      password: this.options.secrets.get(EMAIL_PASSWORD)!,
    };
    return (this.options.transport ?? smtpTransport)(config);
  }
}

/** The addresses that are addresses, as written, without repeats. */
function addressList(values: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const value of values) {
    const parsed = parseAddress(value);
    if (!parsed) throw new EmailError(`"${value}" isn't an email address.`);
    if (seen.has(parsed.address.toLowerCase())) continue;
    seen.add(parsed.address.toLowerCase());
    kept.push(
      parsed.name ? `"${parsed.name.replace(/"/g, '')}" <${parsed.address}>` : parsed.address,
    );
  }
  return kept;
}

function smtpTransport(config: SmtpConfig): MailTransport {
  const transport = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // On a port that starts in the clear, the connection must upgrade before anything is sent.
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  return {
    verify: async () => {
      await transport.verify();
    },
    send: async (message) => {
      const info = (await transport.sendMail({
        from: message.from,
        to: message.to,
        ...(message.cc.length > 0 ? { cc: message.cc } : {}),
        subject: message.subject,
        text: message.text,
      })) as { messageId?: string };
      return { messageId: info.messageId ?? null };
    },
  };
}

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Servers answer in several lines; the first says what's wrong.
  return text.split('\n')[0]!.slice(0, 300);
}
