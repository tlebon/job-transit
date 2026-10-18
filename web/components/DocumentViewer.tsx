"use client";

import { useEffect, useRef, useState } from "react";
import type { PlanDocument } from "@/lib/plan";
import { Markdown } from "./Markdown";

type Props = {
  doc: PlanDocument;
  openingTitle?: string; // the opening it's for, if it's one of the path's
  onSave: (patch: { title: string; content: string }) => void;
  onRemove: () => void;
  onClose: () => void;
};

const fileName = (title: string) =>
  `${title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "document"}.md`;

/** One document from a path: read it, edit it, copy it or download it. */
export function DocumentViewer({ doc, openingTitle, onSave, onRemove, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content);
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState(false);
  const dirty = title !== doc.title || content !== doc.content;

  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !editing && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing]);
  // the guide revised it while it was open: show the new text, unless they're mid-edit
  useEffect(() => {
    if (editing) return;
    setTitle(doc.title);
    setContent(doc.content);
  }, [doc.title, doc.content, editing]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName(title);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && !dirty && onClose()}>
      <div className="modal doc-viewer" role="dialog" aria-modal="true" aria-labelledby="doc-title" ref={panel} tabIndex={-1}>
        <section className="modal-body">
          {editing ? (
            <input className="field doc-title-field" value={title} aria-label="Title" maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          ) : (
            <h2 id="doc-title">{doc.title}</h2>
          )}
          <p className="opening-meta">
            {KIND_LABEL[doc.kind]}
            {openingTitle ? ` · for ${openingTitle}` : ""}
            {` · ${doc.edited ? "edited by you" : "written by the guide"}, ${doc.updated}`}
          </p>
          {editing ? (
            <textarea
              className="field doc-editor"
              value={content}
              aria-label="Document text"
              maxLength={15000}
              onChange={(e) => setContent(e.target.value)}
            />
          ) : (
            <div className="doc-text">
              <Markdown text={doc.content} />
            </div>
          )}
          <div className="modal-actions doc-actions">
            <span className="doc-actions-left">
              {editing ? (
                <>
                  <button
                    type="button"
                    className="action"
                    disabled={!title.trim() || !content.trim()}
                    onClick={() => {
                      if (dirty) onSave({ title: title.trim(), content });
                      setEditing(false);
                    }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => {
                      setTitle(doc.title);
                      setContent(doc.content);
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="top-button" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                  <button type="button" className="top-button" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                  <button type="button" className="linkish" onClick={download}>
                    Download
                  </button>
                  {removing ? (
                    <span className="q-help">
                      Remove it?{" "}
                      <button type="button" className="linkish" onClick={onRemove}>
                        Remove
                      </button>{" "}
                      <button type="button" className="linkish" onClick={() => setRemoving(false)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="linkish" onClick={() => setRemoving(true)}>
                      Remove
                    </button>
                  )}
                </>
              )}
            </span>
            {!editing && (
              <button type="button" className="action" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export const KIND_LABEL: Record<PlanDocument["kind"], string> = {
  cover_letter: "Cover letter",
  cv: "CV",
  outreach: "Message",
  notes: "Notes",
};
