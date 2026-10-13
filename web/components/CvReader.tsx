"use client";

import { useState } from "react";
import { api, type CvResult } from "@/lib/api";

export type CvApply = {
  job: { census: number; label: string } | null;
  education: string | null;
  answers: Record<string, number>;
  activities: string[];
  tools: string[];
};

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function CvReader({ onApply }: { onApply: (apply: CvApply) => void }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<CvResult | null>(null);
  const [jobChoice, setJobChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  async function read() {
    if (!file && !text.trim()) {
      setError("Choose a PDF or paste your CV first.");
      return;
    }
    setBusy(true);
    setError(null);
    setApplied(false);
    try {
      const body = file
        ? file.type === "application/pdf"
          ? { pdf_base64: await toBase64(file) }
          : { text: await file.text() }
        : { text };
      const r = await api.readCv(body);
      setResult(r);
      setJobChoice(r.jobs[0]?.matches[0]?.census ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t read the CV.");
    } finally {
      setBusy(false);
    }
  }

  const choices = result?.jobs[0]?.matches ?? [];
  const chosen = choices.find((m) => m.census === jobChoice) ?? null;

  return (
    <>
      <input
        type="file"
        accept=".pdf,.txt,.md"
        aria-label="CV file (PDF or text)"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setError(null);
        }}
      />
      {!file && (
        <textarea
          className="field area"
          rows={4}
          placeholder="Or paste your CV here"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <button type="button" className="action" onClick={read} disabled={busy}>
        {busy ? "Reading your CV…" : "Read my CV"}
      </button>
      <p className="q-help">Your CV is sent to Anthropic’s API to be read and isn’t stored by Job Transit.</p>
      {error && <p className="error">{error}</p>}

      {result && (
        <div className="cv-result">
          <p>{result.summary}</p>
          {choices.length > 0 && (
            <label className="cv-row">
              <span className="fact-label">Starting job, from “{result.jobs[0].title}”</span>
              <select
                className="field"
                value={jobChoice ?? ""}
                onChange={(e) => setJobChoice(e.target.value ? Number(e.target.value) : null)}
              >
                {choices.map((m) => (
                  <option key={m.census} value={m.census}>
                    {m.occupation}
                  </option>
                ))}
                <option value="">Don’t set a job</option>
              </select>
            </label>
          )}
          <div className="cv-facts">
            {result.education && (
              <span>
                <span className="fact-label">Education</span>
                <br />
                {result.education}
                {result.education_field ? `, ${result.education_field}` : ""}
              </span>
            )}
            {result.years_experience !== null && (
              <span>
                <span className="fact-label">Experience</span>
                <br />
                {Math.round(result.years_experience)} years
              </span>
            )}
            <span>
              <span className="fact-label">Skill questions answered</span>
              <br />
              {Object.keys(result.answers).length}
            </span>
          </div>
          {result.tools.length > 0 && (
            <div className="chips" aria-label="Tools found in your CV">
              {result.tools.map((t) => (
                <span key={t} className="chip static">
                  {t}
                </span>
              ))}
            </div>
          )}
          <button
            type="button"
            className="action"
            onClick={() => {
              onApply({
                job: chosen ? { census: chosen.census, label: chosen.occupation } : null,
                education: result.education,
                answers: result.answers,
                activities: result.activities ?? [],
                tools: result.tools,
              });
              setApplied(true);
            }}
          >
            {applied ? "Added to your plan" : "Add to my plan"}
          </button>
          {applied && <p className="q-help">You can still change any answer below.</p>}
        </div>
      )}
    </>
  );
}
