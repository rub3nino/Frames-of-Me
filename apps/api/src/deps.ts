import type { Env } from "@rephoto/contracts";
import type { Database, UserRow } from "@rephoto/db";
import type { FaceEngine } from "@rephoto/face-engine/types";
import type { Mailer } from "./mailer.js";
import type { ObjectStore } from "./object-store.js";
import type { JobQueue } from "./queue.js";

export type AppDeps = {
  env: Env;
  db: Database;
  objects: ObjectStore;
  mailer: Mailer;
  queue: JobQueue;
  faces: FaceEngine;
};

export type AppEnv = {
  Variables: {
    user: UserRow | null;
    ip: string;
  };
};
