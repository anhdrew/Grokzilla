import { useEffect, useRef, useState } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import hljs from 'highlight.js';
import { desktop, useWorkspace, type Review, type FilePreview, type DiffFile } from '../lib/workspace';
import { useApp } from '../lib/store';
import { Explorer } from './Explorer';
import { Markdown } from './Markdown';

export function RightPanel() {
  const tab = useWorkspace(s => s.rightTab);
  return <aside className="right-panel"><div className="panel-tabs"><button className={tab === 'files' ? 'active' : ''} onClick={() => useWorkspace.setState({ rightTab: 'files' })}>Files</button><button className={tab === 'changes' ? 'active' : ''} onClick={() => useWorkspace.setState({ rightTab: 'changes' })}>Changes</button><span className="spacer"/><button aria-label="Close inspector" onClick={() => useWorkspace.getState().update({ layout: { ...useWorkspace.getState().data.layout, rightOpen: false } })}>×</button></div>{tab === 'files' ? <FilePanel/> : <ReviewPanel/>}</aside>;
}
function FilePanel() {
  const cwd = useApp(s => s.selectedCwd);
  const selected = useWorkspace(s => s.file);
  const [tabs, setTabs] = useState<Record<string, string[]>>({});
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const files = cwd ? tabs[cwd] ?? [] : [];
  const path = selected && files.includes(selected.path) ? selected.path : files[files.length - 1];
  useEffect(() => { if (cwd && selected) setTabs(current => ({ ...current, [cwd]: [...new Set([...(current[cwd] ?? []), selected.path])] })); }, [cwd, selected]);
  useEffect(() => {
    let alive = true; setPreview(null); setError(''); if (!cwd || !path) return;
    setLoading(true);
    desktop.readFile(cwd, path).then(v => { if (alive) setPreview(v); }).catch(e => { if (alive) setError(String(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [cwd, path]);
  useEffect(() => { if (preview && selected?.line) body.current?.querySelector(`[data-line="${selected.line}"]`)?.scrollIntoView({ block: 'center' }); }, [preview, selected]);
  return <div className="file-panel"><div className="file-tree"><Explorer embedded/></div>{files.length > 0 && <div className="file-preview"><div className="file-tabs">{files.map(file => <button key={file} className={path === file ? 'active' : ''} onClick={() => useWorkspace.getState().openFile(file)} title={file}><span>{file.split('/').pop()}</span><span role="button" aria-label={`Close ${file}`} onClick={e => { e.stopPropagation(); setTabs(t => ({ ...t, [cwd!]: files.filter(p => p !== file) })); useWorkspace.setState({ file: null }); }}>×</span></button>)}</div><div className="file-toolbar"><span title={path}>{path}</span><button className="ghost" onClick={() => void openPath(preview?.path || (path.startsWith('/') ? path : `${cwd}/${path}`)).catch(e => setError(String(e)))}>Open externally</button></div><div className="preview-body" ref={body}>{loading && <p className="muted">Loading preview…</p>}{error && <p className="inline-error">{error}</p>}{preview?.kind === 'image' ? <img className="image-preview" src={preview.content} alt={path}/> : preview?.kind === 'markdown' ? <Markdown text={preview.content}/> : preview ? <CodePreview text={preview.content} path={path} selectedLine={selected?.line}/> : null}</div></div>}</div>;
}
export function CodePreview({ text, path, selectedLine }: { text: string; path: string; selectedLine?: number }) {
  const ext = path.split('.').pop() || '';
  const language = ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', rs: 'rust', py: 'python', sh: 'bash', yml: 'yaml' } as Record<string,string>)[ext] || ext;
  const html = text.length < 300_000 && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : null;
  return <div className="source-code">{(html ?? text).split('\n').map((line, i) => <div className={`source-line ${selectedLine === i + 1 ? 'selected-line' : ''}`} key={i} data-line={i + 1}><span className="line-number">{i + 1}</span>{html != null ? <code dangerouslySetInnerHTML={{ __html: line || ' ' }}/> : <code>{line || ' '}</code>}</div>)}</div>;
}
function ReviewPanel() {
  const cwd = useApp(s => s.selectedCwd);
  const [scope, setScope] = useState('unstaged');
  const [base, setBase] = useState('HEAD');
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [revision, refresh] = useState(0);
  const [split, setSplit] = useState(false); const [selected, setSelected] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [discard, setDiscard] = useState<DiffFile | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { setSelected(''); setReview(null); setDiscard(null); setNotice(''); }, [cwd, scope, base]);
  useEffect(() => {
    if (!cwd) return; let alive = true; setBusy(true); setError('');
    desktop.gitInfo(cwd).then(info => { if (alive) setBranches(info.branches); return desktop.review(info.root, scope, base); }).then(r => { if (alive) setReview(r); }).catch(e => { if (alive) { setError(String(e)); setReview(null); } }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [cwd, scope, base, revision]);
  async function action(kind: string, file?: DiffFile, hunk?: number) {
    if (!cwd || !review || busy) return; setBusy(true); setError(''); setNotice('');
    try { const info = await desktop.gitInfo(cwd); const result = await desktop.gitAction({ cwd: info.root, scope, base, token: review.token, action: kind, path: file?.path, hunk, message }); setNotice(result || 'Changes updated'); if (kind === 'commit') setMessage(''); }
    catch(e) { setError(String(e)); }
    finally { setBusy(false); setDiscard(null); refresh(n => n + 1); }
  }
  const file = review?.files.find(f => f.path === selected) ?? review?.files[0];
  return <div className="review-panel"><div className="review-toolbar"><select aria-label="Review scope" value={scope} onChange={e => setScope(e.target.value)}><option value="unstaged">Unstaged</option><option value="staged">Staged</option><option value="branch">Branch</option></select>{scope === 'branch' && <select aria-label="Base branch" value={base} onChange={e => setBase(e.target.value)}><option value="HEAD">HEAD</option>{branches.map(b => <option key={b}>{b}</option>)}</select>}<span className="spacer"/><button disabled={busy} onClick={() => refresh(n => n + 1)} aria-label="Refresh changes">↻</button><button onClick={() => setSplit(s => !s)}>{split ? 'Unified' : 'Split'}</button></div>{error && <div className="inline-error">{error}</div>}{notice && <div className="inline-notice">{notice}</div>}{busy && <div className="muted panel-status">Updating changes…</div>}{!cwd ? <p className="panel-status">Open a project to review its changes.</p> : review && !review.files.length ? <div className="review-empty"><span>✓</span><h3>Working tree is clean</h3><p>No changes in this review scope.</p></div> : null}{review && review.files.length > 0 && <><div className="change-files">{review.files.map(f => <button key={f.path} className={file?.path === f.path ? 'active' : ''} onClick={() => setSelected(f.path)}><b className="file-status">{f.status[0]}</b><span>{f.path}</span><small className="added">+{f.additions}</small><small className="removed">−{f.deletions}</small></button>)}</div>{file && <><div className="change-heading"><span title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>{file.path}</span><span className="spacer"/>{scope !== 'branch' && <button className="ghost" disabled={busy} onClick={() => void action(scope === 'staged' ? 'unstage' : 'stage', file)}>{scope === 'staged' ? 'Unstage' : 'Stage'} file</button>}{scope === 'unstaged' && file.status !== '?' && !file.oldPath && <button className="ghost" disabled={busy} onClick={() => setDiscard(file)}>Discard…</button>}</div><DiffView file={file} split={split} scope={scope} disabled={busy} onHunk={i => void action(scope === 'staged' ? 'unstage' : 'stage', file, i)}/></>}</>}{scope === 'staged' && <div className="commit-box"><textarea aria-label="Commit message" placeholder="Commit message" value={message} onChange={e => setMessage(e.target.value)}/><button className="primary" disabled={busy || !review?.files.length || !message.trim()} onClick={() => void action('commit')}>Commit staged</button></div>}{review && <div className="review-footer"><span>{review.files.length} changed files</span><button className="ghost" disabled={busy} onClick={() => void action('push')}>Push</button></div>}{discard && <div className="modal-backdrop"><div className="dialog" role="alertdialog" aria-label="Discard file changes"><h2>Discard changes to {discard.path}?</h2><p>This removes {discard.additions} added and restores {discard.deletions} deleted lines from your working tree. Staged changes are kept.</p><pre className="discard-preview">{discard.patch}</pre><div className="dialog-actions"><button onClick={() => setDiscard(null)}>Cancel</button><button className="danger" disabled={busy} onClick={() => void action('discard', discard)}>Discard changes</button></div></div></div>}</div>;
}
function DiffView({ file, split, scope, disabled, onHunk }: { file: DiffFile; split: boolean; scope: string; disabled: boolean; onHunk: (i: number) => void }) {
  const [anchor, setAnchor] = useState<number | null>(null);
  useEffect(() => setAnchor(null), [file]);
  let oldLine = 0, newLine = 0, hunk = -1;
  return <div className={`diff-view ${split ? 'split-diff' : ''}`}><p className="diff-hint">Click a line to add feedback; Shift-click selects a range.</p>{file.patch.split('\n').map((line, i) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); hunk++; const index = hunk; return <div className="diff-hunk" key={i}><span>{line}</span>{scope !== 'branch' && file.status === 'M' && <button disabled={disabled} onClick={() => onHunk(index)}>{scope === 'staged' ? 'Unstage' : 'Stage'} hunk</button>}</div>; }
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) return null;
    if (hunk < 0 || !/^[ +\-]/.test(line)) return <pre className="diff-meta" key={i}>{line}</pre>;
    const added = line[0] === '+', removed = line[0] === '-';
    const left = added ? null : oldLine++, right = removed ? null : newLine++;
    const number = right ?? left ?? 1;
    return <button key={i} className={`diff-line ${added ? 'addition' : removed ? 'deletion' : ''}`} onClick={e => { const start = e.shiftKey && anchor != null ? Math.min(anchor, number) : number; const end = e.shiftKey && anchor != null ? Math.max(anchor, number) : number; setAnchor(number); const state = useApp.getState(); state.setComposer(`${state.composer}${state.composer ? '\n\n' : ''}Review ${file.path}:${start}${end !== start ? `-${end}` : ''} (${removed ? 'original' : 'updated'}):\n${line.slice(1)}\nFeedback: `); }} title="Add line to feedback"><span className="line-number">{left}</span>{split && <code className="split-old">{added ? '' : line.slice(1) || ' '}</code>}<span className="line-number">{right}</span><code>{split ? removed ? '' : line.slice(1) || ' ' : line || ' '}</code></button>;
  })}</div>;
}
