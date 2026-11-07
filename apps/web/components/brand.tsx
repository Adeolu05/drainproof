import Link from "next/link";
import type { CSSProperties } from "react";

/**
 * Drainproof mark: a drain grate (ring with seven holes), drawn in --mark (#1f9d55 in light
 * mode, #5fd08a in dark mode). Same geometry as docs/images/drainproof-mark.svg.
 */
export function LogoMark({ className = "h-7 w-7", style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 64 64" className={className} style={style}>
      <circle cx="32" cy="32" r="25" fill="none" stroke="var(--mark)" strokeWidth="6" />
      <g fill="var(--mark)">
        <circle cx="32" cy="32" r="4.2" />
        <circle cx="32" cy="20.5" r="4.2" />
        <circle cx="32" cy="43.5" r="4.2" />
        <circle cx="22" cy="26.25" r="4.2" />
        <circle cx="42" cy="26.25" r="4.2" />
        <circle cx="22" cy="37.75" r="4.2" />
        <circle cx="42" cy="37.75" r="4.2" />
      </g>
    </svg>
  );
}

// The ring's outer diameter is 56 of the 64-unit box (radius 25 plus half of the 6-unit stroke).
// Sizing the box to 64/56 of the font's x-height (1ex) makes the ring exactly x-height tall;
// shifting it down by half the padding puts the ring on the baseline, like the letter it replaces.
const MARK_BOX_EX = 64 / 56;
const MARK_SHIFT_EX = (MARK_BOX_EX - 1) / 2;

/**
 * The "drainproof" wordmark: lowercase, in the display font, with the mark in place of an "o"
 * (drainpr + mark + of). Screen readers get the single word "Drainproof".
 */
export function WordmarkText({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline font-display font-bold tracking-tight ${className}`}>
      <span className="sr-only">Drainproof</span>
      <span aria-hidden="true" className="whitespace-nowrap">
        drainpr
        <LogoMark
          className="inline-block"
          style={{ width: `${MARK_BOX_EX}ex`, height: `${MARK_BOX_EX}ex`, verticalAlign: `-${MARK_SHIFT_EX}ex`, margin: "0 0.02em" }}
        />
        of
      </span>
    </span>
  );
}

export function Wordmark({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex min-h-11 items-center text-[1.35rem] sm:min-h-9">
      <WordmarkText />
    </Link>
  );
}
