"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="shell">
      <h1>Qualcosa non ha funzionato</h1>
      <div className="actions">
        <button className="button primary" type="button" onClick={reset}>
          Riprova
        </button>
      </div>
    </main>
  );
}
