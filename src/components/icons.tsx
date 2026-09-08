type IconProps = { className?: string };

export function IconFolder({ className = "tree-ico" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2.2 4.6A1.4 1.4 0 0 1 3.6 3.2h2.8l1.1 1.3h5A1.4 1.4 0 0 1 13.8 6v5.6a1.4 1.4 0 0 1-1.4 1.4h-8.8A1.4 1.4 0 0 1 2.2 11.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconFile({ className = "tree-ico" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M4.2 2.4h5.1L12.4 5.5v8.1A1.1 1.1 0 0 1 11.3 14.7H4.2A1.1 1.1 0 0 1 3.1 13.6V3.5A1.1 1.1 0 0 1 4.2 2.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9.2 2.5V5.6h3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function IconPlus({ className = "tree-ico" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconSearch({ className = "tree-ico faint" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden>
      <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10.4 10.4 13.2 13.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconArchive({ className = "tree-ico" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2.4 3.4h11.2v2.2H2.4zM3.2 5.6h9.6v6.6a1.2 1.2 0 0 1-1.2 1.2H4.4a1.2 1.2 0 0 1-1.2-1.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M6.4 8.4h3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconTrash({ className = "tree-ico" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M3.2 4.4h9.6M6.2 4.4V3.2h3.6v1.2M4.4 4.4l.5 8.2a1 1 0 0 0 1 1h4.2a1 1 0 0 0 1-1l.5-8.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconUnarchive({ className = "tree-ico" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2.4 3.4h11.2v2.2H2.4zM3.2 5.6h9.6v6.6a1.2 1.2 0 0 1-1.2 1.2H4.4a1.2 1.2 0 0 1-1.2-1.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8 11.4V7.6M6.4 8.8 8 7.2l1.6 1.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
