import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Env } from "@rephoto/contracts";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPPool from "nodemailer/lib/smtp-pool";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function createMailer(env: Env): Mailer {
  if (env.MAIL_TRANSPORT === "ses") return createSesMailer(env);
  return createSmtpMailer(env);
}

/** Options handed to nodemailer for the SMTP transport, derived from the env. */
export type SmtpTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  requireTLS?: boolean;
  ignoreTLS?: boolean;
  connectionTimeout: number;
  socketTimeout: number;
  pool: true;
  maxConnections: number;
};

export type SmtpMailerDeps = {
  /** Test seam: build a transport from the derived options (defaults to nodemailer's pooled SMTP). */
  transport?: (options: SmtpTransportOptions) => Transporter;
};

export function smtpTransportOptions(env: Env): SmtpTransportOptions {
  const host = env.SMTP_HOST;
  const port = env.SMTP_PORT;
  if (!host || !port) throw new Error("SMTP_HOST and SMTP_PORT are required");
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) {
    throw new Error("SMTP_USER and SMTP_PASSWORD must be set together");
  }
  const options: SmtpTransportOptions = {
    host,
    port,
    secure: env.SMTP_SECURE,
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
    pool: true,
    maxConnections: 2,
  };
  if (env.SMTP_USER && env.SMTP_PASSWORD) {
    options.auth = { user: env.SMTP_USER, pass: env.SMTP_PASSWORD };
  }
  // "auto" (the default) leaves both flags unset: nodemailer upgrades with STARTTLS when the
  // server advertises it (every provider on 587) and stays plain otherwise (Mailpit on 1025).
  if (env.SMTP_STARTTLS === "true") options.requireTLS = true;
  if (env.SMTP_STARTTLS === "false") options.ignoreTLS = true;
  return options;
}

export function createSmtpMailer(env: Env, deps: SmtpMailerDeps = {}): Mailer {
  const options = smtpTransportOptions(env);
  const from = env.SMTP_FROM;
  // One pooled transport per process: connections are reused across sends and closed when idle.
  const transport = deps.transport
    ? deps.transport(options)
    : nodemailer.createTransport(options as SMTPPool.Options);
  return {
    async send(message) {
      await transport.sendMail({
        from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

function createSesMailer(env: Env): Mailer {
  const client = new SESv2Client({ region: env.AWS_REGION });
  return {
    async send(message) {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: env.SMTP_FROM,
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: "UTF-8" },
              Body: { Text: { Data: message.text, Charset: "UTF-8" } },
            },
          },
        }),
      );
    },
  };
}
