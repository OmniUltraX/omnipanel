mod cursor;
mod pricing;

fn main() {
    let source = std::sync::Arc::new(cursor::CursorSource::new());
    if let Err(err) = omnipanel_agent_session::serve(source) {
        eprintln!("cursor sidecar: {err}");
        std::process::exit(1);
    }
}
