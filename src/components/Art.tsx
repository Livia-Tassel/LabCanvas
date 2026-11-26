import type { ReactNode } from 'react';

/**
 * The flask that keeps the user company in empty and waiting states.
 * The drawings carry no text of their own, so the words beside them stay the only label.
 */
export type Mood = 'happy' | 'sleepy' | 'search' | 'oops' | 'bubbling';

const BODY = 'M49 24v22L25.5 89c-4.5 9 1 17 10.5 17h48c9.5 0 15-8 10.5-17L71 46V24z';
const LIQUID = 'M38 66q5.5-4 11 0t11 0 11 0 11 0L94.5 89c4.5 9-1 17-10.5 17H36c-9.5 0-15-8-10.5-17z';
const SPARKLE = 'M0-6Q0 0 6 0 0 0 0 6 0 0-6 0 0 0 0-6z';
const HEART = 'M0 4.5C-7.5-1-3.5-7 0-3 3.5-7 7.5-1 0 4.5z';

const line = { fill: 'none', stroke: 'var(--art-line)', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

function Eyes({ dx = 0, dy = 0 }: { dx?: number; dy?: number }) {
  return (
    <>
      <circle cx={50 + dx} cy={83 + dy} r="3.1" fill="var(--art-line)" />
      <circle cx={70 + dx} cy={83 + dy} r="3.1" fill="var(--art-line)" />
      <circle cx={51.2 + dx} cy={81.7 + dy} r="1.1" fill="#fff" />
      <circle cx={71.2 + dx} cy={81.7 + dy} r="1.1" fill="#fff" />
      <circle cx={49.1 + dx} cy={84.3 + dy} r="0.55" fill="#fff" fillOpacity="0.7" />
      <circle cx={69.1 + dx} cy={84.3 + dy} r="0.55" fill="#fff" fillOpacity="0.7" />
    </>
  );
}

const faces: Record<Mood, ReactNode> = {
  happy: <><Eyes /><path d="M55.5 88.2q4.5 5 9 0" {...line} /></>,
  bubbling: <><Eyes /><path d="M55.5 88.2q4.5 5 9 0" {...line} /></>,
  sleepy: (
    <>
      <path d="M46.5 83.2q3.5 3.4 7 0M66.5 83.2q3.5 3.4 7 0" {...line} />
      <circle cx="60" cy="90.5" r="1.9" {...line} strokeWidth={2} />
      <circle cx="67.5" cy="92.5" r="4.2" fill="var(--art-glass)" fillOpacity="0.78" stroke="var(--art-line)" strokeWidth="1.6" />
    </>
  ),
  search: <><Eyes dx={2} dy={-1} /><path d="M57 90.5q3 1.4 6 0" {...line} /></>,
  oops: <><path d="M47 80l5.5 3-5.5 3M73 80l-5.5 3 5.5 3" {...line} /><path d="M54 91.5q3-3.2 6 0t6 0" {...line} /></>
};

const extras: Record<Mood, ReactNode> = {
  happy: (
    <>
      <path className="art-spark" d={SPARKLE} transform="translate(17 44)" fill="var(--art-spark)" />
      <path className="art-spark s2" d={SPARKLE} transform="translate(103 62) scale(.7)" fill="var(--art-spark)" />
      <path className="art-heart" d={HEART} transform="translate(98 28) rotate(14)" fill="var(--art-blush)" />
      <circle cx="60" cy="10" r="3.2" fill="var(--art-glass)" stroke="var(--art-line)" strokeWidth="2" />
      <circle cx="68.5" cy="3.8" r="1.9" fill="var(--art-glass)" stroke="var(--art-line)" strokeWidth="1.8" />
    </>
  ),
  bubbling: (
    <>
      <circle className="art-bubble" cx="60" cy="12" r="3.2" fill="var(--art-glass)" stroke="var(--art-line)" strokeWidth="2" />
      <circle className="art-bubble b2" cx="66" cy="12" r="2.1" fill="var(--art-glass)" stroke="var(--art-line)" strokeWidth="1.8" />
      <circle className="art-bubble b3" cx="55" cy="12" r="1.7" fill="var(--art-glass)" stroke="var(--art-line)" strokeWidth="1.8" />
      <path className="art-spark" d={SPARKLE} transform="translate(20 50) scale(.65)" fill="var(--art-spark)" />
    </>
  ),
  sleepy: (
    <>
      <path className="art-zzz" d="M82 30h8l-8 9h8" {...line} stroke="var(--art-mint)" />
      <path className="art-zzz z2" d="M97 14h6l-6 7h6" {...line} strokeWidth={2} stroke="var(--art-mint)" />
    </>
  ),
  search: (
    <>
      <circle cx="96" cy="38" r="11" fill="var(--art-glass)" fillOpacity=".7" stroke="var(--art-line)" strokeWidth="2.6" />
      <path d="M90.5 34.5q2.5-4 7-3.5" {...line} strokeWidth={2} stroke="var(--art-blush)" />
      <path d="M104.2 46.2l8 8.3" {...line} strokeWidth={4.4} />
      <path className="art-spark" d={SPARKLE} transform="translate(18 50) scale(.75)" fill="var(--art-spark)" />
    </>
  ),
  oops: (
    <>
      <path d="M95 52c3.4 4.6 4.6 6.8 4.6 9a4.6 4.6 0 0 1-9.2 0c0-2.2 1.2-4.4 4.6-9z" fill="var(--art-drop)" />
      <path d="M14 96h9M98 108h8M10 104h5" {...line} strokeWidth={2} stroke="var(--art-blush)" />
    </>
  )
};

export function Mascot({ mood = 'happy', size = 104 }: { mood?: Mood; size?: number }) {
  return (
    <svg className={`mascot mascot-${mood}`} width={size} height={size} viewBox="0 0 120 120" aria-hidden focusable="false">
      <ellipse cx="60" cy="111" rx="34" ry="4" fill="var(--art-shadow)" />
      <g transform={mood === 'oops' ? 'rotate(-9 60 100)' : undefined}>
        <path d={BODY} fill="var(--art-glass)" />
        <path d={LIQUID} fill="var(--art-liquid)" />
        <circle cx="55" cy="73.5" r="2.4" fill="var(--art-glass)" fillOpacity=".75" />
        <circle cx="66.5" cy="76" r="1.6" fill="var(--art-glass)" fillOpacity=".75" />
        <path d="M33.5 92.5l7-12.5" fill="none" stroke="#fff" strokeOpacity=".82" strokeWidth="3.2" strokeLinecap="round" />
        <path d={BODY} {...line} strokeWidth={3} />
        <rect x="44" y="17" width="32" height="8.5" rx="4.25" fill="var(--art-glass)" stroke="var(--art-line)" strokeWidth="3" />
        <ellipse cx="42.8" cy="90.2" rx="4.5" ry="2.7" fill="var(--art-blush)" />
        <ellipse cx="77.2" cy="90.2" rx="4.5" ry="2.7" fill="var(--art-blush)" />
        {faces[mood]}
      </g>
      {extras[mood]}
    </svg>
  );
}

/** The same flask, reduced to what still reads at the size of an icon. */
export function MascotMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="mascot-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect width="24" height="24" rx="7.5" fill="var(--accent-soft)" />
      <path d="M9.6 4.6h4.8v4.3l4.2 7.5c1 1.9-.2 3.8-2.3 3.8H7.7c-2.1 0-3.3-1.9-2.3-3.8l4.2-7.5z" fill="var(--art-glass)" stroke="var(--art-line)" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="M7.3 13q2.3-1.2 4.7 0t4.7 0l1.9 3.4c1 1.9-.2 3.8-2.3 3.8H7.7c-2.1 0-3.3-1.9-2.3-3.8z" fill="var(--accent)" />
      <rect x="8.3" y="3.2" width="7.4" height="2.2" rx="1.1" fill="var(--art-glass)" stroke="var(--art-line)" strokeWidth="1.25" />
      <circle cx="9.8" cy="16.2" r="0.95" fill="var(--on-accent)" />
      <circle cx="14.2" cy="16.2" r="0.95" fill="var(--on-accent)" />
      <path d="M10.8 18q1.2 1.1 2.4 0" fill="none" stroke="var(--on-accent)" strokeWidth="1" strokeLinecap="round" />
      <path d="M19.2 4.2q0 1.8 1.8 1.8-1.8 0-1.8 1.8 0-1.8-1.8-1.8 1.8 0 1.8-1.8z" fill="var(--art-spark)" />
    </svg>
  );
}
