pub mod bus;
/// Delivery of events to the modules that declared a subscription to them.
/// Until this module existed, `subscribed_events` was stored, displayed, and
/// read by nothing - see its preamble.
pub mod dispatch;
pub mod types;
pub use bus::{EventBus, EventEnvelope, EventMeta};
pub use types::AppEvent;
