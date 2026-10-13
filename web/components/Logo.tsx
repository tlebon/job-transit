/** Job Transit mark: one line, three stops; the yellow one is where you're headed. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      <line x1="4" y1="15" x2="26" y2="15" className="logo-line" />
      <circle cx="4.5" cy="15" r="2.8" className="logo-start" />
      <circle cx="15" cy="15" r="2.8" className="logo-start" />
      <circle cx="25.5" cy="15" r="2.8" className="logo-end" />
    </svg>
  );
}
