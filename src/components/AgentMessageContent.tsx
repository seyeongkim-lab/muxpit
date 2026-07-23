// Message-body renderers shared by the desktop AI workbench and the mobile
// app, so assistant markdown and collapsible tool output behave the same on
// both surfaces.

import { memo, useMemo, type ReactNode } from "react";
import { parseMarkdown, type MarkdownInline } from "../utils/markdown.ts";
import { parseFileLink } from "../utils/fileLink.ts";
import { CodeHighlight } from "./CodeHighlight.tsx";

const TOOL_COLLAPSE_LINES = 5;
const TOOL_COLLAPSE_CHARS = 400;

const renderMarkdownInline = (
  nodes: MarkdownInline[],
  keyPrefix: string,
  onOpenFile?: (path: string) => void,
): ReactNode[] =>
  nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "code": {
        // Path-looking inline code opens the file viewer when the surface
        // provides a handler (desktop workbench); elsewhere it stays plain.
        const link = onOpenFile ? parseFileLink(node.text) : null;
        return link ? (
          <code
            key={key}
            className="agent-md-file"
            role="link"
            title={`Open ${link.path}`}
            onClick={() => onOpenFile!(link.path)}
          >{node.text}</code>
        ) : (
          <code key={key}>{node.text}</code>
        );
      }
      case "strong":
        return <strong key={key}>{renderMarkdownInline(node.children, key, onOpenFile)}</strong>;
      case "em":
        return <em key={key}>{renderMarkdownInline(node.children, key, onOpenFile)}</em>;
      case "link":
        // Rendered inert on purpose: navigating the app webview away to an
        // arbitrary URL from model output would replace the whole UI.
        return <span key={key} className="agent-md-link" title={node.href}>{node.text}</span>;
      default:
        return <span key={key}>{node.text}</span>;
    }
  });

export const MarkdownContent = memo(({ text, onOpenFile, highlightCode }: {
  text: string;
  onOpenFile?: (path: string) => void;
  highlightCode?: boolean;
}) => {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="agent-md">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "codeBlock":
            return (
              <pre key={index}>
                <code>
                  {highlightCode
                    ? <CodeHighlight code={block.text} language={block.language || null} />
                    : block.text}
                </code>
              </pre>
            );
          case "heading":
            return (
              <p key={index} className={`agent-md-heading agent-md-h${Math.min(block.level, 4)}`}>
                {renderMarkdownInline(block.children, `${index}`, onOpenFile)}
              </p>
            );
          case "list": {
            const items = block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{renderMarkdownInline(item, `${index}-${itemIndex}`, onOpenFile)}</li>
            ));
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
          default:
            return <p key={index}>{renderMarkdownInline(block.children, `${index}`, onOpenFile)}</p>;
        }
      })}
    </div>
  );
});

export const ToolOutput = ({ text }: { text: string }) => {
  const lines = text.split("\n");
  if (lines.length <= TOOL_COLLAPSE_LINES && text.length <= TOOL_COLLAPSE_CHARS) {
    return <pre>{text}</pre>;
  }
  const preview = lines.find((line) => line.trim())?.slice(0, 120) ?? "output";
  return (
    <details className="agent-tool-details">
      <summary>{`${preview} · ${lines.length} lines`}</summary>
      <pre>{text}</pre>
    </details>
  );
};
