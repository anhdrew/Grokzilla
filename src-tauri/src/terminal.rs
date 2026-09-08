use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::{collections::HashMap, io::{Read, Write}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}};
use tauri::{Emitter, State};

struct TerminalEntry {
    cwd: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}
impl Drop for TerminalEntry { fn drop(&mut self) { let _ = self.killer.kill(); } }
#[derive(Default)]
pub struct Terminals(Arc<Mutex<HashMap<String, TerminalEntry>>>);
impl Terminals {
    pub fn has_cwd(&self, cwd: &str) -> bool { self.0.lock().unwrap().values().any(|t| t.cwd == cwd) }
    #[allow(dead_code)]
    pub fn close_all(&self) { self.0.lock().unwrap().clear(); }
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn size(cols:u16, rows:u16) -> PtySize { PtySize { rows: rows.clamp(1,500), cols:cols.clamp(1,1000), pixel_width:0, pixel_height:0 } }

#[tauri::command]
pub fn terminal_open(app: tauri::AppHandle, state: State<'_, Terminals>, task_id: String, cwd: String, shell: String, cols:u16, rows:u16) -> Result<String,String> {
    let path=std::fs::canonicalize(&cwd).map_err(|e|e.to_string())?;
    if !path.is_dir() { return Err("Terminal folder does not exist".into()); }
    let shell=if shell.is_empty() { std::env::var("SHELL").unwrap_or("/bin/zsh".into()) } else { shell };
    if !std::path::Path::new(&shell).is_absolute() || !std::path::Path::new(&shell).is_file() { return Err("Shell must be an existing absolute executable path".into()); }
    let pair=native_pty_system().openpty(size(cols,rows)).map_err(|e|e.to_string())?;
    let mut command=CommandBuilder::new(shell); command.arg("-l"); command.cwd(path); command.env("TERM","xterm-256color");
    let mut child=pair.slave.spawn_command(command).map_err(|e|e.to_string())?;
    drop(pair.slave);
    let mut reader=pair.master.try_clone_reader().map_err(|e|e.to_string())?;
    let writer=pair.master.take_writer().map_err(|e|e.to_string())?;
    let id=format!("pty-{}",NEXT_ID.fetch_add(1,Ordering::SeqCst));
    state.0.lock().unwrap().insert(id.clone(),TerminalEntry { cwd,master:pair.master,writer,killer:child.clone_killer() });
    let read_id=id.clone(); let read_app=app.clone();
    std::thread::spawn(move || {
        let mut buffer=[0u8;8192];
        while let Ok(n)=reader.read(&mut buffer) { if n==0 {break;}
            // Send bytes, preserving UTF-8 characters split between PTY reads.
            let _=read_app.emit_to("main","terminal-data",json!({"id":read_id,"taskId":task_id,"bytes":&buffer[..n]}));
        }
    });
    let map=state.0.clone(); let exit_id=id.clone();
    std::thread::spawn(move || {
        let status=child.wait().map(|s|s.exit_code()).ok();
        map.lock().unwrap().remove(&exit_id);
        let _=app.emit_to("main","terminal-exit",json!({"id":exit_id,"exitCode":status}));
    });
    Ok(id)
}
#[tauri::command]
pub fn terminal_write(state: State<'_,Terminals>,id:String,data:String)->Result<(),String>{
    let mut map=state.0.lock().unwrap(); let terminal=map.get_mut(&id).ok_or("Terminal has exited")?;
    terminal.writer.write_all(data.as_bytes()).and_then(|_|terminal.writer.flush()).map_err(|e|e.to_string())
}
#[tauri::command]
pub fn terminal_resize(state:State<'_,Terminals>,id:String,cols:u16,rows:u16)->Result<(),String>{
    state.0.lock().unwrap().get(&id).ok_or("Terminal has exited")?.master.resize(size(cols,rows)).map_err(|e|e.to_string())
}
#[tauri::command]
pub fn terminal_close(state:State<'_,Terminals>,id:String)->Result<(),String>{ state.0.lock().unwrap().remove(&id); Ok(()) }
