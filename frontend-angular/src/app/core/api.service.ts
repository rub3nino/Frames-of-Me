import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';

/**
 * ApiService — contratto tipizzato verso l'API Hono esistente (base `/v1`).
 *
 * IMPORTANTE (v1 visiva): nessuna chiamata di rete viene eseguita.
 * Ogni metodo documenta l'endpoint reale e restituisce un Observable vuoto/mock,
 * così le pagine possono già tipizzare i flussi. L'autenticazione reale usa il
 * cookie di sessione `rephoto_session` (credenziali: 'include' quando si
 * sostituirà `of(...)` con HttpClient/fetch).
 */

/* ---------- Tipi ---------- */

export type Role = 'participant' | 'photographer' | 'admin';

export interface EventSummary {
  slug: string;
  name: string;
  date: string; // ISO
  venue: string;
  coverUrl: string;
}

export interface GalleryPhoto {
  id: string;
  url: string;
  thumbUrl: string;
  takenAt: string;
  photographer: string;
  matchScore?: number; // presente solo nella galleria personale
}

export interface ConsentState {
  faceSearch: boolean;
  publicCircle: boolean;
  updatedAt: string;
}

export type ModerationState = 'published' | 'pending' | 'rejected' | 'queued';

export interface AdminPhotoRow {
  id: string;
  thumbUrl: string;
  eventName: string;
  photographer: string;
  state: ModerationState;
  uploadedAt: string;
}

export interface AdminMetrics {
  photosIndexed: number;
  participants: number;
  matches: number;
  moderationQueue: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  /* ---------- Auth ---------- */

  /** POST /v1/auth/request-link { email, role } — magic link via email (via reale oggi). */
  requestLoginLink(email: string, role: Role): Observable<{ ok: true }> {
    return of({ ok: true as const });
  }

  /** GET /v1/auth/verify?token=… — verifica il magic link e apre la sessione (cookie rephoto_session). */
  verifyLoginLink(token: string): Observable<{ ok: true; role: Role }> {
    return of({ ok: true as const, role: 'participant' as Role });
  }

  /** POST /v1/auth/login { email, password, role } — SOLO staff (admin/fotografo). */
  loginStaff(email: string, password: string, role: Exclude<Role, 'participant'>): Observable<{ ok: true }> {
    return of({ ok: true as const });
  }

  // NOTA: Google OIDC e registrazione con password sono pianificati (v6),
  // NON ancora implementati lato API: la UI li mostra disabilitati / "a breve".

  /* ---------- Eventi e galleria partecipante ---------- */

  /** GET /v1/events/:slug — dettagli evento pubblico. */
  getEvent(slug: string): Observable<EventSummary | null> {
    return of(null);
  }

  /** POST /v1/events/:slug/selfie — invia il selfie; il server estrae il vettore e CANCELLA l'immagine. */
  submitSelfie(slug: string, selfie: Blob): Observable<{ ok: true; queued: boolean }> {
    return of({ ok: true as const, queued: true });
  }

  /** GET /v1/events/:slug/consent · PUT /v1/events/:slug/consent — stato consensi GDPR. */
  getConsent(slug: string): Observable<ConsentState> {
    return of({ faceSearch: false, publicCircle: false, updatedAt: new Date().toISOString() });
  }

  /** GET /v1/events/:slug/gallery — foto in cui l'utente compare (match sul vettore del volto). */
  getMyGallery(slug: string): Observable<GalleryPhoto[]> {
    return of([]);
  }

  /** POST /v1/events/:slug/gallery/:photoId/not-me — «Non sono io»: rimuove il match. */
  reportNotMe(slug: string, photoId: string): Observable<{ ok: true }> {
    return of({ ok: true as const });
  }

  /* ---------- Upload fotografo ---------- */

  /** POST /v1/uploads — avvia un upload fotografo; POST /v1/uploads/:id/complete per chiudere. */
  createUpload(eventSlug: string, fileName: string): Observable<{ uploadId: string; putUrl: string }> {
    return of({ uploadId: 'mock', putUrl: '' });
  }

  /* ---------- Admin ---------- */

  /** GET /v1/admin/metrics — contatori per la dashboard. */
  getAdminMetrics(): Observable<AdminMetrics> {
    return of({ photosIndexed: 0, participants: 0, matches: 0, moderationQueue: 0 });
  }

  /** GET /v1/admin/photos?state=… — elenco foto con stato di moderazione. */
  getAdminPhotos(state?: ModerationState): Observable<AdminPhotoRow[]> {
    return of([]);
  }

  /** POST /v1/admin/moderation/:photoId { action: 'approve' | 'reject' } */
  moderatePhoto(photoId: string, action: 'approve' | 'reject'): Observable<{ ok: true }> {
    return of({ ok: true as const });
  }

  /** GET /v1/admin/export/csv — export CSV (metrics, consensi, gallerie). */
  exportCsv(kind: 'photos' | 'participants' | 'consents'): Observable<Blob> {
    return of(new Blob());
  }
}
