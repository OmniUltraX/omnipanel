import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type ShellAgentMarkdownProps = {
  text: string;
  className?: string;
};

/** 流内 Shell Agent 卡片的紧凑 Markdown 渲染 */
export function ShellAgentMarkdown({ text, className }: ShellAgentMarkdownProps) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  return (
    <div className={className ?? "term-shell-agent-md"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
        p: ({ children }) => <p className="term-shell-agent-md__p">{children}</p>,
        strong: ({ children }) => (
          <strong className="term-shell-agent-md__strong">{children}</strong>
        ),
        em: ({ children }) => <em className="term-shell-agent-md__em">{children}</em>,
        ul: ({ children }) => <ul className="term-shell-agent-md__ul">{children}</ul>,
        ol: ({ children }) => <ol className="term-shell-agent-md__ol">{children}</ol>,
        li: ({ children }) => <li className="term-shell-agent-md__li">{children}</li>,
        a: ({ href, children }) => (
          <a className="term-shell-agent-md__a" href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        code: ({ className: codeClass, children }) => {
          const isBlock = Boolean(codeClass?.includes("language-"));
          if (isBlock) {
            return (
              <code className={`term-shell-agent-md__code-block ${codeClass ?? ""}`}>
                {children}
              </code>
            );
          }
          return <code className="term-shell-agent-md__code">{children}</code>;
        },
        pre: ({ children }) => <pre className="term-shell-agent-md__pre">{children}</pre>,
      }}
      >
        {trimmed}
      </ReactMarkdown>
    </div>
  );
}
