import net from "node:net";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Env } from "@rephoto/contracts";

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
  const host = env.SMTP_HOST;
  const port = env.SMTP_PORT;
  if (!host || !port) throw new Error("SMTP_HOST and SMTP_PORT are required");
  return {
    send: (message) => smtpSend(host, port, env.SMTP_FROM, message),
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

function smtpSend(
  host: string,
  port: number,
  from: string,
  message: MailMessage,
): Promise<void> {
  const body = message.text
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  const data = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    ".",
    "",
  ].join("\r\n");
  const commands = [
    "EHLO rephoto.local\r\n",
    `MAIL FROM:<${from}>\r\n`,
    `RCPT TO:<${message.to}>\r\n`,
    "DATA\r\n",
    data,
    "QUIT\r\n",
  ];

  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    let buffer = "";
    let step = 0;
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(10_000);
    socket.on("timeout", () => fail(new Error("smtp timeout")));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!smtpResponseDone(buffer)) return;
      const code = Number(buffer.slice(0, 3));
      buffer = "";
      if (code >= 400) {
        fail(new Error(`smtp ${code}`));
        return;
      }
      const next = commands[step];
      step += 1;
      if (!next) {
        socket.end();
        resolve();
        return;
      }
      socket.write(next);
    });
  });
}

function smtpResponseDone(buffer: string): boolean {
  const lines = buffer.split(/\r?\n/).filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  return Boolean(last && last.length >= 4 && last[3] === " ");
}
