// A unique creature for every agent: the agent id seeds the generator, so the
// same agent always looks the same. Desktop, VS Code and mobile draw an SVG;
// the terminal draws a colored kaomoji face.

export type Mood = 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'idle'

type Palette = { body: string; dark: string; light: string }

const PALETTES: readonly Palette[] = [
  { body: '#7F77DD', dark: '#3C3489', light: '#AFA9EC' },
  { body: '#1D9E75', dark: '#085041', light: '#5DCAA5' },
  { body: '#D85A30', dark: '#712B13', light: '#F0997B' },
  { body: '#D4537E', dark: '#72243E', light: '#ED93B1' },
  { body: '#378ADD', dark: '#0C447C', light: '#85B7EB' },
  { body: '#EF9F27', dark: '#633806', light: '#FAC775' },
  { body: '#639922', dark: '#27500A', light: '#97C459' },
]

const GRAY: Palette = { body: '#888780', dark: '#444441', light: '#B4B2A9' }

// The done color of the panel, used for the sparkle of a finished creature.
const DONE_SPARKLE = '#7F77DD'

// Repeatable random numbers from a string (cyrb hash with mulberry mixing).
function random(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }

  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16

    return (h >>> 0) / 4294967296
  }
}

const pickIndex = (next: () => number, count: number): number =>
  Math.min(count - 1, Math.floor(next() * count))

/** The agent's own color: its terminal face is drawn in it. */
export function identityColor(seed: string): string {
  const next = random(seed)

  return PALETTES[pickIndex(next, PALETTES.length)]?.body ?? GRAY.body
}

const STYLE = `<style>
*{transform-box:fill-box;transform-origin:center}
@keyframes pop{0%{transform:scale(.2);opacity:0}70%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
@keyframes bob{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(-3px) scale(1.03,.97)}}
@keyframes breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
@keyframes look{0%,100%{transform:translateX(-1.5px)}50%{transform:translateX(1.5px)}}
@keyframes hop{0%,100%{transform:translateY(0)}35%{transform:translateY(-7px)}70%{transform:translateY(0)}}
@keyframes shake{0%,100%{transform:rotate(0)}25%{transform:rotate(-7deg)}75%{transform:rotate(7deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes twinkle{0%,100%{transform:scale(.5);opacity:.3}50%{transform:scale(1.15);opacity:1}}
@keyframes zz{0%{transform:translate(0,0);opacity:0}30%{opacity:1}100%{transform:translate(5px,-9px);opacity:0}}
</style>`

const BODY_MOTION: Record<Mood, string> = {
  running: 'pop .45s ease-out, bob 1.1s ease-in-out .45s infinite',
  waiting: 'breathe 3s ease-in-out infinite',
  completed: 'hop .6s ease-out 2',
  failed: 'shake .45s ease-in-out 2',
  stopped: 'none',
  idle: 'breathe 4s ease-in-out infinite',
}

function eyes(mood: Mood, ink: string, blinkDelay: string): string {
  const y = 37
  if (mood === 'completed') {
    return `<path d="M22 ${y + 1}q4-5 8 0M34 ${y + 1}q4-5 8 0" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`
  }
  if (mood === 'failed') {
    return `<path d="M23 ${y - 3}l6 6m0-6l-6 6M35 ${y - 3}l6 6m0-6l-6 6" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`
  }
  if (mood === 'idle' || mood === 'stopped') {
    return `<path d="M22 ${y}h8M34 ${y}h8" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`
  }
  const look = mood === 'running' ? 'animation:look 2.4s ease-in-out infinite' : ''

  return `<g style="animation:blink 4s infinite ${blinkDelay}s"><circle cx="26" cy="${y}" r="5" fill="#fff"/><circle cx="38" cy="${y}" r="5" fill="#fff"/><g style="${look}"><circle cx="26" cy="${y}" r="2.4" fill="${ink}"/><circle cx="38" cy="${y}" r="2.4" fill="${ink}"/></g></g>`
}

