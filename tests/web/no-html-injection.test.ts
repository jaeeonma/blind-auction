import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// XSS guard for the demo screens (design.md 17번): values from the API must go into the page as
// text (textContent / text nodes via web/js/dom.js), never parsed as HTML. This fails the build
// as soon as any web/ script uses an HTML-parsing API.

const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
const FORBIDDEN = [/\.innerHTML\b/, /\.outerHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\bcreateContextualFragment\b/];

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : e.name.endsWith(".js") ? [p] : [];
  });
}

describe("web: no HTML injection", () => {
  it("no script in web/ uses innerHTML, outerHTML, insertAdjacentHTML, document.write or createContextualFragment", () => {
    const files = jsFiles(webDir);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => ({ file: path.relative(webDir, file), line: i + 1, text: line.trim() }))
        .filter(({ text }) => !text.startsWith("//") && FORBIDDEN.some((re) => re.test(text))),
    );
    expect(hits).toEqual([]);
  });
});
