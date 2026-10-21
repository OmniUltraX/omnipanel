mod local_opencode;
mod model_metadata;
mod opencode_go;
mod wire_chat;

fn main() {
    let source = std::sync::Arc::new(opencode_go::OpencodeGoSource::new());
    if let Err(err) = omnipanel_agent_session::serve(source) {
        eprintln!("opencode-go sidecar: {err}");
        std::process::exit(1);
    }
}
