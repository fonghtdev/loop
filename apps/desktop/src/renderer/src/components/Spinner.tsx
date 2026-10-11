/** The loop: a 270 degree arc with a dot where the gap is (like the logo's tail), turning. */
export function Spinner({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={`animate-spin ${className}`}>
      <path d="M12 3A9 9 0 1 1 3 12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="5.6" cy="5.6" r="1.7" fill="currentColor" opacity="0.55" />
    </svg>
  );
}
