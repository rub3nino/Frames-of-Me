import type { AlbumKind, AlbumModeration, AlbumVisibility } from "@/lib/types";

/**
 * v6 D (agent D): the two frozen album rules, as the admin form has to render them.
 *
 * The rules themselves live in the database — the `crowd_never_recognizes` check and the
 * `recognition` trigger of migration 009 (`AlbumRecognitionNotAllowedError` /
 * `AlbumRecognitionLockedError`). Nothing here enforces anything and nothing here works
 * around anything: this module only decides what the form shows and what it is allowed to
 * send, so the person filling it in understands the refusal before the api answers it.
 *
 * It is a plain module with no React in it so the rules can be tested directly
 * (`album-rules.test.ts`).
 */

export type AlbumDraft = {
  slug: string;
  name: string;
  kind: AlbumKind;
  recognition: boolean;
  moderation: AlbumModeration;
  visibility: AlbumVisibility;
  maxPhotosPerUser: number | null;
  uploadsOpen: boolean;
  retentionDays: number | null;
};

/** Why the recognition switch is not editable, when it is not. */
export type RecognitionLock = "crowd" | "first-upload";

export type RecognitionFieldState = {
  /** Rendered disabled and greyed when true. */
  disabled: boolean;
  /** What the switch shows — and the only value the form may send. */
  value: boolean;
  /** The explanation shown next to the switch; null when the switch is live. */
  reason: string | null;
  lock: RecognitionLock | null;
};

export const RECOGNITION_CROWD_REASON =
  "Un album «di tutti» non usa mai il riconoscimento dei volti: le foto le carica il pubblico e nessuno ha dato il consenso biometrico per quelle immagini. Per il riconoscimento serve un album ufficiale.";

export const RECOGNITION_LOCKED_REASON =
  "Questo album ha già la prima foto: il riconoscimento non è più modificabile, perché cambierebbe la finalità del trattamento di foto già caricate con un altro consenso. Per cambiarlo, crea un nuovo album.";

export const KIND_LOCKED_REASON =
  "Il tipo di album non si cambia dopo la creazione: album ufficiale e album di tutti hanno regole di consenso diverse.";

/**
 * The state of the recognition switch for an album (existing or being created).
 *
 * `crowd` wins over `first-upload`: for a crowd album the answer is "never", which is the
 * stronger and more useful explanation, and the value is forced to false — exactly what the
 * `crowd_never_recognizes` check says.
 */
export function recognitionField(input: {
  kind: AlbumKind;
  recognition: boolean;
  /** `albums.first_upload_at` as the api serialises it; null before the first photo. */
  firstUploadAt: string | null;
}): RecognitionFieldState {
  if (input.kind === "crowd") {
    return { disabled: true, value: false, reason: RECOGNITION_CROWD_REASON, lock: "crowd" };
  }
  if (input.firstUploadAt !== null) {
    return {
      disabled: true,
      value: input.recognition,
      reason: RECOGNITION_LOCKED_REASON,
      lock: "first-upload",
    };
  }
  return { disabled: false, value: input.recognition, reason: null, lock: null };
}

/** A new album starts as an official album with recognition on and post-moderation. */
export function emptyDraft(): AlbumDraft {
  return {
    slug: "",
    name: "",
    kind: "official",
    recognition: true,
    moderation: "post",
    visibility: "participants",
    maxPhotosPerUser: null,
    uploadsOpen: true,
    retentionDays: null,
  };
}

/**
 * Switching the kind in the form: choosing `crowd` drops recognition to false there and
 * then, so what the form shows is what the database would accept.
 */
export function withKind(draft: AlbumDraft, kind: AlbumKind): AlbumDraft {
  if (kind === "crowd") return { ...draft, kind, recognition: false };
  return { ...draft, kind };
}

export type AlbumCreateBody = AlbumDraft;

/** The body of `POST /v1/admin/events/:id/albums`, with the crowd rule already applied. */
export function createBody(draft: AlbumDraft): AlbumCreateBody {
  const field = recognitionField({ kind: draft.kind, recognition: draft.recognition, firstUploadAt: null });
  return { ...draft, recognition: field.value };
}

/** The stored album the form is editing: the fields `patchBody` compares the draft against. */
export type AlbumSnapshot = {
  name: string;
  kind: AlbumKind;
  recognition: boolean;
  moderation: AlbumModeration;
  visibility: AlbumVisibility;
  maxPhotosPerUser: number | null;
  uploadsOpen: boolean;
  retentionDays: number | null;
  firstUploadAt: string | null;
};

export type AlbumPatchBody = {
  name?: string;
  recognition?: boolean;
  moderation?: AlbumModeration;
  visibility?: AlbumVisibility;
  maxPhotosPerUser?: number | null;
  uploadsOpen?: boolean;
  retentionDays?: number | null;
};

/**
 * The body of `PATCH /v1/admin/albums/:id`: only what actually changed, and never
 * `recognition` when the switch is locked — a locked switch has no business sending a value
 * the database would refuse (or, worse, sending the current value and looking like a change).
 */
export function patchBody(draft: AlbumDraft, album: AlbumSnapshot): AlbumPatchBody {
  const body: AlbumPatchBody = {};
  if (draft.name !== album.name) body.name = draft.name;
  if (draft.moderation !== album.moderation) body.moderation = draft.moderation;
  if (draft.visibility !== album.visibility) body.visibility = draft.visibility;
  if (draft.maxPhotosPerUser !== album.maxPhotosPerUser) body.maxPhotosPerUser = draft.maxPhotosPerUser;
  if (draft.uploadsOpen !== album.uploadsOpen) body.uploadsOpen = draft.uploadsOpen;
  if (draft.retentionDays !== album.retentionDays) body.retentionDays = draft.retentionDays;
  const field = recognitionField({
    kind: album.kind,
    recognition: draft.recognition,
    firstUploadAt: album.firstUploadAt,
  });
  if (!field.disabled && field.value !== album.recognition) body.recognition = field.value;
  return body;
}

export const KIND_LABEL: Record<AlbumKind, string> = {
  official: "Album ufficiale",
  crowd: "Album di tutti",
};

export const MODERATION_LABEL: Record<AlbumModeration, string> = {
  pre: "Prima della pubblicazione",
  post: "Dopo la pubblicazione",
  off: "Nessuna moderazione",
};

export const VISIBILITY_LABEL: Record<AlbumVisibility, string> = {
  participants: "Partecipanti dell'evento",
  link: "Chi ha il link",
  staff: "Solo staff",
};
