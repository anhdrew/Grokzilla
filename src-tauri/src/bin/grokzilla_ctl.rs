use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::thread;
use std::time::{Duration, Instant};

fn home() -> PathBuf {
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"))
}

fn data_dir() -> PathBuf {
    home().join("Library/Application Support/ai.grokzilla.app")
}

fn socket_path() -> PathBuf {
    data_dir().join("control.sock")
}

fn token_path() -> PathBuf {
    data_dir().join("control.token")
}

fn usage() -> ! {
    eprint!(
        "\
Grokzilla control CLI for Grok Bot (local-exec).

Usage:
  grokzilla status
  grokzilla projects
  grokzilla threads [--cwd PATH]
  grokzilla open --cwd PATH [--session ID]
  grokzilla new [--cwd PATH]
  grokzilla send [--session ID] [--file PATH] [text...]
  grokzilla stop
  grokzilla permission allow|deny [--option ID]
  grokzilla set-mode ask|plan|auto|yolo
  grokzilla set-model ID
  grokzilla set-effort ID
  grokzilla transcript [--session ID]
  grokzilla wait [--timeout SECS]

Grokzilla.app must be running. Output is JSON.
"
    );
    std::process::exit(2);
}

fn main() -> ExitCode {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help" | "help") {
        usage();
    }
    if args[0] == "launch" {
        return launch();
    }
    let method = args.remove(0);
    let mut params = json!({});
    let mut timeout = 600u64;
    let mut i = 0;
    let mut rest: Vec<String> = Vec::new();
    while i < args.len() {
        match args[i].as_str() {
            "--cwd" => {
                params["cwd"] = json!(next(&args, &mut i));
            }
            "--session" => {
                params["session"] = json!(next(&args, &mut i));
            }
            "--file" => {
                let path = next(&args, &mut i);
                let text = fs::read_to_string(&path).unwrap_or_else(|e| {
                    eprintln!("failed to read {path}: {e}");
                    std::process::exit(1);
                });
                params["text"] = json!(text);
            }
            "--option" => {
                params["option"] = json!(next(&args, &mut i));
            }
            "--timeout" => {
                timeout = next(&args, &mut i).parse().unwrap_or(600);
            }
            "--json" => {}
            flag if flag.starts_with("--") => {
                eprintln!("unknown flag {flag}");
                usage();
            }
            _ => rest.push(args[i].clone()),
        }
        i += 1;
    }
    match method.as_str() {
        "send" => {
            if params.get("text").and_then(Value::as_str).unwrap_or("").is_empty() {
                params["text"] = json!(rest.join(" "));
            }
        }
        "permission" => {
            params["action"] = json!(rest.first().cloned().unwrap_or_default());
        }
        "set-mode" => {
            params["mode"] = json!(rest.first().cloned().unwrap_or_default());
        }
        "set-model" => {
            params["model"] = json!(rest.first().cloned().unwrap_or_default());
        }
        "set-effort" => {
            params["effort"] = json!(rest.first().cloned().unwrap_or_default());
        }
        "wait" => {
            return wait_loop(params, timeout);
        }
        _ => {}
    }
    match rpc(&method, params) {
        Ok(value) => {
            println!("{}", pretty(&value));
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err}");
            ExitCode::from(1)
        }
    }
}

fn next(args: &[String], i: &mut usize) -> String {
    *i += 1;
    args.get(*i).cloned().unwrap_or_else(|| {
        eprintln!("missing value after {}", args.get(*i - 1).map(String::as_str).unwrap_or("flag"));
        std::process::exit(2);
    })
}

fn launch() -> ExitCode {
    let _ = Command::new("open").args(["-a", "Grokzilla"]).status();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if socket_path().exists() {
            if rpc("status", json!({})).is_ok() {
                println!("{}", pretty(&json!({"ok": true, "launched": true})));
                return ExitCode::SUCCESS;
            }
        }
        thread::sleep(Duration::from_millis(300));
    }
    eprintln!("Grokzilla did not open a control socket");
    ExitCode::from(1)
}

fn wait_loop(params: Value, timeout: u64) -> ExitCode {
    let deadline = Instant::now() + Duration::from_secs(timeout);
    loop {
        match rpc("transcript", params.clone()) {
            Ok(view) => {
                let status = view.get("status").and_then(Value::as_str).unwrap_or("");
                let needs = view.get("needs").cloned().unwrap_or(Value::Null);
                let permission = needs.get("permission");
                let running = needs.get("running").and_then(Value::as_bool).unwrap_or(false);
                if permission.is_some() && !permission.unwrap().is_null() {
                    println!("{}", pretty(&view));
                    return ExitCode::from(2);
                }
                if !running && status != "running" {
                    println!("{}", pretty(&view));
                    return ExitCode::SUCCESS;
                }
            }
            Err(err) => {
                eprintln!("{err}");
                return ExitCode::from(1);
            }
        }
        if Instant::now() >= deadline {
            eprintln!("wait timed out after {timeout}s");
            return ExitCode::from(1);
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn rpc(method: &str, params: Value) -> Result<Value, String> {
    let sock = socket_path();
    if !sock.exists() {
        return Err("Grokzilla is not running (control.sock missing). Open Grokzilla.app or run: grokzilla launch".into());
    }
    let token = fs::read_to_string(token_path())
        .map_err(|_| "missing control.token — is Grokzilla running?".to_string())?;
    let mut stream = UnixStream::connect(&sock).map_err(|e| format!("connect {}: {e}", sock.display()))?;
    let req = json!({
        "token": token.trim(),
        "id": 1,
        "method": method,
        "params": params,
    });
    let mut line = req.to_string();
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    stream.flush().map_err(|e| format!("flush: {e}"))?;
    let mut reader = BufReader::new(stream);
    let mut reply = String::new();
    reader
        .read_line(&mut reply)
        .map_err(|e| format!("read: {e}"))?;
    let value: Value = serde_json::from_str(reply.trim()).map_err(|e| format!("invalid reply: {e}"))?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let err = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("request failed");
        return Err(err.to_string());
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}
