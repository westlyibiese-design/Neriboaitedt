import React, { useCallback, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";

/**
 * Renders AI-generated Markdown (headings, bold/italic, lists, tables,
 * fenced code blocks, links, blockquotes, etc.) as properly styled HTML,
 * matching the ChatGPT-style structured look requested for Neribo.
 *
 * This is purely a presentation layer: it does not touch message content,
 * the AI backend, streaming, persistence, or any other app logic. It
 * is used everywhere an AI/assistant message body is displayed (ChatView's
 * message list + streaming preview, and Workspaces' markdown artifact
 * viewer) so formatting stays consistent across the whole app.
 *
 * Table/strikethrough/task-list support comes from remark-gfm; fenced code
 * block syntax highlighting comes from rehype-highlight (styled via the
 * highlight.js theme imported in src/index.css).
 */

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

interface CodeBlockProps {
  className?: string;
  children?: React.ReactNode;
}

function CodeBlock({ className, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const languageMatch = /language-(\w+)/.exec(className || "");
  const language = languageMatch ? languageMatch[1] : "text";
  const codeString = String(children).replace(/\n$/, "");

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(codeString);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable/blocked - fail silently, same as the
      // rest of the app's copy buttons.
    }
  }, [codeString]);

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-neutral-800 bg-[#0a0a0b] not-prose">
      <div className="flex items-center justify-between px-4 py-2 bg-[#151517] border-b border-neutral-800">
        <span className="text-xs font-medium text-neutral-400 select-none">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[13px] leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export default function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={`markdown-body ${className || ""}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-2xl font-semibold text-[var(--card-foreground)] mt-5 mb-2.5 tracking-tight first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-semibold text-[var(--card-foreground)] mt-5 mb-2 tracking-tight first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold text-[var(--card-foreground)] mt-4 mb-2 tracking-tight first:mt-0">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-base font-semibold text-[var(--card-foreground)] mt-3 mb-1.5 first:mt-0">{children}</h4>
          ),
          p: ({ children }) => (
            <p className="text-[15.5px] leading-relaxed text-[var(--card-foreground)] mb-2.5 last:mb-0">{children}</p>
          ),
          strong: ({ children }) => <strong className="font-semibold text-[var(--card-foreground)]">{children}</strong>,
          em: ({ children }) => <em className="italic text-[var(--card-foreground)]">{children}</em>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline decoration-blue-400/40 underline-offset-2 hover:text-blue-300"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 space-y-1 mb-2.5 marker:text-[var(--muted-foreground)]">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 space-y-1 mb-2.5 marker:text-[var(--muted-foreground)]">{children}</ol>
          ),
          li: ({ children }) => <li className="text-[15.5px] leading-relaxed text-[var(--card-foreground)] pl-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[var(--border)] pl-4 italic text-[var(--muted-foreground)] my-2.5">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-[var(--border)] my-4" />,
          table: ({ children }) => (
            <div className="my-3 w-full overflow-x-auto rounded-lg border border-[var(--border)]">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-[var(--muted)]">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-[var(--border)]">{children}</tbody>,
          tr: ({ children }) => <tr className="divide-x divide-[var(--border)]">{children}</tr>,
          th: ({ children }) => (
            <th className="px-3 py-2 text-left font-semibold text-[var(--card-foreground)] whitespace-nowrap">{children}</th>
          ),
          td: ({ children }) => <td className="px-3 py-2 text-[var(--card-foreground)] align-top">{children}</td>,
          // react-markdown v10 no longer passes an `inline` flag to `code`;
          // fenced code blocks are the only case where remark attaches a
          // `language-xxx` className, so that's used to tell block code
          // apart from inline `code` spans.
          code: ({ className, children, ...props }: any) => {
            const isBlock = /language-(\w+)/.test(className || "");
            if (!isBlock) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded bg-[var(--muted)] text-[13px] text-rose-500 font-mono"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
          },
          // CodeBlock renders its own <pre>, so unwrap react-markdown's
          // default <pre> wrapper to avoid nesting two of them.
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
