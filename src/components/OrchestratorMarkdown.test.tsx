import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrchestratorMarkdown } from "./OrchestratorMarkdown";

describe("shared Markdown rendering", () => {
  it("renders GFM structures used by agent and Orchestrator messages", () => {
    const html = renderToStaticMarkup(
      <OrchestratorMarkdown
        text={"## Audit\n\n| Area | State |\n| --- | --- |\n| UI | **fixed** |\n\n- [x] verified\n- ~~old~~"}
      />,
    );
    expect(html).toContain("<h2");
    expect(html).toContain("<table");
    expect(html).toContain("<strong");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>old</del>");
  });

  it("keeps raw HTML inert and renders filesystem links as path pills", () => {
    const html = renderToStaticMarkup(
      <OrchestratorMarkdown text={'<script>alert(1)</script>\n\n[store](/repo/src/store.ts:12)'} />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("store.ts");
    expect(html).toContain(":12");
  });
});
