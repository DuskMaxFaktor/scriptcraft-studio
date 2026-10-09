import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { useTheme } from '../theme.ts';

// Rendered preview of a Markdown file (GitHub-flavored), with $math$ / $$math$$ (KaTeX) and
// ```mermaid diagrams. Raw HTML in the source is NOT rendered (react-markdown escapes it by default),
// so a .md file cannot run scripts in the studio. Mermaid runs in "strict" mode (sanitized SVG).
// Relative image paths are resolved against the project's files so local pictures show.

interface Props {
  content: string;
  /** Project id, so relative image paths (./logo.png) load from the project folder */
  projectId?: string;
  className?: string;
}

let mermaidSeq = 0;

/** A ```mermaid block drawn as an SVG diagram (mermaid is loaded only when a diagram is present). */
const MermaidBlock: React.FC<{ code: string }> = ({ code }) => {
  const { theme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'light' ? 'default' : 'dark' });
        const { svg } = await mermaid.render(`sc-mermaid-${++mermaidSeq}`, code);
        if (alive && ref.current) {
          ref.current.innerHTML = svg;
          setError(null);
        }
      } catch (e: any) {
        if (alive) setError(String(e?.message || e).split('\n')[0]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, theme]);

  return (
    <div className="md-mermaid" data-mermaid>
      <div ref={ref} />
      {error && <pre className="text-rose-300 text-[11px] whitespace-pre-wrap">Mermaid: {error}</pre>}
    </div>
  );
};

export const MarkdownPreview: React.FC<Props> = ({ content, projectId, className }) => {
  const rawBase = projectId ? `/api/projects/${encodeURIComponent(projectId)}/raw?path=` : null;
  const resolveSrc = (src?: string) => {
    if (!src) return src;
    if (/^(https?:|data:|blob:)/i.test(src)) return src;
    if (!rawBase) return src;
    // A relative path inside the project
    return rawBase + encodeURIComponent(src.replace(/^\.\//, '').replace(/^\//, ''));
  };

  const components: Components = {
    a: ({ children, href }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    img: ({ src, alt }) => <img src={resolveSrc(typeof src === 'string' ? src : undefined)} alt={alt || ''} loading="lazy" />,
    table: ({ children }) => (
      <div className="chat-md-table">
        <table>{children}</table>
      </div>
    ),
    pre: ({ children }) => {
      const codeEl = React.Children.toArray(children)[0] as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
      if (/language-mermaid/.test(codeEl?.props?.className || '')) {
        return <MermaidBlock code={String(codeEl.props.children ?? '').replace(/\n$/, '')} />;
      }
      return <pre>{children}</pre>;
    },
  };

  return (
    <div className={`chat-md md-preview ${className || ''}`} data-md-preview>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
};

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
