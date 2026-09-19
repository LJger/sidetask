pub mod diagnostics;
pub mod domain;
pub mod geometry;
pub mod model;
pub mod retry;
pub mod store;
pub mod window;

pub type Result<T> = std::result::Result<T, String>;
