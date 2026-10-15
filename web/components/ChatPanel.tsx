"use client";

import { useEffect, useRef, useState } from "react";
import { streamChat, type ChatAction, type ChatMessage, type Profile } from "@/lib/api";
import { Markdown } from "./Markdown";

type Turn = ChatMessage & { status?: string; error?: string };

const STARTERS = [
  "Where could I go that pays more?",
  "Compare my top two stops",
  "Make me a 6-month plan for my top stop",
  "Which of my stops is safest from AI?",
];

type Props = {
  profile: Profile;
  selected: number | null;
  onAction: (action: ChatAction) => void;
  onClose: () => void;
};

/** The guide: a chat grounded in the planner's data, which can also open stops and update the profile. */
export function ChatPanel({ profile, selected, onAction, onClose }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [turns]);
  useEffect(() => () => controller.current?.abort(), []);

  const update = (fn: (last: Turn) => Turn) => setTurns((t) => [...t.slice(0, -1), fn(t[t.length - 1])]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    const history: ChatMessage[] = [...turns.map(({ role, content }) => ({ role, content })), { role: "user", content: question }];
    setTurns([...history, { role: "assistant", content: "" }]);
    setDraft("");
    setBusy(true);
    controller.current = new AbortController();
    let afterTool = false;
    try {
      await streamChat(
        { messages: history.filter((m) => m.content), profile, selected },
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
    <aside className="chat" aria-label="The guide">
      <header className="chat-head">
        <strong>Ask the guide</strong>
        <span className="q-help">Answers come from the same data as the map.</span>
        <button type="button" className="icon-button" aria-label="Close the guide" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="chat-log" ref={log} aria-live="polite">
        {turns.length === 0 && (
          <div className="chat-empty">
            <p>Ask about your next stops, compare jobs, or get a plan. The guide can open stops on the map and update your profile.</p>
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
          className="field area"
          rows={2}
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
    </aside>
  );
}
