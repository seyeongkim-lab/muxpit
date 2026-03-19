import { useState } from "react";

interface BrowserPaneProps {
  url: string;
  id: string;
}

export const BrowserPane = ({ url: initialUrl }: BrowserPaneProps) => {
  const [url, setUrl] = useState(initialUrl);
  const [inputUrl, setInputUrl] = useState(initialUrl);

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    let target = inputUrl.trim();
    if (!target.startsWith("http")) {
      target = "https://" + target;
    }
    setUrl(target);
  };

  return (
    <div style={styles.container}>
      <form onSubmit={handleNavigate} style={styles.urlBar}>
        <button type="button" onClick={() => setUrl(url)} style={styles.navBtn} title="Reload">
          R
        </button>
        <input
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          style={styles.urlInput}
          placeholder="Enter URL..."
        />
        <button type="submit" style={styles.navBtn} title="Go">
          Go
        </button>
      </form>
      <iframe
        src={url}
        style={styles.iframe}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
        title="Browser"
      />
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    backgroundColor: "#1e1e2e",
  },
  urlBar: {
    display: "flex",
    gap: 4,
    padding: "4px 6px",
    backgroundColor: "#181825",
    borderBottom: "1px solid #313244",
    alignItems: "center",
  },
  navBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#a6adc8",
    fontSize: 11,
    padding: "3px 8px",
    cursor: "pointer",
    flexShrink: 0,
  },
  urlInput: {
    flex: 1,
    background: "#313244",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#cdd6f4",
    fontSize: 12,
    padding: "4px 8px",
    outline: "none",
    fontFamily: "monospace",
  },
  iframe: {
    flex: 1,
    border: "none",
    backgroundColor: "#fff",
  },
};
