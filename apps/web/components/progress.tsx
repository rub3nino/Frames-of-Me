export function Progress({ value, label }: { value: number; label: string }) {
  const amount = Math.max(0, Math.min(1, value));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(amount * 100)}
      style={{ ["--p" as string]: String(amount) }}
    >
      <span />
    </div>
  );
}
