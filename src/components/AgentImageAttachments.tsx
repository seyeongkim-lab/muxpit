import { useRef } from "react";
import {
  agentImageDataUrl,
  type AgentImageAttachment,
} from "../agent/agentImages.ts";
import "./AgentImageAttachments.css";

interface AgentImageAttachmentsProps {
  attachments: readonly AgentImageAttachment[];
  disabled?: boolean;
  onFiles: (files: readonly Blob[]) => void | Promise<void>;
  onRemove: (id: string) => void;
}

export const AgentImageAttachments = ({
  attachments,
  disabled = false,
  onFiles,
  onRemove,
}: AgentImageAttachmentsProps) => {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="agent-image-attachments">
      <button
        type="button"
        className="agent-image-picker"
        disabled={disabled}
        aria-label="Attach images"
        title="Attach images"
        onClick={() => inputRef.current?.click()}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 3.5h11v9h-11zM4 10l2.4-2.4 1.8 1.8 1.4-1.3 2.4 2.4M10.8 6.2h.01" />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length > 0) void onFiles(files);
        }}
      />
      {attachments.map((attachment) => (
        <span className="agent-image-chip" key={attachment.id}>
          <img src={agentImageDataUrl(attachment)} alt={attachment.name} />
          <button
            type="button"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onRemove(attachment.id)}
          >×</button>
        </span>
      ))}
    </div>
  );
};
