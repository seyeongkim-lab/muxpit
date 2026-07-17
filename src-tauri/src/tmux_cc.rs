//! tmux control mode (`tmux -CC`) parser.
//!
//! Protocol: line-based text notifications from tmux. Reference:
//! - tmux source: `control.c`, `control-notify.c`
//! - Escape rule: bytes < 0x20 OR `\\` → `\OOO` (three octal digits).
//!   All other bytes (0x20..=0xFF) are sent verbatim.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmuxEvent {
    Begin {
        id: u64,
        time: u64,
        flags: u64,
    },
    End {
        id: u64,
        time: u64,
        flags: u64,
    },
    Error {
        id: u64,
        time: u64,
        flags: u64,
    },
    Output {
        pane_id: String,
        data: Vec<u8>,
    },
    WindowAdd {
        window_id: String,
    },
    WindowClose {
        window_id: String,
    },
    WindowRenamed {
        window_id: String,
        name: String,
    },
    WindowPaneChanged {
        window_id: String,
        pane_id: String,
    },
    SessionChanged {
        session_id: String,
        name: String,
    },
    SessionRenamed {
        session_id: String,
        name: String,
    },
    SessionsChanged,
    LayoutChange {
        window_id: String,
        layout: String,
    },
    Exit {
        reason: Option<String>,
    },
    Unknown(String),
    /// Non-notification line (e.g., inside %begin..%end response block or startup banner).
    Data(String),
}

pub struct TmuxCcParser {
    buf: Vec<u8>,
}

impl TmuxCcParser {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Feed raw bytes; returns all complete events produced.
    pub fn feed(&mut self, input: &[u8]) -> Vec<TmuxEvent> {
        self.buf.extend_from_slice(input);
        let mut events = Vec::new();
        loop {
            let Some(pos) = self.buf.iter().position(|&b| b == b'\n') else {
                break;
            };
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line_str = String::from_utf8_lossy(&line).into_owned();
            events.push(parse_line(&line_str));
        }
        events
    }
}

impl Default for TmuxCcParser {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_line(line: &str) -> TmuxEvent {
    if !line.starts_with('%') {
        return TmuxEvent::Data(line.to_string());
    }
    let rest = &line[1..];
    let (tag, args) = match rest.find(' ') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };

    match tag {
        "begin" | "end" | "error" => {
            parse_bracket(tag, args).unwrap_or_else(|| TmuxEvent::Unknown(line.to_string()))
        }
        "output" => parse_output(args).unwrap_or_else(|| TmuxEvent::Unknown(line.to_string())),
        "window-add" => TmuxEvent::WindowAdd {
            window_id: args.to_string(),
        },
        "window-close" => TmuxEvent::WindowClose {
            window_id: args.to_string(),
        },
        "window-renamed" => split_two(args)
            .map(|(wid, name)| TmuxEvent::WindowRenamed {
                window_id: wid.to_string(),
                name: name.to_string(),
            })
            .unwrap_or_else(|| TmuxEvent::Unknown(line.to_string())),
        "window-pane-changed" => split_two(args)
            .map(|(wid, pid)| TmuxEvent::WindowPaneChanged {
                window_id: wid.to_string(),
                pane_id: pid.to_string(),
            })
            .unwrap_or_else(|| TmuxEvent::Unknown(line.to_string())),
        "session-changed" => split_two(args)
            .map(|(sid, name)| TmuxEvent::SessionChanged {
                session_id: sid.to_string(),
                name: name.to_string(),
            })
            .unwrap_or_else(|| TmuxEvent::Unknown(line.to_string())),
        "session-renamed" => split_two(args)
            .map(|(sid, name)| TmuxEvent::SessionRenamed {
                session_id: sid.to_string(),
                name: name.to_string(),
            })
            .unwrap_or_else(|| TmuxEvent::Unknown(line.to_string())),
        "sessions-changed" => TmuxEvent::SessionsChanged,
        "layout-change" => split_two(args)
            .map(|(wid, layout)| TmuxEvent::LayoutChange {
                window_id: wid.to_string(),
                layout: layout.to_string(),
            })
            .unwrap_or_else(|| TmuxEvent::Unknown(line.to_string())),
        "exit" => TmuxEvent::Exit {
            reason: if args.is_empty() {
                None
            } else {
                Some(args.to_string())
            },
        },
        _ => TmuxEvent::Unknown(line.to_string()),
    }
}

fn split_two(s: &str) -> Option<(&str, &str)> {
    let i = s.find(' ')?;
    Some((&s[..i], &s[i + 1..]))
}

fn parse_bracket(tag: &str, args: &str) -> Option<TmuxEvent> {
    // tmux format: `%{begin,end,error} <time> <number> <flags>`
    let parts: Vec<&str> = args.split_whitespace().collect();
    if parts.len() < 3 {
        return None;
    }
    let time = parts[0].parse().ok()?;
    let id = parts[1].parse().ok()?;
    let flags = parts[2].parse().ok()?;
    Some(match tag {
        "begin" => TmuxEvent::Begin { id, time, flags },
        "end" => TmuxEvent::End { id, time, flags },
        "error" => TmuxEvent::Error { id, time, flags },
        _ => unreachable!(),
    })
}

