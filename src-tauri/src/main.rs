// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--mcp") {
        filepad_lib::mcp_stdio();
        return;
    }
    if filepad_lib::yield_folder_to_explorer() {
        return;
    }
    filepad_lib::run()
}
