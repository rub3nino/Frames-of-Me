import assert from "node:assert/strict";
import { test } from "node:test";
import { envSchema, type Env } from "@rephoto/contracts";
import nodemailer from "nodemailer";
import { createSmtpMailer, smtpTransportOptions, type SmtpTransportOptions } from "../src/mailer.ts";

const base = {
  DATABASE_URL: "postgres://x",
  S3_BUCKET: "b",
  S3_REGION: "eu-central-1",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  FACE_ENGINE: "fake",
  SMTP_FROM: "RePhoto <noreply@example.com>",
  WEB_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:8787",
};

function env(overrides: Record<string, string>): Env {
  return envSchema.parse({ ...base, ...overrides });
}

test("mailpit defaults: no auth, no TLS, STARTTLS left to auto", () => {
  const options = smtpTransportOptions(env({ SMTP_HOST: "localhost", SMTP_PORT: "1025" }));
  assert.equal(options.host, "localhost");
  assert.equal(options.port, 1025);
  assert.equal(options.secure, false);
  assert.equal(options.auth, undefined);
  assert.equal(options.requireTLS, undefined);
  assert.equal(options.ignoreTLS, undefined);
  assert.equal(options.pool, true);
  assert.equal(options.maxConnections, 2);
  assert.equal(options.connectionTimeout, 10_000);
  assert.equal(options.socketTimeout, 20_000);
});

test("port 465 implies implicit TLS", () => {
  const options = smtpTransportOptions(env({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "465" }));
  assert.equal(options.secure, true);
});

test("SMTP_SECURE overrides the port default", () => {
  assert.equal(
    smtpTransportOptions(env({ SMTP_HOST: "h", SMTP_PORT: "465", SMTP_SECURE: "false" })).secure,
    false,
  );
  assert.equal(
    smtpTransportOptions(env({ SMTP_HOST: "h", SMTP_PORT: "2525", SMTP_SECURE: "true" })).secure,
    true,
  );
});

test("587 with credentials: AUTH, secure false, STARTTLS auto", () => {
  const options = smtpTransportOptions(
    env({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p" }),
  );
  assert.equal(options.secure, false);
  assert.deepEqual(options.auth, { user: "u", pass: "p" });
  assert.equal(options.requireTLS, undefined);
  assert.equal(options.ignoreTLS, undefined);
});

test("SMTP_STARTTLS=true requires STARTTLS; false disables it", () => {
  const required = smtpTransportOptions(env({ SMTP_HOST: "h", SMTP_PORT: "587", SMTP_STARTTLS: "true" }));
  assert.equal(required.requireTLS, true);
  assert.equal(required.ignoreTLS, undefined);
  const disabled = smtpTransportOptions(env({ SMTP_HOST: "h", SMTP_PORT: "1025", SMTP_STARTTLS: "false" }));
  assert.equal(disabled.ignoreTLS, true);
  assert.equal(disabled.requireTLS, undefined);
});

test("rejects half-configured credentials", () => {
  assert.throws(
    () => smtpTransportOptions(env({ SMTP_HOST: "h", SMTP_PORT: "587", SMTP_USER: "u" })),
    /SMTP_USER and SMTP_PASSWORD/,
  );
});

test("send() maps the message onto sendMail with SMTP_FROM", async () => {
  let received: SmtpTransportOptions | undefined;
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const mailer = createSmtpMailer(
    env({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p" }),
    {
      transport: (options) => {
        received = options;
        return transport;
      },
    },
  );
  assert.equal(received?.host, "smtp.example.com");

  const sent: Record<string, unknown>[] = [];
  const original = transport.sendMail.bind(transport);
  transport.sendMail = (async (mail: Parameters<typeof original>[0]) => {
    const info = await original(mail);
    sent.push(JSON.parse(String(info.message)));
    return info;
  }) as typeof transport.sendMail;

  await mailer.send({ to: "p@example.com", subject: "Magic link", text: "Hello\n.\nBye" });
  assert.equal(sent.length, 1);
  const mail = sent[0] as {
    from: { address: string; name: string };
    to: { address: string }[];
    subject: string;
    text: string;
  };
  assert.equal(mail.from.address, "noreply@example.com");
  assert.equal(mail.from.name, "RePhoto");
  assert.deepEqual(mail.to.map((t) => t.address), ["p@example.com"]);
  assert.equal(mail.subject, "Magic link");
  assert.equal(mail.text, "Hello\n.\nBye");
});
