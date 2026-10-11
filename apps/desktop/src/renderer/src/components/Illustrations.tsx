import { useId, type ReactNode } from "react";

/**
 * The cosmic scenes of the empty states and first-run cards: orbits, planets, stars. Original artwork, one palette
 * (theme tokens), decorative (`aria-hidden`), no raster. Each scene is a 240x150 viewBox; size it with `className`.
 */
type Ids = { moss: string; cos: string; violet: string; teal: string; bubble: string };

function Scene({ className = "", children }: { className?: string; children: (g: Ids) => ReactNode }) {
  const id = useId();
  const g: Ids = { moss: `${id}m`, cos: `${id}c`, violet: `${id}v`, teal: `${id}t`, bubble: `${id}b` };
  const ref = (k: keyof Ids) => `url(#${g[k]})`;
  const stop = (c: string, offset?: string) => <stop offset={offset} style={{ stopColor: c }} />;
  return (
    <svg viewBox="0 0 240 150" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={g.moss} x1="0" y1="0" x2="1" y2="1">
          {stop("var(--color-moss-200)")}
          {stop("var(--color-moss-500)", "1")}
        </linearGradient>
        <linearGradient id={g.cos} x1="0" y1="0" x2="1" y2="1">
          {stop("var(--color-cosmic-300)")}
          {stop("var(--color-cosmic-teal)", "1")}
        </linearGradient>
        <linearGradient id={g.violet} x1="0" y1="0" x2="1" y2="1">
          {stop("var(--color-cosmic-300)")}
          {stop("var(--color-cosmic-900)", "1")}
        </linearGradient>
        <linearGradient id={g.teal} x1="0" y1="0" x2="1" y2="1">
          {stop("var(--color-cosmic-teal)")}
          {stop("var(--color-cosmic-900)", "1")}
        </linearGradient>
        <linearGradient id={g.bubble} x1="0" y1="0" x2="1" y2="1">
          {stop("var(--color-surface-5)")}
          {stop("var(--color-surface-3)", "1")}
        </linearGradient>
      </defs>
      {children(Object.fromEntries((Object.keys(g) as (keyof Ids)[]).map((k) => [k, ref(k)])) as Ids)}
    </svg>
  );
}

const Stars = ({ at }: { at: [number, number, number?][] }) => (
  <g fill="var(--color-ink)">
    {at.map(([x, y, r = 1.2], i) => (
      <circle key={i} cx={x} cy={y} r={r} opacity={i % 2 ? 0.5 : 0.8} />
    ))}
  </g>
);
const Spark = ({ x, y, s = 7, fill = "var(--color-moss-300)" }: { x: number; y: number; s?: number; fill?: string }) => (
  <path d={`M${x} ${y - s}l${s * 0.28} ${s * 0.72} ${s * 0.72} ${s * 0.28}-${s * 0.72} ${s * 0.28}-${s * 0.28} ${s * 0.72}-${s * 0.28}-${s * 0.72}-${s * 0.72}-${s * 0.28} ${s * 0.72}-${s * 0.28}z`} fill={fill} />
);
const ORBIT_LINE = "var(--color-line)";
const ORBIT_FAINT = "var(--color-ink-faint)";

type Props = { className?: string };

/** A planet with a ring: "create a server". */
export const OrbitArt = ({ className }: Props) => (
  <Scene className={className}>
    {(g) => (
      <>
        <ellipse cx="120" cy="78" rx="96" ry="27" transform="rotate(-18 120 78)" stroke={ORBIT_FAINT} strokeWidth="1.2" strokeDasharray="2 5" opacity=".6" />
        <ellipse cx="120" cy="78" rx="66" ry="18" transform="rotate(-18 120 78)" stroke={g.cos} strokeWidth="1.4" opacity=".75" />
        <circle cx="120" cy="78" r="30" fill={g.moss} />
        <ellipse cx="110" cy="66" rx="12" ry="7" fill="#fff" opacity=".24" />
        <path d="M96 96a30 30 0 0 0 52-10" stroke="var(--color-moss-900)" strokeWidth="7" opacity=".28" strokeLinecap="round" />
        <circle cx="190" cy="50" r="6" fill={g.teal} />
        <circle cx="44" cy="106" r="4.5" fill={g.violet} />
        <Stars at={[[30, 30], [70, 18, 1], [206, 112, 1.4], [168, 128, 1], [22, 70, 0.9], [222, 28, 1.1]]} />
        <Spark x={204} y={76} s={6} />
      </>
    )}
  </Scene>
);

/** A portal with a shooting star: "join with an invite code". */
export const TicketArt = ({ className }: Props) => (
  <Scene className={className}>
    {(g) => (
      <>
        <circle cx="120" cy="78" r="52" stroke={ORBIT_LINE} strokeWidth="1.2" />
        <circle cx="120" cy="78" r="38" stroke={g.cos} strokeWidth="1.6" opacity=".8" />
        <circle cx="120" cy="78" r="24" fill={g.violet} opacity=".92" />
        <circle cx="120" cy="78" r="12" fill="var(--color-surface-0)" />
        <circle cx="120" cy="78" r="12" stroke="var(--color-cosmic-300)" strokeWidth="1" opacity=".6" />
        <path d="M200 26 150 62" stroke={g.moss} strokeWidth="3.5" strokeLinecap="round" opacity=".9" />
        <path d="M212 18 188 38" stroke={g.moss} strokeWidth="1.5" strokeLinecap="round" opacity=".4" />
        <circle cx="202" cy="25" r="5" fill="var(--color-moss-200)" />
        <Stars at={[[36, 34], [64, 122, 1], [196, 118, 1.4], [24, 92, 0.9], [222, 84, 1]]} />
        <Spark x={40} y={60} s={6} fill="var(--color-cosmic-300)" />
      </>
    )}
  </Scene>
);

