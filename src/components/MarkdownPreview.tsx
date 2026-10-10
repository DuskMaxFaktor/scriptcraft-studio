import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PluggableList } from 'unified';
import { useTheme } from '../theme.ts';

// KaTeX (formulas, ~300 KB with its styles) loads only for text that has $...$ in it
type MathPlugins = { remark: PluggableList; rehype: PluggableList };
let mathPlugins: MathPlugins | null = null;
let mathLoading: Promise<MathPlugins> | null = null;
function loadMath(): Promise<MathPlugins> {
  mathLoading ??= Promise.all([import('remark-math'), import('rehype-katex'), import('katex/dist/katex.min.css')]).then(([rm, rk]) => {
    mathPlugins = { remark: [rm.default], rehype: [rk.default] };
    return mathPlugins;
  });
  return mathLoading;
}
const hasMath = (s: string) => /\$[^$\n]+\$|\$\$/.test(s);

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
  const needMath = hasMath(content);
  const [math, setMath] = useState<MathPlugins | null>(mathPlugins);
  useEffect(() => {
    if (needMath && !math) {
      let alive = true;
      void loadMath().then((m) => alive && setMath(m));
      return () => {
        alive = false;
      };
    }
  }, [needMath]);
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
    <div className={`chat-md md-preview ${className || ''}`} data-md-preview data-md-math={needMath ? (math ? 'ready' : 'loading') : 'none'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, ...(needMath && math ? math.remark : [])]}
        rehypePlugins={needMath && math ? math.rehype : []}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

export { previewToHtml } from '../utils/markdownHtml.ts';
