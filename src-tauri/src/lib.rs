mod shell_quote;

#[cfg(not(mobile))]
include!("desktop_impl.rs");

#[cfg(mobile)]
mod mobile_agent;

#[cfg(mobile)]
pub use mobile_agent::run;
