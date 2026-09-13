fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-env-changed=STATIC_VCRUNTIME");
        // The workspace already links the complete CRT statically. Tauri's
        // VCRuntime-only defaults would otherwise exclude the static UCRT.
        if std::env::var("CARGO_CFG_TARGET_FEATURE")
            .is_ok_and(|features| features.split(',').any(|feature| feature == "crt-static"))
        {
            std::env::remove_var("STATIC_VCRUNTIME");
        }
        tauri_build::build();
    }
}
