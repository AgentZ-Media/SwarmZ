// Shared safe Markdown renderer for every conversational surface in SwarmZ.
// `react-markdown` never executes raw HTML; `remark-gfm` adds the structures
// Codex commonly emits (tables, task lists, autolinks and strikethrough).

import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@/lib/transport";
import {
  isPathHref,
  pathPillLabel,
  splitLineSuffix,
  splitTextWithPaths,
} from "@/lib/paths";

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

function renderTextWithPaths(text: string, keyPrefix: string): ReactNode[] {
  const segments = splitTextWithPaths(text);
  return segments.map((segment, index) =>
    segment.path ? (
      <PathPill key={`${keyPrefix}-path-${index}`} path={segment.text} />
    ) : (
      segment.text
    ),
  );
}

/** Recursively add path pills to prose without touching code or links. */
function pathAware(children: ReactNode, keyPrefix: string): ReactNode {
  return Children.toArray(children).flatMap((child, index) => {
    if (typeof child === "string") {
      return renderTextWithPaths(child, `${keyPrefix}-${index}`);
    }
    if (!isValidElement(child) || child.type === "code" || child.type === "a") {
      return child;
    }
    const element = child as ReactElement<{ children?: ReactNode }>;
    if (element.props.children === undefined) return child;
    return cloneElement(element, {
      children: pathAware(element.props.children, `${keyPrefix}-${index}`),
    });
  });
}

function ExternalLink({ href = "", children }: ComponentPropsWithoutRef<"a">) {
  if (isPathHref(href)) {
    const label = Children.toArray(children).join("");
    const { line: hrefLine } = splitLineSuffix(href);
    const line = hrefLine ?? splitLineSuffix(label).line;
    const path = hrefLine || !line ? href : `${href}:${line}`;
    return <PathPill path={path} />;
  }
  if (/^https?:\/\//i.test(href)) {
    return (
      <button
        type="button"
        className="cursor-pointer text-acc underline-offset-2 hover:text-acc-bright hover:underline"
        title={href}
        onClick={() => void openUrl(href)}
      >
        {children}
      </button>
    );
  }
  // Agent output is untrusted. Unknown schemes and relative navigation stay
  // visible but inert instead of navigating the embedded webview.
  return <span title={href || undefined}>{children}</span>;
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="pt-1 text-16 font-semibold tracking-[-0.01em] text-txt">
      {pathAware(children, "h1")}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="pt-1 text-14 font-semibold tracking-[-0.01em] text-txt">
      {pathAware(children, "h2")}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="pt-1 text-13 font-semibold tracking-[-0.01em] text-txt">
      {pathAware(children, "h3")}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="pt-1 text-13 font-semibold text-txt">
      {pathAware(children, "h4")}
    </h4>
  ),
  p: ({ children }) => (
    <p className="whitespace-pre-wrap break-words">{pathAware(children, "p")}</p>
  ),
  ul: ({ children, className }) => (
    <ul className={`space-y-1 pl-5 ${className?.includes("contains-task-list") ? "list-none" : "list-disc"}`}>
      {children}
    </ul>
  ),
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children, className }) => (
    <li className={`${className?.includes("task-list-item") ? "-ml-5 flex items-start gap-2" : "break-words pl-0.5"}`}>
      {pathAware(children, "li")}
    </li>
  ),
  input: (props) => (
    <input {...props} className="mt-1 h-3.5 w-3.5 shrink-0 accent-acc" disabled />
  ),
  blockquote: ({ children }) => (
    <blockquote className="rounded-md bg-pop/55 px-3 py-2 text-mut">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-0 border-t border-line" />,
  a: ExternalLink,
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg border border-line bg-card p-3 font-mono text-11 leading-[1.6] text-mut">
      {children}
    </pre>
  ),
  code: ({ children, className }) => {
    const fenced = Boolean(className);
    return fenced ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded-xs bg-pop px-1 py-px font-mono text-[0.9em] text-txt">
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-left text-12">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-pop text-txt">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-line">{children}</tbody>,
  tr: ({ children }) => <tr className="divide-x divide-line">{children}</tr>,
  th: ({ children }) => (
    <th className="whitespace-nowrap px-3 py-2 font-semibold">
      {pathAware(children, "th")}
    </th>
  ),
  td: ({ children }) => (
    <td className="min-w-32 px-3 py-2 align-top text-mut">
      {pathAware(children, "td")}
    </td>
  ),
  img: ({ alt }) => (
    <span className="rounded-xs border border-line bg-pop px-1.5 py-0.5 font-mono text-11 text-fnt">
      image{alt ? `: ${alt}` : ""}
    </span>
  ),
};

export function OrchestratorMarkdown({ text }: { text: string }) {
  return (
    <div className="space-y-2.5 [&_.contains-task-list]:space-y-1">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
