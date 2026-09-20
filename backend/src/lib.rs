//! Durable Cursor-style Projects coordinator sidecar.
//!
//! The sidecar owns project records, shared context, worker dispatch metadata,
//! and subscription definitions. Core remains the execution authority: every
//! coordinator or worker turn goes back through the authenticated
//! `chat.startTurn` kernel capability, so firewall, approvals, routing, and
//! conversation persistence stay in the normal Ryu path.

pub mod api;
pub mod dispatch;
pub mod store;
