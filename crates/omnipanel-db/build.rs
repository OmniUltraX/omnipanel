fn main() {
    println!(
        "cargo:rustc-env=OMNIPANEL_TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );
}
