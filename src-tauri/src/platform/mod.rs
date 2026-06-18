pub mod command;
pub mod fonts;
pub mod ipc;
#[cfg(unix)]
mod ipc_unix;
#[cfg(windows)]
mod ipc_windows;
pub mod paths;
pub mod process;
pub mod pty;
