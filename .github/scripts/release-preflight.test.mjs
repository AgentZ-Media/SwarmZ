import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPreflight } from "./release-preflight.mjs";

function fixture(version = "1.1.0") {
  const root = mkdtempSync(join(tmpdir(), "swarmz-release-"));
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  mkdirSync(join(root, "docs/release-notes"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "src-tauri/Cargo.toml"), `[package]\nname = "swarmz"\nversion = "${version}"\n`);
  writeFileSync(join(root, `docs/release-notes/v${version}.md`), `# v${version} — Release\n\n${"Complete release notes. ".repeat(5)}`);
  writeFileSync(join(root, "docs/release-notes/_install_footer.md"), `---\n\n${"Complete installation instructions. ".repeat(4)}`);
  return root;
}

test("accepts an exact stable tag, three matching manifests and real notes", () => {
  assert.deepEqual(runPreflight("v1.1.0", fixture()), {
    tag: "v1.1.0",
    version: "1.1.0",
    notesRelative: "docs/release-notes/v1.1.0.md",
  });
});

test("rejects non-stable and leading-zero tags", () => {
  const root = fixture();
  for (const tag of ["1.1.0", "v1.1", "v1.1.0-rc.1", "v01.1.0"]) {
    assert.throws(() => runPreflight(tag, root), /stable vMAJOR\.MINOR\.PATCH/);
  }
});

test("rejects a mismatch in every authoritative version source", () => {
  for (const source of ["package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"]) {
    const root = fixture();
    const path = join(root, source);
    const current = readFileSync(path, "utf8");
    writeFileSync(path, current.replace("1.1.0", "1.0.3"));
    assert.throws(() => runPreflight("v1.1.0", root), new RegExp(source.replaceAll(".", "\\.")));
  }
});

test("rejects missing, placeholder and symlinked release notes", () => {
  const missing = fixture();
  unlinkSync(join(missing, "docs/release-notes/v1.1.0.md"));
  assert.throws(() => runPreflight("v1.1.0", missing), /release-notes\/v1\.1\.0\.md/);

  const placeholder = fixture();
  writeFileSync(join(placeholder, "docs/release-notes/v1.1.0.md"), "# v1.1.0\nTODO");
  assert.throws(() => runPreflight("v1.1.0", placeholder), /placeholder/);

  const symlinked = fixture();
  const notes = join(symlinked, "docs/release-notes/v1.1.0.md");
  const target = join(symlinked, "real-notes.md");
  writeFileSync(target, `# v1.1.0\n${"notes ".repeat(20)}`);
  writeFileSync(notes, "");
  unlinkSync(notes);
  symlinkSync(target, notes);
  assert.throws(() => runPreflight("v1.1.0", symlinked), /non-symlink/);
});
