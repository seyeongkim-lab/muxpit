import { useState } from "react";
import { useSshHostsStore, buildSshCommand, type SshHost } from "../stores/sshHosts";

interface SshHostPanelProps {
  open: boolean;
  onClose: () => void;
  onConnect?: (host: SshHost) => void;
}

const EMPTY_FORM = {
  name: "",
  user: "",
  host: "",
  port: 22,
  keyPath: "",
  color: "",
  persistMode: false,
};

export const SshHostPanel = ({ open, onClose, onConnect }: SshHostPanelProps) => {
  const { hosts, addHost, updateHost, removeHost } = useSshHostsStore();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  if (!open) return null;

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowForm(false);
  };

  const handleSubmit = () => {
    if (!form.name.trim() || !form.user.trim() || !form.host.trim()) return;

    const data = {
      name: form.name.trim(),
      user: form.user.trim(),
      host: form.host.trim(),
      port: form.port || 22,
      keyPath: form.keyPath.trim() || undefined,
      color: form.color.trim() || undefined,
      persistMode: form.persistMode,
    };

    if (editingId) {
      updateHost(editingId, data);
    } else {
      addHost(data);
    }
    resetForm();
  };

  const handleEdit = (host: SshHost) => {
    setForm({
      name: host.name,
      user: host.user,
      host: host.host,
      port: host.port,
      keyPath: host.keyPath ?? "",
      color: host.color ?? "",
      persistMode: host.persistMode ?? false,
    });
    setEditingId(host.id);
    setShowForm(true);
  };

  const handleDelete = (id: string) => {
    removeHost(id);
    if (editingId === id) resetForm();
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <span style={styles.title}>SSH Hosts</span>
          <button onClick={onClose} style={styles.closeBtn}>x</button>
        </div>

        <div style={styles.content}>
          {/* Host list */}
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <label style={styles.label}>Registered Hosts</label>
              {!showForm && (
                <button onClick={() => { resetForm(); setShowForm(true); }} style={styles.addBtn}>
                  + Add
                </button>
              )}
            </div>

            {hosts.length === 0 && !showForm && (
              <div style={styles.empty}>No hosts registered. Click "+ Add" to get started.</div>
            )}

            {hosts.map((host) => (
              <div key={host.id} style={styles.hostItem}>
                <div style={styles.hostMain}>
                  {host.color && (
                    <span style={{ ...styles.colorDot, backgroundColor: host.color }} />
                  )}
                  <div style={styles.hostInfo}>
                    <span style={styles.hostName}>{host.name}</span>
                    <span style={styles.hostAddr}>{host.user}@{host.host}{host.port !== 22 ? `:${host.port}` : ""}</span>
                  </div>
                </div>
                <div style={styles.hostActions}>
                  {onConnect && (
                    <button onClick={() => onConnect(host)} style={styles.connectBtn} title="Connect">
                      &gt;_
                    </button>
                  )}
                  <button onClick={() => handleEdit(host)} style={styles.actionBtn} title="Edit">
                    E
                  </button>
                  <button onClick={() => handleDelete(host.id)} style={styles.deleteBtn} title="Delete">
                    x
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Add/Edit form */}
          {showForm && (
            <div style={styles.section}>
              <label style={styles.label}>{editingId ? "Edit Host" : "New Host"}</label>

              <div style={styles.formGrid}>
                <div style={styles.field}>
                  <label style={styles.fieldLabel}>Name *</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Production Server"
                    style={styles.input}
                    autoFocus
                  />
                </div>

                <div style={styles.fieldRow}>
                  <div style={{ ...styles.field, flex: 1 }}>
                    <label style={styles.fieldLabel}>User *</label>
                    <input
                      value={form.user}
                      onChange={(e) => setForm({ ...form, user: e.target.value })}
                      placeholder="root"
                      style={styles.input}
                    />
                  </div>
                  <div style={{ ...styles.field, flex: 2 }}>
                    <label style={styles.fieldLabel}>Host *</label>
                    <input
                      value={form.host}
                      onChange={(e) => setForm({ ...form, host: e.target.value })}
                      placeholder="192.168.1.100"
                      style={styles.input}
                    />
                  </div>
                  <div style={{ ...styles.field, width: 70 }}>
                    <label style={styles.fieldLabel}>Port</label>
                    <input
                      type="number"
                      value={form.port}
                      onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 22 })}
                      style={styles.input}
                    />
                  </div>
                </div>

                <div style={styles.field}>
                  <label style={styles.fieldLabel}>Key Path</label>
                  <input
                    value={form.keyPath}
                    onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
                    placeholder="~/.ssh/id_rsa"
                    style={styles.input}
                  />
                </div>

                <div style={styles.field}>
                  <label style={styles.fieldLabel}>Color</label>
                  <div style={styles.colorRow}>
                    {["#89b4fa", "#a6e3a1", "#f38ba8", "#f9e2af", "#94e2d5", "#cba6f7", "#fab387"].map((c) => (
                      <button
                        key={c}
                        onClick={() => setForm({ ...form, color: form.color === c ? "" : c })}
                        style={{
                          ...styles.colorSwatch,
                          backgroundColor: c,
                          ...(form.color === c ? styles.colorSwatchActive : {}),
                        }}
                      />
                    ))}
                  </div>
                </div>

                <label style={styles.toggleRow}>
                  <input
                    type="checkbox"
                    checked={form.persistMode}
                    onChange={(e) => setForm({ ...form, persistMode: e.target.checked })}
                  />
                  <span style={styles.toggleLabel}>Persist session via tmux</span>
                  <span style={styles.toggleHint}>
                    Requires tmux 3.2+ on the remote. Session survives disconnects.
                  </span>
                </label>
              </div>

              {/* Preview */}
              {form.user && form.host && (
                <div style={styles.preview}>
                  <span style={styles.previewLabel}>Command:</span>
                  <code style={styles.previewCmd}>
                    {buildSshCommand({
                      id: "",
                      name: form.name,
                      user: form.user,
                      host: form.host,
                      port: form.port || 22,
                      keyPath: form.keyPath || undefined,
                    })}
                  </code>
                </div>
              )}

              <div style={styles.formActions}>
                <button onClick={resetForm} style={styles.cancelBtn}>Cancel</button>
                <button
                  onClick={handleSubmit}
                  style={{
                    ...styles.saveBtn,
                    opacity: form.name.trim() && form.user.trim() && form.host.trim() ? 1 : 0.5,
                  }}
                  disabled={!form.name.trim() || !form.user.trim() || !form.host.trim()}
                >
                  {editingId ? "Update" : "Add Host"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.4)",
    zIndex: 100,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  panel: {
    width: 480,
    maxHeight: "85vh",
    backgroundColor: "#181825",
    border: "1px solid #313244",
    borderRadius: 8,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #313244",
  },
  title: { color: "#cdd6f4", fontSize: 14, fontWeight: 600 },
  closeBtn: { background: "none", border: "none", color: "#a6adc8", fontSize: 16, cursor: "pointer" },
  content: { padding: 16, overflowY: "auto" as const, flex: 1 },
  section: { marginBottom: 16 },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  label: { color: "#a6adc8", fontSize: 12, fontWeight: 600 },
  addBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#89b4fa",
    fontSize: 11,
    padding: "3px 8px",
    cursor: "pointer",
  },
  empty: { color: "#585b70", fontSize: 12, padding: "16px 0", textAlign: "center" as const },

  // Host list item
  hostItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    borderRadius: 4,
    backgroundColor: "#1e1e2e",
    marginBottom: 4,
    border: "1px solid transparent",
  },
  hostMain: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
  },
  colorDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  hostInfo: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 1,
    minWidth: 0,
  },
  hostName: {
    color: "#cdd6f4",
    fontSize: 13,
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  hostAddr: {
    color: "#585b70",
    fontSize: 11,
    fontFamily: "monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  hostActions: {
    display: "flex",
    gap: 4,
    flexShrink: 0,
    marginLeft: 8,
  },
  connectBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 3,
    color: "#a6e3a1",
    fontSize: 11,
    padding: "2px 6px",
    cursor: "pointer",
    fontFamily: "monospace",
  },
  actionBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 3,
    color: "#a6adc8",
    fontSize: 11,
    padding: "2px 6px",
    cursor: "pointer",
  },
  deleteBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 3,
    color: "#f38ba8",
    fontSize: 11,
    padding: "2px 6px",
    cursor: "pointer",
  },

  // Form
  formGrid: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  },
  field: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  fieldRow: {
    display: "flex",
    gap: 8,
  },
  fieldLabel: {
    color: "#585b70",
    fontSize: 11,
  },
  input: {
    background: "#313244",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#cdd6f4",
    fontSize: 12,
    padding: "5px 8px",
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  colorRow: {
    display: "flex",
    gap: 6,
    paddingTop: 2,
  },
  colorSwatch: {
    width: 20,
    height: 20,
    borderRadius: "50%",
    border: "2px solid transparent",
    cursor: "pointer",
    padding: 0,
  },
  colorSwatchActive: {
    borderColor: "#cdd6f4",
  },
  preview: {
    marginTop: 10,
    padding: "6px 8px",
    backgroundColor: "#1e1e2e",
    borderRadius: 4,
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  previewLabel: {
    color: "#585b70",
    fontSize: 11,
    flexShrink: 0,
  },
  previewCmd: {
    color: "#a6e3a1",
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  formActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 12,
  },
  cancelBtn: {
    background: "none",
    border: "1px solid #45475a",
    borderRadius: 4,
    color: "#a6adc8",
    fontSize: 12,
    padding: "5px 12px",
    cursor: "pointer",
  },
  saveBtn: {
    background: "#89b4fa",
    border: "none",
    borderRadius: 4,
    color: "#1e1e2e",
    fontSize: 12,
    fontWeight: 600,
    padding: "5px 16px",
    cursor: "pointer",
  },
  toggleRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap" as const,
    cursor: "pointer",
    paddingTop: 4,
  },
  toggleLabel: {
    color: "#cdd6f4",
    fontSize: 12,
  },
  toggleHint: {
    color: "#585b70",
    fontSize: 10,
    flexBasis: "100%",
    marginLeft: 20,
  },
};
