fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    // Localhost only by default; a remote bind must be a deliberate opt-in.
    let host = std::env::var("CODEX_SWITCHER_WEB_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("CODEX_SWITCHER_WEB_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3210);
    let token = std::env::var("CODEX_SWITCHER_WEB_TOKEN")
        .map_err(|_| anyhow::anyhow!("Set CODEX_SWITCHER_WEB_TOKEN to a unique random secret (32+ characters) before starting the server"))?;
    if token.len() < 32 || token.chars().any(char::is_whitespace) {
        anyhow::bail!(
            "CODEX_SWITCHER_WEB_TOKEN must contain at least 32 non-whitespace characters"
        );
    }
    let is_local = matches!(host.as_str(), "127.0.0.1" | "::1" | "localhost");
    if !is_local
        && std::env::var("CODEX_SWITCHER_WEB_ALLOW_REMOTE")
            .ok()
            .as_deref()
            != Some("1")
    {
        anyhow::bail!("Remote bind blocked: set CODEX_SWITCHER_WEB_ALLOW_REMOTE=1 only behind a TLS reverse proxy and firewall");
    }
    codex_switcher_lib::web::run_lan_server(&host, port, &token)
}
