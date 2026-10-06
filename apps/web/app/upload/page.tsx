"use client";

import { useEffect, useState } from "react";
import { Gate } from "@/components/require-role";
import { Progress } from "@/components/progress";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { eventSlug } from "@/lib/event";
import { contentTypeOf, uploadPhoto } from "@/lib/upload";
import type { EventInfo, UploadListItem } from "@/lib/types";

type LocalStatus = "queued" | "uploading" | "deduped" | "sent" | "error";

type LocalFile = {
  id: string;
  name: string;
  status: LocalStatus;
  loaded: number;
  total: number;
  error?: string;
};

const sessionLabel: Record<UploadListItem["status"], string> = {
  open: "In corso",
  completed: "Completato",
  aborted: "Interrotto",
};

const localLabel: Record<LocalStatus, string> = {
  queued: "In attesa",
  uploading: "Caricamento",
  deduped: "Già presente",
  sent: "Caricata",
  error: "Errore",
};

export default function UploadPage() {
  return (
    <Shell signOut>
      <Uploader />
    </Shell>
  );
}

function Uploader() {
  const [eventId, setEventId] = useState<string | null>(null);
  const [gate, setGate] = useState<"anon" | "wrong" | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [locals, setLocals] = useState<LocalFile[]>([]);
  const [uploads, setUploads] = useState<UploadListItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    api<EventInfo>(`/v1/events/${eventSlug}`)
      .then((event) => {
        if (!stop) setEventId(event.id);
      })
      .catch((cause: unknown) => {
        if (!stop) {
          setBootError(cause instanceof ApiError ? cause.message : "Evento non trovato.");
        }
      });
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!eventId) return;
    let stop = false;
    async function load() {
      try {
        const data = await api<{ uploads: UploadListItem[] }>(`/v1/uploads?eventId=${eventId}`);
        if (!stop) {
          setUploads(data.uploads);
          setListError(null);
          setGate(null);
        }
      } catch (cause) {
        if (stop) return;
        if (cause instanceof ApiError && cause.status === 401) setGate("anon");
        else if (cause instanceof ApiError && cause.status === 403) setGate("wrong");
        else setListError(cause instanceof ApiError ? cause.message : "Non riusciamo a leggere i caricamenti.");
      }
    }
    void load();
    const id = window.setInterval(() => void load(), 4000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [eventId]);

  function patch(id: string, partial: Partial<LocalFile>) {
    setLocals((current) => current.map((item) => (item.id === id ? { ...item, ...partial } : item)));
  }

  async function start(list: File[]) {
    if (busy || !eventId || list.length === 0) return;
    const jobs: { file: File; entry: LocalFile }[] = [];
    const rejected: string[] = [];
    list.forEach((file, index) => {
      const type = contentTypeOf(file);
      if (!type) {
        rejected.push(file.name);
        return;
      }
      jobs.push({
        file,
        entry: {
          id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
          name: file.name,
          status: "queued",
          loaded: 0,
          total: file.size,
        },
      });
    });
    if (rejected.length > 0) setNotice("Solo jpeg e png.");
    else setNotice(null);
    if (jobs.length === 0) return;

    setLocals(jobs.map((job) => job.entry));
    setBusy(true);
    for (const job of jobs) {
      const type = contentTypeOf(job.file);
      if (!type) continue;
      patch(job.entry.id, { status: "uploading" });
      try {
        await uploadPhoto(job.file, eventId, type, (loaded, total) => {
          patch(job.entry.id, { loaded, total, status: "uploading" });
        });
        patch(job.entry.id, { status: "sent", loaded: job.file.size, total: job.file.size });
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 409) {
          patch(job.entry.id, { status: "deduped", loaded: job.file.size, total: job.file.size });
        } else {
          patch(job.entry.id, {
            status: "error",
            error: cause instanceof ApiError || cause instanceof Error ? cause.message : "Errore",
          });
        }
      }
    }
    setBusy(false);
  }

  if (gate) return <Gate kind={gate} />;
  if (bootError) {
    return (
      <div className="stack">
        <h1>Carica le foto</h1>
        <p className="alert" role="alert">
          {bootError}
        </p>
      </div>
    );
  }

  const total = locals.reduce((sum, item) => sum + item.total, 0);
  const loaded = locals.reduce((sum, item) => sum + item.loaded, 0);

  return (
    <div className="stack">
      <div>
        <h1>Carica le foto</h1>
        <p className="lede">Evento {eventSlug}. Jpeg o png.</p>
      </div>
      <label
        className="drop"
        data-over={over ? "true" : "false"}
        onDragEnter={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void start([...event.dataTransfer.files]);
        }}
      >
        <input
          className="sr"
          type="file"
          accept="image/jpeg,image/png"
          multiple
          disabled={busy || !eventId}
          onChange={(event) => {
            void start([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <span>Trascina le foto qui, oppure tocca per sceglierle.</span>
      </label>
      <p className="note">
        Se si interrompe, invia di nuovo gli stessi file. Quelli già registrati non vengono duplicati.
      </p>
      {notice ? (
        <p className="alert" role="alert">
          {notice}
        </p>
      ) : null}
      {locals.length > 0 ? (
        <>
          <div className="progress-row">
            <Progress value={total === 0 ? 0 : loaded / total} label="Avanzamento del caricamento" />
            <span className="meta">{total === 0 ? 0 : Math.round((loaded / total) * 100)}%</span>
          </div>
          <ul className="list">
            {locals.map((item) => (
              <li key={item.id}>
                <span className="name">{item.name}</span>
                <span className="meta">
                  {item.status === "uploading"
                    ? `${item.total === 0 ? 0 : Math.round((item.loaded / item.total) * 100)}%`
                    : localLabel[item.status]}
                  {item.error ? ` · ${item.error}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <section className="block">
        <h2>Stato</h2>
        {listError ? (
          <p className="alert" role="alert">
            {listError}
          </p>
        ) : uploads.length === 0 ? (
          <p className="note">Nessuna foto caricata.</p>
        ) : (
          <ul className="list">
            {uploads.map((item) => (
              <li key={item.id}>
                <span className="name">{item.objectKey.split("/").pop()}</span>
                <span className="meta">{sessionLabel[item.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
