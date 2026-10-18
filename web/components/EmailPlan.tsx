"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { Plan } from "@/lib/plan";

const KEY = "job-transit-email-v1"; // { email, token }: token = reminders are on for this browser's plan

type Saved = { email: string; token: string | null };

function load(): Saved {
  try {
    return { email: "", token: null, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>) };
  } catch {
    return { email: "", token: null };
  }
}

function store(saved: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved));
  } catch {}
}

function reason(error: unknown) {
  return error instanceof ApiError ? error.message : "Couldn’t send it. Check your connection and try again.";
}

/** No paths left: empty the server's reminder list (the address stays subscribed for the next plan). */
export function clearReminders() {
  const saved = load();
  if (!saved.token) return;
  const empty: Plan = { census: 0, occupation: "", summary: "", created: "", steps: [] };
  api.syncReminders(saved.token, empty).catch(() => {});
}

/** Email reminders for the plan: one short email on the day a step or practice session is due. */
export function EmailPlan({ plan }: { plan: Plan }) {
  const [saved, setSaved] = useState<Saved>({ email: "", token: null });
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = load();
    setSaved(s);
    setEmail(s.email);
  }, []);

  // Reminders on: keep the server's dates in step with the plan as it changes (ticks, edits, practice sessions).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!saved.token) return;
    const timer = setTimeout(() => {
      api.syncReminders(saved.token!, plan).catch((e) => {
        if (e instanceof ApiError && e.status === 404) update({ ...saved, token: null }); // unsubscribed from an email
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [plan, saved]);

  const update = (next: Saved) => {
    setSaved(next);
    store(next);
  };

  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.emailPlan(email.trim(), plan, true);
      update({ email: email.trim(), token: result.token });
      setMessage(`Reminders on. We sent a confirmation with your plan to ${email.trim()}.`);
      setOpen(false);
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    if (saved.token) await api.remindersOff(saved.token).catch(() => {});
    update({ ...saved, token: null });
    setMessage("Reminders off. Your email address is deleted.");
  }

  if (saved.token && !open) {
    return (
      <div className="email-plan">
        <span className="q-help">Email reminders on for {saved.email}</span>
        <button type="button" className="linkish" onClick={turnOff}>
          Turn off
        </button>
      </div>
    );
  }

  return (
    <div className="email-plan">
      {!open && (
        <button type="button" className="top-button" onClick={() => setOpen(true)}>
          Get email reminders
        </button>
      )}
      {open && (
        <form
          className="email-form"
          onSubmit={(e) => {
            e.preventDefault();
            turnOn();
          }}
        >
          <p className="q-help">
            One short email on the day a step or practice session is due. We keep only your email address and your
            steps’ titles and dates; every email has a link that deletes them.
          </p>
          <input
            className="field"
            type="email"
            required
            value={email}
            placeholder="you@example.com"
            aria-label="Your email"
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
          <div className="email-actions">
            <button type="submit" className="top-button" disabled={busy || !email.trim()}>
              {busy ? "Turning on…" : "Turn on reminders"}
            </button>
            <button type="button" className="linkish" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {message && !open && <p className="q-help email-sent">{message}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
