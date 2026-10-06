import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell">
      <h1>Pagina assente</h1>
      <div className="actions">
        <Link className="button primary" href="/">
          Torna all&apos;inizio
        </Link>
      </div>
    </main>
  );
}
