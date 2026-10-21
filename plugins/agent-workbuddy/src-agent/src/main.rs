mod workbuddy;

fn main() {
    let source = std::sync::Arc::new(workbuddy::WorkBuddySource::new());
    if let Err(err) = omnipanel_agent_session::serve(source) {
        eprintln!("workbuddy sidecar: {err}");
        std::process::exit(1);
    }
}
