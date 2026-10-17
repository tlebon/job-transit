"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadLocation } from "@/lib/location";
import type { Plan } from "@/lib/plan";
import { streamChat, type ChatAction, type ChatMessage, type Profile } from "@/lib/api";
import { Markdown } from "./Markdown";

// failed: a question that never reached the guide (API down, network); shown with Retry, left out of the history
// stopped: the person cancelled the answer part-way
export type Turn = ChatMessage & {
  status?: string;
  error?: string;
  suggestions?: string[];
  failed?: boolean;
  stopped?: boolean;
};

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

/** The guide: a chat grounded in the planner's data, which can also open jobs and update the profile. */
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
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && controller.current?.abort();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);
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

  /** The question didn't get an answer: drop the empty reply and mark the question as not sent. If part of an
   * answer already arrived, keep it and show the error under it instead. */
  const fail = (reason: string) =>
    setTurns((t) => {
      const last = t[t.length - 1];
      if (last?.role === "assistant" && last.content) return [...t.slice(0, -1), { ...last, error: reason, status: undefined }];
      const rest = last?.role === "assistant" ? t.slice(0, -1) : t;
      return rest.map((turn, i) => (i === rest.length - 1 ? { ...turn, failed: true, error: reason } : turn));
    });

  /** Cancelled with Stop or Esc. Nothing arrived yet: take the question back into the input to edit or resend.
   * Part of an answer arrived: keep it, marked as stopped. */
  const stopped = (question: string, answered: boolean) => {
    if (answered) {
      update((last) => ({ ...last, stopped: true, status: undefined }));
    } else {
      setTurns((t) => (t[t.length - 1]?.role === "assistant" ? t.slice(0, -2) : t.slice(0, -1)));
      setDraft(question);
    }
  };

  async function send(text: string, replacing?: number) {
    const question = text.trim();
    if (!question || busy) return;
    const kept = turns.filter((_, i) => i !== replacing);
    const history: ChatMessage[] = [
      ...kept.filter((t) => !t.failed && t.content).map(({ role, content }) => ({ role, content })),
      { role: "user", content: question },
    ];
    setTurns(() => [...kept, { role: "user", content: question }, { role: "assistant", content: "" }]);
    setDraft("");
    setBusy(true);
    controller.current = new AbortController();
    let afterTool = false;
    let answered = false; // has any of the answer arrived (decides what Stop does)
    try {
      await streamChat(
        { messages: history, profile, selected, location: loadLocation(), plan },
        (event) => {
          if (event.type === "text") {
            answered = true;
            const gap = afterTool ? "\n\n" : "";
            afterTool = false;
            update((last) => ({ ...last, content: last.content + (last.content ? gap : "") + event.text, status: undefined }));
          } else if (event.type === "tool") {
            afterTool = true;
            update((last) => ({ ...last, status: event.label }));
          } else if (event.type === "action") {
            const action = event.action;
            if (action.type === "suggest_replies") update((last) => ({ ...last, suggestions: action.replies }));
            else onAction(action);
          } else if (event.type === "error") {
            fail(event.message);
          }
        },
        controller.current.signal,
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") stopped(question, answered);
      else fail("Couldn’t reach the guide. Check your connection or try again in a moment.");
    } finally {
      setTurns((t) => {
        const last = t[t.length - 1];
        return last?.role === "assistant" ? [...t.slice(0, -1), { ...last, status: undefined }] : t;
      });
      setBusy(false);
    }
  }

  return (
    <section className="chat" aria-label="The guide">
      <header className="chat-head">
        <strong>The guide</strong>
        <span className="q-help">Answers come from the same data as the map, and it can open jobs on the map and update your profile.</span>
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
          <div key={i} className={`chat-turn chat-${t.role}${t.failed ? " chat-failed" : ""}`}>
            {t.role === "assistant" ? <Markdown text={t.content} /> : <p>{t.content}</p>}
            {t.failed && (
              <p className="chat-failed-note">
                Not sent. {t.error}{" "}
                <button type="button" className="linkish" disabled={busy} onClick={() => send(t.content, i)}>
                  Retry
                </button>{" "}
                <button type="button" className="linkish" onClick={() => setTurns((all) => all.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </p>
            )}
            {t.status && <p className="chat-status">{t.status}…</p>}
            {t.role === "assistant" && !t.content && !t.status && !t.error && busy && i === turns.length - 1 && (
              <p className="chat-status">Thinking…</p>
            )}
            {t.error && !t.failed && <p className="error">{t.error}</p>}
            {t.stopped && <p className="chat-status">Stopped.</p>}
            {t.suggestions && t.suggestions.length > 0 && !busy && i === turns.length - 1 && (
              <div className="chat-suggestions" aria-label="Suggested replies">
                {t.suggestions.map((s) => (
                  <button key={s} type="button" className="chip" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
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
          <button type="button" className="action" title="Stop (Esc)" onClick={() => controller.current?.abort()}>
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
