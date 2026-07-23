// Message-body renderers shared by the desktop AI workbench and the mobile
// app, so assistant markdown and collapsible tool output behave the same on
// both surfaces.

import { memo, useMemo, type ReactNode } from "react";
import { parseMarkdown, type MarkdownInline } from "../utils/markdown.ts";
import { parseFileLink } from "../utils/fileLink.ts";
import { TODO_GLYPHS, todoItems, toolDiff, toolSummary } from "../utils/toolCall.ts";
import type { MobileToolCall } from "../mobile/agentProtocol.ts";
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
            const items = block.items.map((item, itemIndex) => {
              const sub = item.sub;
              const subItems = sub?.items.map((subItem, subIndex) => (
                <li key={subIndex}>
                  {renderMarkdownInline(subItem, `${index}-${itemIndex}-${subIndex}`, onOpenFile)}
                </li>
              ));
              return (
                <li key={itemIndex}>
                  {renderMarkdownInline(item.children, `${index}-${itemIndex}`, onOpenFile)}
                  {sub && subItems ? (sub.ordered ? <ol>{subItems}</ol> : <ul>{subItems}</ul>) : null}
                </li>
              );
            });
            return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
          }
          case "blockquote":
            return (
              <blockquote key={index}>
                {renderMarkdownInline(block.children, `${index}`, onOpenFile)}
              </blockquote>
            );
          case "table":
            return (
              <table key={index}>
                <thead>
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th key={cellIndex}>
                        {renderMarkdownInline(cell, `${index}-h-${cellIndex}`, onOpenFile)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>
                          {renderMarkdownInline(cell, `${index}-${rowIndex}-${cellIndex}`, onOpenFile)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
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

// Rich tool-call body: the CLI-style one-liner, an Edit/Write diff or a
// TodoWrite checklist when the input carries one, and the paired result
// collapsed underneath. Falls back to the raw text when nothing structured
// is available (unknown tools, oversized inputs, codex/acp providers).
export const ToolCallContent = ({ tool, fallbackText }: {
  tool: MobileToolCall;
  fallbackText: string;
}) => {
  const summary = toolSummary(tool.name, tool.input);
  const diff = toolDiff(tool.name, tool.input);
  const todos = todoItems(tool.name, tool.input);
  return (
    <div className="agent-tool-call">
      {summary ? <code className="agent-tool-call-summary">{summary}</code> : null}
      {diff ? (
        <pre className="agent-tool-call-diff">
          {diff.removed.map((line, index) => (
            <span key={`r-${index}`} className="removed">{`- ${line}\n`}</span>
          ))}
          {diff.added.map((line, index) => (
            <span key={`a-${index}`} className="added">{`+ ${line}\n`}</span>
          ))}
        </pre>
      ) : null}
      {todos ? (
        <ul className="agent-tool-call-todos">
          {todos.map((todo, index) => (
            <li key={index} className={todo.status}>
              <span aria-hidden="true">{TODO_GLYPHS[todo.status]}</span> {todo.content}
            </li>
          ))}
        </ul>
      ) : null}
      {!summary && !diff && !todos ? <ToolOutput text={fallbackText} /> : null}
      {tool.resultText ? (
        <div className={tool.resultError ? "agent-tool-call-result error" : "agent-tool-call-result"}>
          <ToolOutput text={tool.resultText} />
        </div>
      ) : null}
    </div>
  );
};

// Thinking reads as supporting detail: dimmed, italic, collapsed when long.
export const ThinkingOutput = ({ text }: { text: string }) => {
  const lines = text.split("\n");
  if (lines.length <= TOOL_COLLAPSE_LINES && text.length <= TOOL_COLLAPSE_CHARS) {
    return <p className="agent-thinking-text">{text}</p>;
  }
  const preview = lines.find((line) => line.trim())?.slice(0, 120) ?? "thinking";
  return (
    <details className="agent-tool-details agent-thinking-details">
      <summary>{`${preview} · ${lines.length} lines`}</summary>
      <p className="agent-thinking-text">{text}</p>
    </details>
  );
};
