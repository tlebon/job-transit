"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadLocation } from "@/lib/location";
import type { Plan } from "@/lib/plan";
import { streamChat, type ChatAction, type ChatMessage, type Profile } from "@/lib/api";
import { Markdown } from "./Markdown";

export type Turn = ChatMessage & { status?: string; error?: string };

const STARTERS = [
  "Where could I go that pays more?",
  "Compare my top two next steps",
  "Make me a 6-month plan for my top next step",
  "Which of my next steps is safest from AI?",
];

type Props = {
  turns: Turn[];
  setTurns: (update: (turns: Turn[]) => Turn[]) => void;
  profile: Profile;
  selected: number | null;
  onAction: (action: ChatAction) => void;
  pendingQuestion?: string | null; // asked from the map's ask bar; sent once on arrival
  onPendingSent?: () => void;
  plan?: Plan | null; // sent along so the guide can discuss and revise it
};

/** The guide: a chat grounded in the planner's data, which can also open stops and update the profile. */
export function ChatPanel({ turns, setTurns, profile, selected, onAction, pendingQuestion, onPendingSent, plan }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [turns]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!pendingQuestion) {
      input.current?.focus();
      return;
    }
    // Deferred so React's dev-mode double effect run sends once: the first timer is cleared before it fires.
    const question = pendingQuestion;
    const timer = setTimeout(() => {
      onPendingSent?.();
      send(question);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuestion]);

  // The input grows with the text (up to ~6 lines, then scrolls) instead of a drag handle.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || el.offsetParent === null) return; // hidden: nothing to measure (CSS min-height covers it)
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + el.offsetHeight - el.clientHeight, 160)}px`;
  }, [draft]);

  const update = (fn: (last: Turn) => Turn) => setTurns((t) => [...t.slice(0, -1), fn(t[t.length - 1])]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const history: ChatMessage[] = [...turns.map(({ role, content }) => ({ role, content })), { role: "user", content: question }];
    setTurns(() => [...history, { role: "assistant", content: "" }]);
    setDraft("");
    setBusy(true);
    controller.current = new AbortController();
    let afterTool = false;
    try {
      await streamChat(
        { messages: history.filter((m) => m.content), profile, selected, location: loadLocation(), plan },
        (event) => {
          if (event.type === "text") {
            const gap = afterTool ? "\n\n" : "";
            afterTool = false;
            update((last) => ({ ...last, content: last.content + (last.content ? gap : "") + event.text, status: undefined }));
          } else if (event.type === "tool") {
            afterTool = true;
            update((last) => ({ ...last, status: event.label }));
          } else if (event.type === "action") {
            onAction(event.action);
          } else if (event.type === "error") {
            update((last) => ({ ...last, error: event.message, status: undefined }));
          }
        },
        controller.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") update((last) => ({ ...last, error: `Couldn’t reach the guide: ${(e as Error).message}` }));
    } finally {
      update((last) => ({ ...last, status: undefined }));
      setBusy(false);
    }
  }

  return (
    <section className="chat" aria-label="The guide">
      <header className="chat-head">
        <strong>The guide</strong>
        <span className="q-help">Answers come from the same data as the map, and it can open stops and update your profile.</span>
        {turns.length > 0 && !busy && (
          <button type="button" className="linkish" onClick={() => setTurns(() => [])}>
            New conversation
          </button>
        )}
      </header>
      <div className="chat-log" ref={log} aria-live="polite">
        {turns.length === 0 && (
          <div className="chat-empty">
            <p>Ask about your next steps, compare jobs, or get a plan.</p>
            <div className="chat-starters">
              {STARTERS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat-turn chat-${t.role}`}>
            {t.role === "assistant" ? <Markdown text={t.content} /> : <p>{t.content}</p>}
            {t.status && <p className="chat-status">{t.status}…</p>}
            {t.role === "assistant" && !t.content && !t.status && !t.error && busy && i === turns.length - 1 && (
              <p className="chat-status">Thinking…</p>
            )}
            {t.error && <p className="error">{t.error}</p>}
          </div>
        ))}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <textarea
          ref={input}
          className="field chat-box"
          rows={1}
          value={draft}
          placeholder="Ask anything about your next move"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        {busy ? (
          <button type="button" className="action" onClick={() => controller.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="action" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}
