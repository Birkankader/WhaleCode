export function StatusDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}
