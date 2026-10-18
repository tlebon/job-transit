"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { searchForChat } from "@/lib/location";
import { COMPACT_AT_CHARS, COMPACT_AT_MESSAGES, KEEP_RECENT, SEND_MAX_CHARS, type Memory } from "@/lib/workspace";
import type { Plan } from "@/lib/plan";
import { api, streamChat, type ChatAction, type ChatMessage, type Profile } from "@/lib/api";
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

/** In a plan's conversation: start from where the plan is, not from scratch. */
function planStarters(plan: Plan) {
  const next = plan.steps.find((s) => !s.done);
  const learning = plan.steps.find((s) => s.sessions && !s.done);
  return [
    next && `Help me start: ${next.title}`,
    "Find openings for this move",
    learning && learning !== next && `Quiz me on: ${learning.title}`,
    "What could make this move harder than it looks?",
  ].filter((s): s is string => !!s);
}

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
  hidden?: boolean; // map view or another tab: stays mounted so an answer in progress keeps streaming
  extraBody?: () => Record<string, unknown>; // read at send time: the other plans and conversations
  onBusy?: (busy: boolean) => void;
  placeholder?: string;
  memory?: Memory; // the older part of this conversation, summarized
  onMemory?: (memory: Memory | null) => void;
  onPendingSent?: () => void;
  plan?: Plan | null; // sent along so the guide can discuss and revise it
};

/** The guide: a chat grounded in the planner's data, which can also open jobs and update the profile. */
export function ChatPanel({ turns, setTurns, profile, selected, onAction, pendingQuestion, onPendingSent, plan, hidden, extraBody, onBusy, placeholder, memory, onMemory }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => onBusy?.(busy), [busy]); // eslint-disable-line react-hooks/exhaustive-deps
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
    let remembered = memory && memory.upTo < history.length ? memory : undefined;
    setDraft("");
    setBusy(true);
    controller.current = new AbortController();
    let afterTool = false;
    let answered = false; // has any of the answer arrived (decides what Stop does)
    let failed = false;
    try {
      const from = remembered?.upTo ?? 0;
      const fresh = history.slice(from);
      if (fresh.reduce((n, m) => n + m.content.length, 0) > COMPACT_AT_CHARS || fresh.length > COMPACT_AT_MESSAGES) {
        let cut = history.length - KEEP_RECENT;
        while (cut > from && history[cut].role !== "user") cut--; // what's sent has to start with their message
        if (cut > from) {
          update((last) => ({ ...last, status: "Summarizing the earlier conversation" }));
          try {
            const { summary } = await api.compactChat(history.slice(from, cut), remembered?.summary);
            remembered = { summary, upTo: cut };
            onMemory?.(remembered);
          } catch {
            /* send the full messages instead */
          }
        }
      }
      const messages = history
        .slice(remembered?.upTo ?? 0)
        .map((m, i, all) =>
          i < all.length - 1 && m.content.length > SEND_MAX_CHARS ? { ...m, content: m.content.slice(0, SEND_MAX_CHARS) + " […trimmed]" } : m,
        );
      await streamChat(
        {
          messages,
          summary: remembered?.summary,
          profile,
          selected,
          location: searchForChat(),
          plan,
          ...(extraBody?.() ?? {}),
        },
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
            failed = true;
            fail(event.message);
          }
        },
        controller.current.signal,
      );
      if (!answered && !failed) fail("The guide didn’t write an answer. Try again.");
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

  // position of each turn among the messages that get sent (failed and empty ones don't), for the summary marker
  const sentIndex: number[] = [];
  turns.reduce((n, t, i) => {
    sentIndex[i] = !t.failed && t.content ? n : -1;
    return !t.failed && t.content ? n + 1 : n;
  }, 0);

  return (
    <section className="chat" aria-label="The guide" hidden={hidden}>
      <header className="chat-head">
        <strong>The guide</strong>
        <span className="q-help">Answers come from the same data as the map, and it can open jobs on the map and update your profile.</span>
        {turns.length > 0 && !busy && (
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setTurns(() => []);
              onMemory?.(null);
            }}
          >
            New conversation
          </button>
        )}
      </header>
      <div className="chat-log" ref={log} aria-live="polite">
        {turns.length === 0 && (
          <div className="chat-empty">
            <p>
              {plan
                ? `Your path to ${plan.occupation}. Ask about any step of the plan, a practice session, or openings.`
                : "Ask about your next steps, compare jobs, or get a plan."}
            </p>
            <div className="chat-starters">
              {(plan ? planStarters(plan) : STARTERS).map((s) => (
                <button key={s} type="button" className="chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <Fragment key={i}>
          {memory && sentIndex[i] === memory.upTo && (
            <p className="chat-memory">
              The guide keeps the messages above as a short summary, so long conversations stay quick.
            </p>
          )}
          <div className={`chat-turn chat-${t.role}${t.failed ? " chat-failed" : ""}`}>
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
          </Fragment>
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
          placeholder={placeholder ?? "Ask anything about your next move"}
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
