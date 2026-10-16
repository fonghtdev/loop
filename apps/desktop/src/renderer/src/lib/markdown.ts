import { linkify } from "./text";
import { isSafeExternalUrl } from "../../../shared/url";

/**
 * Message formatting, client side only (the server stores the raw text). A small parser that builds a tree the
 * UI turns into React nodes: no HTML is ever produced, so tags in a message stay text. One left-to-right pass
 * per block with a stack for emphasis, so the time is linear whatever the input (unclosed or overlapping markers
 * simply stay text).
 */
export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong" | "em" | "del"; children: Inline[] }
  | { t: "link"; href: string; children: Inline[] }
  /** `<@userId>` (a uuid; anything else stays text). Who it is, and whether they are known, is the UI's business. */
  | { t: "mention"; id: string };
export type Block =
  | { t: "p"; children: Inline[] }
  | { t: "quote"; children: Inline[] }
  | { t: "code"; lang: string; text: string };

const FENCE_OPEN = /^```([\w+#.-]{0,32})[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const MENTION = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/iy;
const URL_START = /https?:\/\/[^\s<>"]{1,2048}/y;
const ESCAPABLE = "\\*_~`[]()>";
const LABEL_MAX = 200;
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/** Lines into paragraphs-runs, quotes and fenced code blocks. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let run: string[] = [];
  let quote: string[] = [];
  let fencesLeft = true; // once a search for a closing fence fails, no later fence can close either
  const flushRun = () => {
    if (run.length) blocks.push({ t: "p", children: parseInline(run.join("\n")) });
    run = [];
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ t: "quote", children: parseInline(quote.join("\n")) });
    quote = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const open = fencesLeft ? FENCE_OPEN.exec(line) : null;
    if (open) {
      let end = i + 1;
      while (end < lines.length && !FENCE_CLOSE.test(lines[end]!)) end++;
      if (end < lines.length) {
        flushRun();
        flushQuote();
        blocks.push({ t: "code", lang: open[1]!, text: lines.slice(i + 1, end).join("\n") });
        i = end;
        continue;
      }
      fencesLeft = false;
    }
    if (line === ">" || line.startsWith("> ")) {
      flushRun();
      quote.push(line.slice(2));
    } else {
      flushQuote();
      run.push(line);
    }
  }
  flushRun();
  flushQuote();
  return blocks;
}

type Frame = { marker: string; children: Inline[] };

function push(children: Inline[], text: string) {
  const last = children[children.length - 1];
  if (last?.t === "text") last.text += text;
  else children.push({ t: "text", text });
}

/** `index of the next backtick run of the same length`, for every run, in one right-to-left pass. */
function codeSpans(s: string) {
  const runs: { at: number; len: number }[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "`") continue;
    let j = i;
    while (s[j] === "`") j++;
    runs.push({ at: i, len: j - i });
    i = j - 1;
  }
  const next = new Map<number, number>(); // run index -> index of the next run of equal length
  const seen = new Map<number, number>();
  for (let r = runs.length - 1; r >= 0; r--) {
    const later = seen.get(runs[r]!.len);
    if (later !== undefined) next.set(r, later);
    seen.set(runs[r]!.len, r);
  }
  return { runs, next };
}

