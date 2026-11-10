import type { ReactNode } from "react";

export const GITHUB = "https://github.com/Adeolu05/drainproof";
export const docUrl = (file: string) => `${GITHUB}/blob/main/docs/${file}`;
export const README_TESTNET = `${GITHUB}#drainproof-vault-on-testnet`;
export const nearblocks = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;

export function SectionHeading({ id, title, children }: { id?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <h2 id={id} className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-[2.6rem] sm:leading-[1.1]">
        {title}
      </h2>
      {children ? <p className="mt-4 text-base text-muted sm:text-lg">{children}</p> : null}
    </div>
  );
}

/**
 * A NEAR testnet transaction hash, truncated, linking to NearBlocks. The full hash is in the
 * link target, the tooltip and the screen-reader text, and is the one recorded in the README.
 */
export function TxLink({ hash, className = "" }: { hash: string; className?: string }) {
  return (
    <a
      href={nearblocks(hash)}
      className={`link inline-flex min-h-6 items-center gap-1 font-mono text-[13px] whitespace-nowrap [overflow-wrap:normal] ${className}`}
      title={hash}
    >
      {hash.slice(0, 8)}…<span className="sr-only">, transaction {hash} on NearBlocks testnet</span>
      <Icon name="external" className="h-3.5 w-3.5 text-muted" />
    </a>
  );
}

export type CodeLine = { text: string; tone?: "cmd" | "muted" | "fail" | "pass" | "warn" | "plain" };

const TONE: Record<NonNullable<CodeLine["tone"]>, string> = {
  cmd: "text-fg",
  muted: "text-muted",
  fail: "text-fail",
  pass: "text-pass",
  warn: "text-warn",
  plain: "text-fg",
};

/** A code block with a filename label. Content is real CLI output or real file content. */
export function CodeBlock({ label, lines, className = "" }: { label: string; lines: CodeLine[]; className?: string }) {
  return (
    <figure className={`overflow-hidden rounded-md border border-border bg-surface ${className}`}>
      <figcaption className="border-b border-border px-4 py-2 font-mono text-xs text-muted">{label}</figcaption>
      {/* Lines are kept intact (as the CLI prints them) and scroll sideways on narrow screens. */}
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre sm:text-[13px]" tabIndex={0} aria-label={label}>
        {lines.map((l, i) => (
          <span key={i} className={`block ${TONE[l.tone ?? "plain"]}`}>
            {l.tone === "cmd" ? <span className="select-none text-muted">$ </span> : null}
            {l.text || " "}
          </span>
        ))}
      </pre>
    </figure>
  );
}

type IconName = "check" | "pending" | "arrow" | "external" | "cross";

const PATHS: Record<IconName, ReactNode> = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  pending: <path d="M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
};

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {PATHS[name]}
    </svg>
  );
}
