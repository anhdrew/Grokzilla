import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { setExplorerDrag } from "../lib/explorer-drag";
import { projectName } from "../lib/format";
import { useApp } from "../lib/store";
import type { PathHit } from "../lib/types";
import { IconFile, IconFolder, IconSearch } from "./icons";

export function Explorer() {
  const cwd = useApp((s) => s.selectedCwd);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PathHit[]>([]);

  useEffect(() => {
    setQuery("");
    setHits([]);
  }, [cwd]);

  useEffect(() => {
    if (!cwd) return;
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void api.searchPaths(cwd, q).then(setHits);
    }, 80);
    return () => window.clearTimeout(handle);
  }, [cwd, query]);

  if (!cwd) {
    return (
      <aside className="explorer">
        <div className="explorer-head">
          <span className="kicker">Explorer</span>
        </div>
        <div className="explorer-body">
          <div className="tree-empty">Open a project to browse files.</div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="explorer">
      <div className="explorer-head">
        <span className="kicker">Explorer</span>
        <span className="tree-count" title={cwd}>
          {projectName(cwd)}
        </span>
      </div>
      <label className="tree-search">
        <IconSearch />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files"
          spellCheck={false}
        />
      </label>
      <div className="explorer-body">
        {query.trim() ? (
          hits.length ? (
            hits.map((hit) => <ExplorerRow key={hit.path} entry={hit} depth={0} />)
          ) : (
            <div className="tree-empty">No matches</div>
          )
        ) : (
          <ExplorerDir cwd={cwd} rel="" depth={0} />
        )}
      </div>
    </aside>
  );
}

function ExplorerDir({ cwd, rel, depth }: { cwd: string; rel: string; depth: number }) {
  const [rows, setRows] = useState<PathHit[] | null>(null);

  useEffect(() => {
    let alive = true;
    void api.listDir(cwd, rel).then((items) => {
      if (alive) setRows(items);
    });
    return () => {
      alive = false;
    };
  }, [cwd, rel]);

  if (!rows) return <div className="tree-empty">Loading…</div>;
  if (!rows.length) return depth === 0 ? <div className="tree-empty">Empty folder</div> : null;
  return (
    <>
      {rows.map((entry) => (
        <ExplorerNode key={entry.path} cwd={cwd} entry={entry} depth={depth} />
      ))}
    </>
  );
}

function ExplorerNode({ cwd, entry, depth }: { cwd: string; entry: PathHit; depth: number }) {
  const folder = entry.kind === "folder";
  const [open, setOpen] = useState(false);
  return (
    <div>
      <ExplorerRow
        entry={entry}
        depth={depth}
        open={folder ? open : undefined}
        onToggle={folder ? () => setOpen((value) => !value) : undefined}
      />
      {folder && open ? <ExplorerDir cwd={cwd} rel={entry.rel} depth={depth + 1} /> : null}
    </div>
  );
}

function ExplorerRow({
  entry,
  depth,
  open,
  onToggle,
}: {
  entry: PathHit;
  depth: number;
  open?: boolean;
  onToggle?: () => void;
}) {
  const attachEntry = useApp((s) => s.attachEntry);
  const folder = entry.kind === "folder";
  const name = entry.rel.replace(/\/+$/, "").split("/").pop() || entry.rel;

  function attach() {
    attachEntry({
      path: entry.path,
      rel: entry.rel,
      kind: folder ? "folder" : "file",
    });
  }

  return (
    <div
      className={`explorer-row ${folder ? "folder" : "file"}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      draggable
      title={entry.rel}
      onDragStart={(event) => {
        setExplorerDrag(event.dataTransfer, entry);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        attach();
      }}
    >
      {folder ? (
        <button
          className="explorer-caret"
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.();
          }}
          aria-label={open ? "Collapse" : "Expand"}
        >
          <span className={`caret ${open ? "open" : ""}`} />
        </button>
      ) : (
        <span className="explorer-caret" />
      )}
      {folder ? <IconFolder /> : <IconFile />}
      <span className="explorer-label">{name}</span>
    </div>
  );
}
