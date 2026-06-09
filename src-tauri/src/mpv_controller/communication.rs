use serde::{Deserialize, Serialize};

/// Incoming message from the JS frontend to the mpv message thread.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InMsg {
    ObserveProp(String),
    SetProp(String, PropVal),
    Command(String, Vec<String>),
}

/// Property values for set operations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum PropVal {
    Bool(bool),
    Num(f64),
    Str(String),
}

/// Map a property name to its mpv Format for observe_property.
pub fn prop_format_from_name(name: &str) -> libmpv2::Format {
    match name {
        "pause" | "buffering" | "seeking" | "eof-reached"
        | "paused-for-cache" | "keepaspect" | "mute"
        | "osc" | "input-default-bindings" | "input-vo-keyboard" => libmpv2::Format::Flag,

        "aid" | "vid" | "sid" => libmpv2::Format::Int64,

        "time-pos" | "duration" | "volume" | "speed"
        | "sub-pos" | "sub-scale" | "sub-delay"
        | "cache-buffering-state" | "demuxer-cache-time" | "panscan" => libmpv2::Format::Double,

        _ => libmpv2::Format::String,
    }
}
