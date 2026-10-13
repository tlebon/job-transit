"use client";

import { useState } from "react";
import { api, type CvResult } from "@/lib/api";
import type { Title } from "./JobTitles";

export type CvApply = {
  titles: Title[];
  education: string | null;
  answers: Record<string, number>;
  activities: string[];
  tools: string[];
  record: CvResult;
};

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Roles pre-ticked: the ones still ongoing, or the most recent one if none are. */
function defaultTicks(result: CvResult) {
  const current = result.jobs.map((j, i) => (j.current ? i : -1)).filter((i) => i >= 0);
  return new Set(current.length ? current : result.jobs.length ? [0] : []);
}

export function CvReader({ onApply, compact }: { onApply: (apply: CvApply) => void; compact?: boolean }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<CvResult | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [choice, setChoice] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read() {
    if (!file && !text.trim()) {
      setError("Choose a PDF or paste your CV first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = file
        ? file.type === "application/pdf"
          ? { pdf_base64: await toBase64(file) }
          : { text: await file.text() }
        : { text };
      const r = await api.readCv(body);
      setResult(r);
      setTicked(defaultTicks(r));
      setChoice(Object.fromEntries(r.jobs.map((j, i) => [i, j.matches[0]?.census ?? -1])));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t read the CV.");
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!result) return;
    const titles: Title[] = [];
    for (const i of [...ticked].sort()) {
      const match = result.jobs[i].matches.find((m) => m.census === choice[i]);
      if (match && !titles.some((t) => t.census === match.census)) titles.push({ census: match.census, label: match.occupation });
    }
    onApply({
      titles,
      education: result.education,
      answers: result.answers,
      activities: result.activities ?? [],
      tools: result.tools,
      record: result,
    });
  }

  if (!result) {
    return (
      <div className="cv-reader">
        <input
          type="file"
          accept=".pdf,.txt,.md"
          aria-label="CV file (PDF or text)"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
          }}
        />
        {!file && !compact && (
          <textarea className="field area" rows={4} placeholder="Or paste your CV here" value={text} onChange={(e) => setText(e.target.value)} />
        )}
        <button type="button" className="action" onClick={read} disabled={busy}>
          {busy ? "Reading your CV…" : "Read my CV"}
        </button>
        <p className="q-help">Your CV is sent to Anthropic’s API to be read and isn’t stored by Job Transit.</p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="cv-result">
      <p>{result.summary}</p>
      <fieldset className="roles">
        <legend className="fact-label">Which roles describe you now? Ongoing ones are ticked.</legend>
        {result.jobs.map((job, i) => (
          <div key={i} className="role">
            <label className="role-tick">
              <input
                type="checkbox"
                checked={ticked.has(i)}
                onChange={() =>
                  setTicked((t) => {
                    const next = new Set(t);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
              />
              <span>
                {job.label}
                {job.kind === "program" ? " (programme)" : ""}
                {job.current ? ", ongoing" : ""}
              </span>
            </label>
            {ticked.has(i) && job.matches.length > 0 && (
              <select
                className="field"
                aria-label={`Occupation for ${job.label}`}
                value={choice[i] ?? ""}
                onChange={(e) => setChoice((c) => ({ ...c, [i]: Number(e.target.value) }))}
              >
                {job.matches.map((m) => (
                  <option key={m.census} value={m.census}>
                    {m.occupation}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </fieldset>
      <button type="button" className="action" onClick={apply}>
        Use this
      </button>
      <button type="button" className="linkish" onClick={() => setResult(null)}>
        Read a different CV
      </button>
    </div>
  );
}