/** Two planets orbiting each other: "add a friend", empty DM list. */
export const FriendsArt = ({ className }: Props) => (
  <Scene className={className}>
    {(g) => (
      <>
        <ellipse cx="120" cy="78" rx="90" ry="34" stroke={ORBIT_LINE} strokeWidth="1.2" strokeDasharray="2 5" />
        <ellipse cx="120" cy="78" rx="52" ry="52" stroke={g.cos} strokeWidth="1.2" opacity=".5" />
        <circle cx="92" cy="70" r="26" fill={g.violet} />
        <circle cx="150" cy="88" r="20" fill={g.teal} />
        <ellipse cx="84" cy="60" rx="9" ry="5" fill="#fff" opacity=".22" />
        <ellipse cx="144" cy="80" rx="7" ry="4" fill="#fff" opacity=".22" />
        <circle cx="121" cy="79" r="3" fill="var(--color-moss-200)" />
        <circle cx="198" cy="52" r="4" fill="var(--color-moss-300)" />
        <Stars at={[[28, 36], [210, 114, 1.3], [56, 128, 1], [176, 22, 1], [18, 96, 0.9]]} />
        <Spark x={214} y={76} s={6} fill="var(--color-cosmic-300)" />
      </>
    )}
  </Scene>
);

/** A speech bubble on an orbit: an empty conversation or channel. */
export const ChatArt = ({ className }: Props) => (
  <Scene className={className}>
    {(g) => (
      <>
        <ellipse cx="120" cy="82" rx="88" ry="22" transform="rotate(-12 120 82)" stroke={ORBIT_FAINT} strokeWidth="1.2" strokeDasharray="2 5" opacity=".6" />
        <rect x="62" y="36" width="116" height="72" rx="24" fill={g.bubble} stroke={ORBIT_FAINT} strokeWidth="1.2" opacity=".95" />
        <path d="M84 108l-8 22 28-22z" fill="var(--color-surface-3)" stroke={ORBIT_FAINT} strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M84 62h72M84 78h44" stroke="var(--color-ink-faint)" strokeWidth="5" strokeLinecap="round" opacity=".55" />
        <path d="M52 90Q120 122 190 66" stroke={g.cos} strokeWidth="1.5" opacity=".85" />
        <circle cx="196" cy="60" r="5" fill={g.teal} />
        <circle cx="40" cy="48" r="4" fill={g.violet} />
        <Stars at={[[30, 110, 1], [208, 22, 1.3], [100, 16, 1], [222, 100, 1]]} />
        <Spark x={190} y={28} s={7} />
      </>
    )}
  </Scene>
);

/** A constellation of people: empty friends lists. */
export const PeopleArt = ({ className }: Props) => (
  <Scene className={className}>
    {(g) => (
      <>
        <path d="M120 52 70 92M120 52 170 92M120 52 120 112M70 92 120 112M170 92 120 112M70 92 40 56M170 92 204 60" stroke={g.cos} strokeWidth="1.2" opacity=".6" />
        <circle cx="120" cy="52" r="18" fill={g.violet} />
        <circle cx="70" cy="92" r="13" fill={g.teal} />
        <circle cx="170" cy="92" r="13" fill="var(--color-avatar-6)" />
        <circle cx="120" cy="112" r="9" fill={g.moss} />
        <circle cx="40" cy="56" r="6" fill="var(--color-cosmic-300)" />
        <circle cx="204" cy="60" r="6" fill="var(--color-moss-200)" />
        <ellipse cx="113" cy="45" rx="6" ry="4" fill="#fff" opacity=".25" />
        <Stars at={[[24, 110, 1], [214, 118, 1.3], [150, 22, 1], [84, 24, 1.1], [226, 90, 0.9]]} />
        <Spark x={196} y={26} s={6} />
      </>
    )}
  </Scene>
);

/** A quiet planet with sound rings: an empty voice channel. */
export const VoiceArt = ({ className }: Props) => (
  <Scene className={className}>
    {(g) => (
      <>
        <circle cx="120" cy="78" r="58" stroke={ORBIT_LINE} strokeWidth="1.2" strokeDasharray="2 5" />
        <circle cx="120" cy="78" r="44" stroke={g.cos} strokeWidth="1.2" opacity=".45" />
        <circle cx="120" cy="78" r="30" stroke={g.cos} strokeWidth="1.4" opacity=".75" />
        <circle cx="120" cy="78" r="16" fill={g.teal} />
        <ellipse cx="115" cy="72" rx="6" ry="3.5" fill="#fff" opacity=".24" />
        <circle cx="178" cy="78" r="5" fill={g.moss} />
        <circle cx="62" cy="78" r="3.5" fill={g.violet} />
        <Stars at={[[30, 30], [206, 28, 1.3], [36, 124, 1], [212, 122, 1], [150, 14, 1]]} />
        <Spark x={74} y={32} s={6} fill="var(--color-cosmic-300)" />
      </>
    )}
  </Scene>
);