/** Inline formatting of one run of text (see the Inline type). `links: false` inside a link label. */
export function parseInline(s: string, links = true): Inline[] {
  const root: Frame = { marker: "", children: [] };
  const stack: Frame[] = [root];
  const open = new Map<string, number>(); // marker -> how many frames of it are on the stack
  const top = () => stack[stack.length - 1]!;
  const { runs, next } = codeSpans(s);
  let runIdx = 0;
  const closes: number[] = []; // positions of every "]" for link labels
  if (links) for (let i = s.indexOf("]"); i !== -1; i = s.indexOf("]", i + 1)) closes.push(i);
  let closeIdx = 0;
  const linkAt = new Map<number, string | null>(); // "](" position -> its href (null = not a safe link)

  /** A frame that never closed gives its marker and content back as plain text. */
  const unwind = (frame: Frame) => {
    push(top().children, frame.marker);
    for (const c of frame.children) c.t === "text" ? push(top().children, c.text) : top().children.push(c);
  };
  const pop = () => {
    const f = stack.pop()!;
    open.set(f.marker, open.get(f.marker)! - 1);
    return f;
  };
  /** Closes the nearest open `marker`; everything opened after it never closed and turns back into text. */
  const close = (marker: string, kind: "strong" | "em" | "del") => {
    const dangling: Frame[] = [];
    while (top().marker !== marker) dangling.push(pop());
    const frame = pop();
    for (const d of dangling.reverse()) unwind2(frame, d);
    if (frame.children.length) top().children.push({ t: kind, children: frame.children });
    else push(top().children, marker + marker); // an empty pair stays text
  };
  // A dangling frame's text goes into the frame that was open below it, which is `frame` (still being built).
  const unwind2 = (into: Frame, dangling: Frame) => {
    push(into.children, dangling.marker);
    for (const c of dangling.children) c.t === "text" ? push(into.children, c.text) : into.children.push(c);
  };
  const KIND = { "**": "strong", "*": "em", __: "strong", _: "em", "~~": "del" } as const;

  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1]!)) {
      push(top().children, s[i + 1]!);
      i += 2;
    } else if (c === "`") {
      while (runIdx < runs.length && runs[runIdx]!.at < i) runIdx++;
      const run = runs[runIdx];
      const end = next.get(runIdx);
      const len = run?.at === i ? run.len : 0;
      if (len === 0) {
        push(top().children, c); // the tail of a run whose first backtick was escaped
        i++;
      } else if (end === undefined) {
        push(top().children, "`".repeat(len));
        i += len;
      } else {
        const stop = runs[end]!.at;
        const text = s.slice(i + len, stop);
        const code = text.length > 1 && text.startsWith(" ") && text.endsWith(" ") && text.trim() ? text.slice(1, -1) : text;
        top().children.push({ t: "code", text: code });
        i = stop + len;
        while (runIdx < runs.length && runs[runIdx]!.at < i) runIdx++;
      }
    } else if (links && c === "[") {
      while (closeIdx < closes.length && closes[closeIdx]! < i) closeIdx++;
      const p = closes[closeIdx];
      let href: string | null = null;
      if (p !== undefined && p - i - 1 <= LABEL_MAX && s[p + 1] === "(" && !s.slice(i + 1, p).includes("\n")) {
        if (!linkAt.has(p)) {
          const end = s.indexOf(")", p + 2);
          const url = end === -1 || end - p > 2050 ? "" : s.slice(p + 2, end);
          linkAt.set(p, url && !/\s/.test(url) && isSafeExternalUrl(url) && new URL(url).hostname !== "" ? url : null);
        }
        href = linkAt.get(p) ?? null;
      }
      if (href && p !== undefined && p > i + 1) {
        top().children.push({ t: "link", href, children: parseInline(s.slice(i + 1, p), false) });
        i = p + 2 + href.length + 1;
      } else {
        push(top().children, c);
        i++;
      }
    } else if (c === "<" && s[i + 1] === "@") {
      MENTION.lastIndex = i;
      const found = MENTION.exec(s);
      if (found) {
        top().children.push({ t: "mention", id: found[1]!.toLowerCase() });
        i += found[0].length;
      } else {
        push(top().children, c);
        i++;
      }
    } else if (c === "h" && (s.startsWith("http://", i) || s.startsWith("https://", i)) && !isWord(s[i - 1])) {
      URL_START.lastIndex = i;
      const found = URL_START.exec(s);
      const part = found && linkify(found[0])[0];
      if (part?.href) {
        top().children.push({ t: "link", href: part.href, children: [{ t: "text", text: part.text }] });
        i += part.text.length;
      } else {
        push(top().children, c);
        i++;
      }
    } else if (c === "*" || c === "_" || c === "~") {
      let n = 1;
      while (s[i + n] === c) n++;
      const before = s[i - 1];
      const after = s[i + n];
      const canOpen = !isSpace(after) && (c !== "_" || !isWord(before));
      const canClose = !isSpace(before) && (c !== "_" || !isWord(after));
      let left = n;
      while (left > 0) {
        const doubled = c === "~" ? "~~" : c + c;
        const fits = (m: string) => canClose && (open.get(m) ?? 0) > 0 && m.length <= left;
        const topM = top().marker;
        const closer = [topM, doubled, c].find((m) => (m === c || m === doubled) && fits(m));
        if (closer) {
          close(closer, KIND[closer as keyof typeof KIND]);
          left -= closer.length;
        } else if (canOpen && (c !== "~" || left >= 2)) {
          const m = left >= 2 ? doubled : c;
          stack.push({ marker: m, children: [] });
          open.set(m, (open.get(m) ?? 0) + 1);
          left -= m.length;
        } else {
          push(top().children, c.repeat(left));
          left = 0;
        }
      }
      i += n;
    } else {
      push(top().children, c);
      i++;
    }
  }
  while (stack.length > 1) {
    const f = pop();
    unwind(f);
  }
  return root.children;
}
