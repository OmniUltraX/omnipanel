fn main() {
    let source = std::sync::Arc::new(omnipanel_agent_trae::TraeSource::new(
        omnipanel_agent_trae::TraeRegion::Cn,
    ));
    if let Err(err) = omnipanel_agent_session::serve(source) {
        eprintln!("trae sidecar: {err}");
        std::process::exit(1);
    }
}