fn parse_output(args: &str) -> Option<TmuxEvent> {
    let (pane, data) = split_two(args)?;
    if !pane.starts_with('%') {
        return None;
    }
    Some(TmuxEvent::Output {
        pane_id: pane.to_string(),
        data: decode_octal_escapes(data),
    })
}

/// Decode tmux's `\OOO` three-digit octal escape sequences.
/// - `\` followed by 3 octal digits (0-7) → single byte
/// - otherwise bytes pass through unchanged
fn decode_octal_escapes(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() {
            let a = bytes[i + 1];
            let b = bytes[i + 2];
            let c = bytes[i + 3];
            if is_oct(a) && is_oct(b) && is_oct(c) {
                let val = ((a - b'0') << 6) | ((b - b'0') << 3) | (c - b'0');
                out.push(val);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

fn is_oct(b: u8) -> bool {
    (b'0'..=b'7').contains(&b)
}

/// Quote `s` for use as a literal argument to `tmux send-keys -l`.
/// Uses POSIX single-quote escape: `'` → `'\''`, wrap in `'…'`.
pub fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_with_space_and_newline() {
        let mut p = TmuxCcParser::new();
        let events = p.feed(b"%output %0 hello\\040world\\012\n");
        assert_eq!(events.len(), 1);
        match &events[0] {
            TmuxEvent::Output { pane_id, data } => {
                assert_eq!(pane_id, "%0");
                assert_eq!(data, b"hello world\n");
            }
            other => panic!("wrong event: {other:?}"),
        }
    }

    #[test]
    fn begin_end_pair() {
        let mut p = TmuxCcParser::new();
        let events = p.feed(b"%begin 1700000000 42 0\n%end 1700000000 42 0\n");
        assert_eq!(events.len(), 2);
        assert!(matches!(
            events[0],
            TmuxEvent::Begin {
                id: 42,
                flags: 0,
                ..
            }
        ));
        assert!(matches!(events[1], TmuxEvent::End { id: 42, .. }));
    }

    #[test]
    fn window_add() {
        let mut p = TmuxCcParser::new();
        let events = p.feed(b"%window-add @3\n");
        match &events[0] {
            TmuxEvent::WindowAdd { window_id } => assert_eq!(window_id, "@3"),
            other => panic!("wrong: {other:?}"),
        }
    }

    #[test]
    fn session_changed() {
        let mut p = TmuxCcParser::new();
        let events = p.feed(b"%session-changed $0 muxpit-host\n");
        match &events[0] {
            TmuxEvent::SessionChanged { session_id, name } => {
                assert_eq!(session_id, "$0");
                assert_eq!(name, "muxpit-host");
            }
            other => panic!("wrong: {other:?}"),
        }
    }

    #[test]
    fn streaming_partial_line() {
        let mut p = TmuxCcParser::new();
        assert!(p.feed(b"%window-").is_empty());
        assert!(p.feed(b"add ").is_empty());
        let events = p.feed(b"@5\n");
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], TmuxEvent::WindowAdd { window_id } if window_id == "@5"));
    }

    #[test]
    fn decode_backslash_byte() {
        // tmux sends literal '\' as \134 (octal 134 = decimal 92 = '\\')
        assert_eq!(decode_octal_escapes("\\134"), b"\\");
    }

    #[test]
    fn decode_esc_and_nl() {
        // \033 = ESC, \012 = LF
        assert_eq!(decode_octal_escapes("\\033[0m\\012"), b"\x1b[0m\n");
    }

    #[test]
    fn decode_passthrough_printable() {
        assert_eq!(decode_octal_escapes("abc $%!"), b"abc $%!");
    }

    #[test]
    fn exit_with_and_without_reason() {
        let mut p = TmuxCcParser::new();
        let events = p.feed(b"%exit\n%exit server exited\n");
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], TmuxEvent::Exit { reason: None }));
        assert!(matches!(&events[1], TmuxEvent::Exit { reason: Some(r) } if r == "server exited"));
    }

    #[test]
    fn shell_single_quote_normal() {
        assert_eq!(shell_single_quote("hello"), "'hello'");
    }

    #[test]
    fn shell_single_quote_with_apostrophe() {
        assert_eq!(shell_single_quote("can't"), "'can'\\''t'");
    }

    #[test]
    fn unknown_notification_preserved() {
        let mut p = TmuxCcParser::new();
        let events = p.feed(b"%paste-buffer-changed buffer0\n");
        assert!(matches!(&events[0], TmuxEvent::Unknown(s) if s.contains("paste-buffer-changed")));
    }
}
