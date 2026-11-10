fn main() {
    // The unit-test harness has no application manifest, so Windows loads
    // Common Controls 5, which does not export TaskDialogIndirect. Delay-load
    // that import so `cargo test` can start. The app manifest still binds v6.
    println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
    println!("cargo:rustc-link-arg=delayimp.lib");
    tauri_build::build()
}
