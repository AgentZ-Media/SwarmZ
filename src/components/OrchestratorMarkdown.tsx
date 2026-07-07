// Tiny dependency-free markdown renderer for orchestrator assistant messages
// (OrchestratorPanel.tsx). Deliberately a small subset — headings, lists,
// fenced code, inline code/bold/italic, links — rendered as React nodes (no
// innerHTML, so model output can never inject markup). Unclosed markers in a
// still-streaming message simply render literally until the closing half
// arrives; the next batched store write re-parses the whole text.

import type { ReactNode } from "react";
import { openUrl } from "@/lib/transport";

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (m[1]) {
      out.push(
        <code
          key={key}
          className="rounded border border-border bg-secondary px-1 py-px font-mono text-[11px]"
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
    } else {
      const label = token.slice(1, token.indexOf("]("));
      const url = token.slice(token.indexOf("](") + 2, -1);
      out.push(
        <button
          key={key}
          type="button"
          className="cursor-pointer text-ring underline-offset-2 hover:underline"
          title={url}
          onClick={() => void openUrl(url)}
        >
          {label}
        </button>,
      );
    }
    last = idx + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
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
    <div className="space-y-1.5">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h":
            return (
              <div
                key={i}
                className={`font-semibold tracking-tight ${b.level <= 2 ? "text-[13px]" : "text-xs"}`}
              >
                {renderInline(b.text, `h${i}`)}
              </div>
            );
          case "code":
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-md border border-border bg-card p-2 font-mono text-[11px] leading-relaxed"
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
                className={`space-y-0.5 pl-4 ${b.kind === "ul" ? "list-disc" : "list-decimal"}`}
              >
                {b.items.map((item, j) => (
                  <li key={j} className="break-words">
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
