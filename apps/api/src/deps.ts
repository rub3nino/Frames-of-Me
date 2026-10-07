import type { Env } from "@rephoto/contracts";
import type { Database, UserRow } from "@rephoto/db";
import type { FaceEngine } from "@rephoto/face-engine/types";
import type { Mailer } from "./mailer.js";
import type { GoogleTokenExchange } from "./oauth.js";
import type { ObjectStore } from "./object-store.js";
import type { JobQueue } from "./queue.js";
import type { Screening } from "./screening.js";

export type AppDeps = {
  env: Env;
  db: Database;
  objects: ObjectStore;
  mailer: Mailer;
  queue: JobQueue;
  faces: FaceEngine;
  /**
   * v6 (agent B): the Google token exchange. Injected so the OIDC callback can be tested
   * without reaching accounts.google.com; `createApp` falls back to the real endpoint.
   */
  googleTokenExchange?: GoogleTokenExchange;
  /**
   * v6 (agent C): the screening hook that runs before a crowd upload is published. Absent
   * means `noopScreening` (everything passes), which is the v6 default.
   */
  screening?: Screening;
};

export type AppEnv = {
  Variables: {
    user: UserRow | null;
    ip: string;
  };
};
