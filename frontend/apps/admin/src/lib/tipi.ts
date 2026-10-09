/**
 * Le forme che la console legge, copiate da `packages/contracts/src/http.ts`
 * (gli schemi zod dell'api) e non inventate qui. Dove il nome del campo è una
 * trappola nota — la coda di moderazione risponde `photoId`, non `id` — il
 * commento lo dice e lo schermo legge entrambi.
 */

export type StatoFoto = "uploaded" | "processing" | "indexed" | "error";
export type StatoModerazione = "pending" | "approved" | "rejected" | "auto_rejected";
export type GenereAlbum = "official" | "crowd";
export type ModerazioneAlbum = "pre" | "post" | "off";
export type VisibilitaAlbum = "participants" | "link" | "staff";

export type Evento = {
  id: string;
  slug: string;
  name: string;
  access: "open" | "list";
  retentionDays: number;
  photos: number;
  galleries: number;
  participants: number;
  photographers: number;
  createdAt: string;
};

export type Album = {
  id: string;
  eventId: string;
  slug: string;
  name: string;
  kind: GenereAlbum;
  recognition: boolean;
  moderation: ModerazioneAlbum;
  visibility: VisibilitaAlbum;
  maxPhotosPerUser: number | null;
  uploadsOpen: boolean;
  retentionDays: number | null;
  /** Lo fissa la prima foto: da quel momento `recognition` è in sola lettura. */
  firstUploadAt: string | null;
  createdAt: string;
};

export type FotografoAlbum = { userId: string; email: string; createdAt: string };

export type CodiceEvento = {
  eventId: string;
  code: string;
  label: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
  /** Derivato, non salvato: cosa farebbe `claimEventCode` adesso. */
  status: "active" | "expired" | "exhausted";
};

export type StatoEvento = {
  event: { id: string; slug: string; name: string };
  photos: number;
  photosByStatus: Record<StatoFoto, number>;
  originalsPending: number;
  faces: number;
  galleries: number;
  galleriesMatched: number;
  selfiesWaiting: number;
  matchJobsPending: number;
  albums: Array<{
    id: string; slug: string; name: string; kind: GenereAlbum; recognition: boolean;
    moderation: ModerazioneAlbum; uploadsOpen: boolean; photos: number; firstUploadAt: string | null;
  }>;
  jobsByType: Array<{ type: string; queued: number; running: number; error: number; oldestQueuedSeconds: number | null }>;
  oldestQueuedSeconds: number | null;
  lastErrors: Array<{ id: string; type: string; error: string; at: string }>;
  faceService: { ok: boolean | null; ms: number | null };
  at: string;
};

export type Foto = {
  id: string;
  eventId: string;
  photographerId: string;
  sha256: string;
  status: StatoFoto;
  bytes: number;
  originalStatus: string;
  indexedAt: string | null;
  error: string | null;
  createdAt: string;
  filename: string | null;
  tags: string[];
  thumbUrl: string | null;
};

export type DettaglioFoto = {
  photo: Foto;
  webUrl: string | null;
  thumbUrl: string | null;
  faces: Array<{ id: string; externalId: string; confidence: number }>;
  galleries: Array<{ userId: string; email: string; score: number; source: string; feedback: string | null }>;
};

export type RigaGalleria = {
  userId: string;
  email: string;
  total: number;
  matchedAt: string | null;
  reason: string | null;
};

export type GalleriaDiUno = {
  user: { id: string; email: string };
  gallery: { id: string; matchedAt: string | null; anchorFaceIds: string[]; reason: string | null; total: number } | null;
  items: Array<{
    photoId: string; thumbUrl: string; webUrl: string; score: number;
    source: "match" | "attach"; createdAt: string; feedback: "me" | "not_me" | null;
    photo: { sha256: string; filename: string | null };
  }>;
};

export type Partecipante = {
  user: { id: string; email: string; role: string; createdAt: string };
  consent: { active: boolean; canRevoke: boolean };
  onParticipantList: boolean;
  emailVerifiedAt: string | null;
  gallery: { id: string; matchedAt: string | null; reason: string | null; hasQueryVector: boolean; anchors: number } | null;
};

/** Cosa ha tolto una revoca: la risposta è la stessa per l'utente e per lo staff. */
export type RevocaFatta = {
  withdrawnAt: string;
  deleted: {
    consents: number; gallery: boolean; galleryItems: number; selfieVector: boolean;
    anchors: number; faceVectors: number; selfieObjects: number; feedback: number; matchRuns: number;
  };
};

export type PianoRetention = {
  enabled: boolean;
  windowSeconds: number;
  events: Array<{
    eventId: string; slug: string; retentionDays: number;
    lastRunAt: string | null; windowStart: string | null; nextRunAt: string; runs: number;
    outcome: "enqueued" | "failed" | null;
    jobId: string | null; jobStatus: "queued" | "running" | "done" | "error" | null;
    jobError: string | null; jobFinishedAt: string | null;
    alarm: "failed" | "job_error" | "skipped" | "never" | null;
  }>;
};

export type VoceModerazione = {
  /**
   * La rotta spedita risponde `photoId`; la console normalizza su `id` una
   * volta sola, in `vociDi()`. Leggere solo `id` significava buttare ogni
   * riga e vedere una coda vuota per sempre.
   */
  id: string;
  photoId?: string;
  albumId?: string;
  eventId?: string;
  uploaderId?: string;
  moderationState?: StatoModerazione;
  createdAt?: string;
  /** Segnalazioni aperte con un motivo che CONTA verso la soglia. */
  openReports?: number;
  /** Segnalazioni «non sono io»: si mostrano, non contano mai. */
  notMeReports?: number;
  reasons?: string[];
  thumbUrl?: string | null;
  webUrl?: string | null;
  filename?: string | null;
};

export type CodaModerazione = {
  items?: VoceModerazione[];
  /** Nome alternativo rimasto nelle bozze della specifica. */
  photos?: VoceModerazione[];
  nextCursor?: string | null;
};

export type CollegamentoOps = { key: string; label: string; url: string };
