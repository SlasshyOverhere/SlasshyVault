use std::collections::VecDeque;
use std::sync::Mutex;

const MAX_LOG_ENTRIES: usize = 2000;

lazy_static::lazy_static! {
    static ref LOG_BUFFER: Mutex<VecDeque<String>> = Mutex::new(VecDeque::with_capacity(MAX_LOG_ENTRIES));
}

pub fn push(msg: String) {
    if let Ok(mut buf) = LOG_BUFFER.lock() {
        if buf.len() >= MAX_LOG_ENTRIES {
            buf.pop_front();
        }
        buf.push_back(msg);
    }
}

pub fn drain() -> Vec<String> {
    if let Ok(mut buf) = LOG_BUFFER.lock() {
        buf.drain(..).collect()
    } else {
        Vec::new()
    }
}

pub fn clear() {
    if let Ok(mut buf) = LOG_BUFFER.lock() {
        buf.clear();
    }
}

#[macro_export]
macro_rules! dev_log {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        println!("{}", msg);
        $crate::log_buffer::push(msg);
    }};
}

#[macro_export]
macro_rules! dev_elog {
    ($($arg:tt)*) => {{
        let msg = format!($($arg)*);
        eprintln!("{}", msg);
        $crate::log_buffer::push(msg);
    }};
}
