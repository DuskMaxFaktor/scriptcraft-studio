// The export of a rendered Markdown preview as a standalone .html file. Kept apart from MarkdownPreview
// so the code editor and notebooks can use it without loading the Markdown renderer.

/** A standalone HTML document of the rendered preview (diagrams and formulas included), for export. */
export function previewToHtml(previewEl: Element, title: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/katex.min.css">
<style>
  body { margin: 0; background: #ffffff; color: #1f2937; font: 15px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 24px 64px; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 .5em; }
  h1 { font-size: 1.9em; border-bottom: 1px solid #e5e7eb; padding-bottom: .3em; }
  h2 { font-size: 1.45em; border-bottom: 1px solid #e5e7eb; padding-bottom: .25em; }
  a { color: #4f46e5; }
  code { font-family: "Fira Code", Consolas, monospace; font-size: .9em; background: #f3f4f6; padding: .1em .35em; border-radius: 4px; }
  pre { background: #f6f8fa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { margin: .8em 0; padding: .3em 1em; border-left: 4px solid #6366f1; background: #eef2ff; border-radius: 0 6px 6px 0; }
  table { border-collapse: collapse; margin: .8em 0; }
  th, td { border: 1px solid #d1d5db; padding: .35em .7em; text-align: left; }
  th { background: #f3f4f6; }
  img, svg { max-width: 100%; height: auto; }
  .md-mermaid { margin: 1em 0; text-align: center; }
  ul, ol { padding-left: 1.6em; }
</style>
</head>
<body>
<main>
${previewEl.innerHTML}
</main>
</body>
</html>
`;
}
