use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const CONTROL_RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct ControlReply {
    data: Option<Value>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlRequestEvent<'a> {
    request_id: String,
    action: &'a str,
    params: Value,
}

#[derive(Default)]
pub struct ControlBroker {
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, mpsc::Sender<ControlReply>>>,
}

impl ControlBroker {
    fn register(&self) -> (String, mpsc::Receiver<ControlReply>) {
        let request_id = format!("control-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .unwrap()
            .insert(request_id.clone(), sender);
        (request_id, receiver)
    }

    pub fn resolve(
        &self,
        request_id: &str,
        data: Option<Value>,
        error: Option<String>,
    ) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .unwrap()
            .remove(request_id)
            .ok_or_else(|| "Unknown or expired control request".to_string())?;
        sender
            .send(ControlReply { data, error })
            .map_err(|_| "Control request receiver closed".to_string())
    }

    fn expire(&self, request_id: &str) {
        self.pending.lock().unwrap().remove(request_id);
    }
}

pub fn dispatch(app: &AppHandle, action: &str, params: Value) -> Result<Value, String> {
    let broker = app.state::<ControlBroker>();
    let (request_id, receiver) = broker.register();
    let payload = ControlRequestEvent {
        request_id: request_id.clone(),
        action,
        params,
    };
    if let Err(error) = app.emit("wmux-control-request", payload) {
        broker.expire(&request_id);
        return Err(format!("Failed to dispatch control request: {error}"));
    }

    match receiver.recv_timeout(CONTROL_RESPONSE_TIMEOUT) {
        Ok(reply) => match reply.error {
            Some(error) => Err(error),
            None => Ok(reply.data.unwrap_or(Value::Null)),
        },
        Err(mpsc::RecvTimeoutError::Timeout) => {
            broker.expire(&request_id);
            Err("Control request timed out".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            broker.expire(&request_id);
            Err("Control request channel closed".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broker_resolves_registered_request_once() {
        let broker = ControlBroker::default();
        let (request_id, receiver) = broker.register();

        broker
            .resolve(&request_id, Some(serde_json::json!({ "ok": true })), None)
            .unwrap();
        assert_eq!(receiver.recv().unwrap().data.unwrap()["ok"], true);
        assert!(broker.resolve(&request_id, None, None).is_err());
    }
}
