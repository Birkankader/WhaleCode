use serde::Serialize;
use specta::Type;

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum OutputEvent {
    Stdout(String),
    Stderr(String),
    Exit(i32),
    Error(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdout_serializes_correctly() {
        let event = OutputEvent::Stdout("hello".to_string());
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"event":"stdout","data":"hello"}"#);
    }

    #[test]
    fn exit_serializes_correctly() {
        let event = OutputEvent::Exit(0);
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"event":"exit","data":0}"#);
    }

    #[test]
    fn stderr_serializes_correctly() {
        let event = OutputEvent::Stderr("error msg".to_string());
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"event":"stderr","data":"error msg"}"#);
    }

    #[test]
    fn error_serializes_correctly() {
        let event = OutputEvent::Error("fatal".to_string());
        let json = serde_json::to_string(&event).unwrap();
        assert_eq!(json, r#"{"event":"error","data":"fatal"}"#);
    }
}
