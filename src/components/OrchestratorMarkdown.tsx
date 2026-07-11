// Tiny dependency-free markdown renderer for orchestrator assistant messages
// (ChatView.tsx). Deliberately a small subset — headings, lists,
// fenced code, inline code/bold/italic, links — rendered as React nodes (no
// innerHTML, so model output can never inject markup). Unclosed markers in a
// still-streaming message simply render literally until the closing half
// arrives; the next batched store write re-parses the whole text.

import { Fragment, type ReactNode } from "react";
import { openUrl } from "@/lib/transport";
import { pathPillLabel, splitLineSuffix, splitTextWithPaths } from "@/lib/paths";

// Inline tokens: code, bold, italic, http(s) links (group 4), and markdown
// links whose href is a filesystem path (group 5, e.g. `[foo.ts](/a/foo.ts:9)`)
// — the latter render as a non-clickable path pill, not a link.
const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(\[[^\]\n]+\]\(~?\/[^)\s]+\))/g;

/**
 * A filesystem path rendered as a compact pill: ONLY the filename (plus an
 * optional `:line`), with the full path in the tooltip. Not a link — just a
 * legibility affordance. Used on prose text nodes and on markdown links whose
 * href is a path; code spans and fenced blocks are never touched.
 */
function PathPill({ path }: { path: string }) {
  const { base, line } = pathPillLabel(path);
  return (
    <span
      title={path}
      className="mx-0.5 inline-flex max-w-full items-center rounded-xs border border-line/70 bg-pop/50 px-1 py-px align-middle font-mono text-11 leading-tight select-text"
    >
      <span className="truncate text-txt">{base}</span>
      {line && <span className="shrink-0 text-fnt">:{line}</span>}
    </span>
  );
}

/** Split a prose run into text + path-pill nodes (paths.ts detection). */
function renderTextWithPaths(text: string, keyPrefix: string): ReactNode[] {
  const segs = splitTextWithPaths(text);
  if (segs.length <= 1 && !segs.some((s) => s.path)) return text ? [text] : [];
  return segs.map((s, i) =>
    s.path ? (
      <PathPill key={`${keyPrefix}-p${i}`} path={s.text} />
    ) : (
      <Fragment key={`${keyPrefix}-t${i}`}>{s.text}</Fragment>
    ),
  );
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last)
      out.push(...renderTextWithPaths(text.slice(last, idx), `${keyPrefix}-${i}a`));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (m[1]) {
      out.push(
        <code
          key={key}
          className="rounded-xs bg-pop px-1 py-px font-mono text-[0.9em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(
        <strong key={key} className="font-semibold">
          {renderInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else if (m[3]) {
      out.push(
        <em key={key}>{renderInline(token.slice(1, -1), key)}</em>,
      );
    } else if (m[4]) {
      const label = token.slice(1, token.indexOf("]("));
      const url = token.slice(token.indexOf("](") + 2, -1);
      out.push(
        <button
          key={key}
          type="button"
          className="cursor-pointer text-acc underline-offset-2 hover:text-acc-bright hover:underline"
          title={url}
          onClick={() => void openUrl(url)}
        >
          {label}
        </button>,
      );
    } else {
      // m[5]: markdown link with a filesystem-path href — a path pill, never a
      // link. Line number comes from the href suffix, else from the link text
      // (e.g. `[foo.ts:12](/a/foo.ts)`); the tooltip shows the full path.
      const label = token.slice(1, token.indexOf("]("));
      const href = token.slice(token.indexOf("](") + 2, -1);
      const { line: hrefLine } = splitLineSuffix(href);
      const line = hrefLine ?? splitLineSuffix(label).line;
      const path = hrefLine || !line ? href : `${href}:${line}`;
      out.push(<PathPill key={key} path={path} />);
    }
    last = idx + token.length;
  }
  if (last < text.length)
    out.push(...renderTextWithPaths(text.slice(last), `${keyPrefix}-end`));
  return out;
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; text: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  const flushPara = (buf: string[]) => {
    if (buf.length) blocks.push({ kind: "p", text: buf.join("\n") });
    buf.length = 0;
  };
  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(para);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence (or EOF while streaming)
      blocks.push({ kind: "code", text: buf.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(para);
      blocks.push({ kind: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara(para);
      const kind = ul ? "ul" : "ol";
      const re = ul ? /^\s*[-*•]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      blocks.push({ kind, items } as Block);
      continue;
    }
    if (!line.trim()) {
      flushPara(para);
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara(para);
  return blocks;
}

export function OrchestratorMarkdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2.5">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h":
            return (
              <div
                key={i}
                className={`pt-1 font-semibold tracking-[-0.01em] ${b.level <= 2 ? "text-14" : "text-13"}`}
              >
                {renderInline(b.text, `h${i}`)}
              </div>
            );
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-lg border border-line bg-card p-3 font-mono text-11"
              >
                {b.text}
              </pre>
            );
          case "ul":
          case "ol": {
            const Tag = b.kind === "ul" ? "ul" : "ol";
            return (
              <Tag
                key={i}
                className={`space-y-1 pl-5 ${b.kind === "ul" ? "list-disc" : "list-decimal"}`}
              >
                {b.items.map((item, j) => (
                  <li key={j} className="break-words pl-0.5">
                    {renderInline(item, `${i}-${j}`)}
                  </li>
                ))}
              </Tag>
            );
          }
          default:
            return (
              <p key={i} className="whitespace-pre-wrap break-words">
                {renderInline(b.text, `p${i}`)}
              </p>
            );
        }
      })}
    </div>
  );
}
