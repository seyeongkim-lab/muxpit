// Prism-based syntax highlighting rendered as React elements. Tokens are
// mapped to spans directly (never innerHTML) so file and model content cannot
// inject markup. Grammar imports are ordered by Prism's own dependency chain:
// clike feeds javascript, javascript feeds typescript/jsx, and so on.

import { memo, useMemo, type ReactNode } from "react";
import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-go";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-markdown";

// The DOM never carries `language-*` classes for Prism to auto-highlight;
// flagging manual documents that and skips the DOMContentLoaded scan.
Prism.manual = true;

// Beyond this size tokenization noticeably blocks the UI thread, and files
// that large are logs rather than code — plain text is the better trade.
const HIGHLIGHT_CHAR_LIMIT = 300_000;

const renderToken = (token: string | Prism.Token, key: number): ReactNode => {
  if (typeof token === "string") return token;
  const alias = Array.isArray(token.alias) ? token.alias.join(" ") : token.alias;
  const content = Array.isArray(token.content)
    ? token.content.map(renderToken)
    : renderToken(token.content as string | Prism.Token, 0);
  return (
    <span key={key} className={`token ${token.type}${alias ? ` ${alias}` : ""}`}>
      {content}
    </span>
  );
};

export const CodeHighlight = memo(({ code, language }: {
  code: string;
  language: string | null;
}) => {
  const tokens = useMemo(() => {
    const grammar = language ? Prism.languages[language] : undefined;
    if (!grammar || code.length > HIGHLIGHT_CHAR_LIMIT) return null;
    try {
      return Prism.tokenize(code, grammar);
    } catch {
      return null;
    }
  }, [code, language]);
  if (!tokens) return <>{code}</>;
  return <>{tokens.map(renderToken)}</>;
});