function mouth(mood: Mood, ink: string): string {
  const y = 46
  switch (mood) {
    case 'running':
      return `<ellipse cx="32" cy="${y}" rx="2.5" ry="2" fill="${ink}"/>`
    case 'completed':
      return `<path d="M27 ${y - 1}q5 5 10 0" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    case 'failed':
      return `<path d="M27 ${y}q2.5-2 5 0t5 0" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>`
    default:
      return `<path d="M29.5 ${y}h5" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`
  }
}

function badge(mood: Mood, ink: string): string {
  switch (mood) {
    case 'completed':
      return `<path d="M52 10l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" fill="${DONE_SPARKLE}" style="animation:twinkle 1.2s ease-in-out infinite"/>`
    case 'waiting':
      return `<g fill="${ink}"><circle cx="46" cy="14" r="1.8" style="animation:pulse 1.2s infinite"/><circle cx="51" cy="14" r="1.8" style="animation:pulse 1.2s infinite .2s"/><circle cx="56" cy="14" r="1.8" style="animation:pulse 1.2s infinite .4s"/></g>`
    case 'failed':
      return `<path d="M51 9c3 0 5 2 5 5s-2 4-4 4" stroke="#E24B4A" stroke-width="2" fill="none" stroke-linecap="round" style="animation:pulse 1s infinite"/>`
    case 'idle':
      return `<text x="47" y="18" font-family="sans-serif" font-size="9" font-weight="bold" fill="${ink}" style="animation:zz 2.4s ease-out infinite">z</text>`
    default:
      return ''
  }
}

/** The agent's creature as a whole `<svg>` document. */
export function creatureSvg(seed: string, mood: Mood, size: number): string {
  const next = random(seed)
  const own = PALETTES[pickIndex(next, PALETTES.length)] ?? GRAY
  const shape = pickIndex(next, 3)
  const top = pickIndex(next, 5)
  const spotCount = pickIndex(next, 4)
  const hasCheeks = next() > 0.35
  const blinkDelay = (next() * 2).toFixed(1)
  const spots = Array.from(
    { length: spotCount },
    () => [18 + next() * 28, 46 + next() * 8, 1.5 + next() * 2] as const,
  )

  const isGray = mood === 'failed' || mood === 'stopped'
  const { body, dark, light } = isGray ? GRAY : own

  const bodies = [
    `<ellipse cx="32" cy="40" rx="20" ry="17" fill="${body}"/>`,
    `<rect x="13" y="22" width="38" height="36" rx="17" fill="${body}"/>`,
    `<path d="M12 40a20 20 0 0 1 40 0v16l-5-4-5 4-5-4-5 4-5-4-5 4-5-4z" fill="${body}"/>`,
  ]
  const tops = [
    '',
    `<path d="M24 27L20 14M40 27L44 14" stroke="${dark}" stroke-width="2" stroke-linecap="round"/><circle cx="20" cy="13" r="3" fill="${light}"/><circle cx="44" cy="13" r="3" fill="${light}"/>`,
    `<path d="M18 31L20 16L27 26ZM46 31L44 16L37 26Z" fill="${dark}"/>`,
    `<path d="M15 33L17 17L28 26ZM49 33L47 17L36 26Z" fill="${body}"/>`,
    `<path d="M32 24C32 15 38 12 43 13C41 19 36 22 32 24Z" fill="#639922"/>`,
  ]
  const spotMarks = spots
    .map(
      ([x, y, r]) =>
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${light}" opacity=".8"/>`,
    )
    .join('')
  const cheeks =
    hasCheeks && !isGray
      ? `<ellipse cx="19" cy="43" rx="3" ry="2" fill="#ED93B1" opacity=".7"/><ellipse cx="45" cy="43" rx="3" ry="2" fill="#ED93B1" opacity=".7"/>`
      : ''

  const figure =
    (tops[top] ?? '') +
    (bodies[shape] ?? '') +
    spotMarks +
    cheeks +
    eyes(mood, dark, blinkDelay) +
    mouth(mood, dark) +
    badge(mood, dark)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">${STYLE}<g style="animation:${BODY_MOTION[mood]}">${figure}</g></svg>`
}

const FACES: Record<Mood, readonly string[]> = {
  running: ['(•‿•)', '(•‿•)', '(-‿-)'],
  waiting: ['(·_·)', '(·_·).', '(·_·)..'],
  completed: ['(^‿^)'],
  failed: ['(×_×)'],
  stopped: ['(-_-)'],
  idle: ['(-.-)z', '(-.-)zZ'],
}

/** The terminal face: `frame` grows every second, so it blinks and moves. */
export function creatureFace(mood: Mood, frame: number): string {
  const frames = FACES[mood]

  return frames[frame % frames.length] ?? frames[0] ?? ''
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const spinnerFrame = (frame: number): string =>
  SPINNER[frame % SPINNER.length] ?? '•'
