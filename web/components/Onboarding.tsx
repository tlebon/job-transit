"use client";

import { useEffect, useRef, useState } from "react";
import type { Meta, Profile } from "@/lib/api";
import { CvReader, type CvApply } from "./CvReader";
import { JobTitles, type Title } from "./JobTitles";

type Props = {
  meta: Meta | null;
  profile: Profile;
  titles: Title[];
  description: string;
  onTitles: (titles: Title[]) => void;
  onDescription: (text: string) => void;
  onApplyCv: (apply: CvApply) => void;
  onToggleChip: (chip: string) => void;
  onFinish: () => void;
};

const STEPS = ["Your work", "Your interests", "Your map"];

/** First-run flow: three skippable steps, then the map. */
export function Onboarding({ meta, profile, titles, description, onTitles, onDescription, onApplyCv, onToggleChip, onFinish }: Props) {
  const [step, setStep] = useState(0);
  const [useCv, setUseCv] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onFinish();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onFinish]);

  const next = () => (step < STEPS.length - 1 ? setStep(step + 1) : onFinish());

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" ref={panel}>
        <ol className="steps" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li key={label} data-state={i < step ? "done" : i === step ? "current" : "next"}>
              <span className="step-dot" aria-hidden="true" />
              <span className="step-label">{label}</span>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section className="modal-body">
            <h2 id="onboarding-title">What do you do for work?</h2>
            <p className="modal-lede">Your current or most recent job title, and what the work actually involves. Every step is optional.</p>
            {useCv ? (
              <>
                <CvReader
                  onApply={(apply) => {
                    onApplyCv(apply);
                    next();
                  }}
                />
                <button type="button" className="linkish" onClick={() => setUseCv(false)}>
                  Type it instead
                </button>
              </>
            ) : (
              <>
                <JobTitles titles={titles} onChange={onTitles} />
                <label className="cv-row">
                  <span className="q-text">What do you actually do?</span>
                  <span className="q-help">A few lines in your own words. Titles hide a lot.</span>
                  <textarea
                    className="field area"
                    rows={3}
                    placeholder="Lead a team of five engineers, review code, plan sprints, still write some frontend features"
                    value={description}
                    onChange={(e) => onDescription(e.target.value)}
                  />
                </label>
                <button type="button" className="linkish" onClick={() => setUseCv(true)}>
                  Or start from your CV
                </button>
              </>
            )}
          </section>
        )}

        {step === 1 && (
          <section className="modal-body">
            <h2 id="onboarding-title">What interests you?</h2>
            <p className="modal-lede">
              Topics you enjoy or would like to work with, whether or not they’re part of your job now. Pick as many as you like.
            </p>
            <div className="chips">
              {meta?.chips.map((chip) => (
                <button
                  key={chip.name}
                  type="button"
                  className="chip"
                  aria-pressed={profile.chips.includes(chip.name)}
                  title={chip.description}
                  onClick={() => onToggleChip(chip.name)}
                >
                  {chip.name}
                </button>
              ))}
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="modal-body">
            <h2 id="onboarding-title">Welcome to Job City</h2>
            <p className="modal-lede">
              Every block is a job; neighbours need similar skills. Your best next stops are the numbered pins. Click one
              to see the route, then continue from there for a second step.
            </p>
            <p className="modal-lede">
              Want sharper routes? Open <strong>Your profile</strong> any time to take the interest quiz, rate your skills
              or add your education.
            </p>
          </section>
        )}

        <footer className="modal-actions">
          {step > 0 ? (
            <button type="button" className="linkish" onClick={() => setStep(step - 1)}>
              Back
            </button>
          ) : (
            <button type="button" className="linkish" onClick={onFinish}>
              Skip to the map
            </button>
          )}
          <button type="button" className="action" onClick={next}>
            {step === STEPS.length - 1 ? "Show my map" : "Next"}
          </button>
        </footer>
      </div>
    </div>
  );
}
