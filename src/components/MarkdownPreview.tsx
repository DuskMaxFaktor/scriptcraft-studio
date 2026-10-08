import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Rendered preview of a Markdown file (GitHub-flavored). Raw HTML in the source is NOT rendered
// (react-markdown escapes it by default), so a .md file cannot run scripts in the studio.
// Relative image/link paths are resolved against the project's files so local pictures show.

interface Props {
  content: string;
  /** Project id, so relative image paths (./logo.png) load from the project folder */
  projectId?: string;
  className?: string;
}

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
  };

  return (
    <div className={`chat-md md-preview ${className || ''}`} data-md-preview>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
};
