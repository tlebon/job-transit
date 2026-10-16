"use client";

import { useEffect, useRef, useState } from "react";
import type { Meta, Profile } from "@/lib/api";
import { CvReader, type CvApply } from "./CvReader";
import { ChipGroups } from "./ChipGroups";
import { ExperiencePicker } from "./ExperiencePicker";
import { GoalPicker } from "./GoalPicker";
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
  hobbies: string;
  onHobbies: (text: string) => void;
  onToggleGoal: (goal: string) => void;
  hasCv: boolean;
  onLoadFile: (file: File) => void;
  experienceYears: number | null;
  onExperience: (years: number | null) => void;
  onFinish: () => void;
};

const STEPS = ["Your CV", "Your work", "Your interests", "Your map"];

/** First-run flow: four skippable steps, then the map. */
export function Onboarding({
  meta, profile, titles, description, onTitles, onDescription, onApplyCv, onToggleChip,
  hobbies, onHobbies, onToggleGoal, hasCv, onLoadFile, experienceYears, onExperience, onFinish,
}: Props) {
  const [step, setStep] = useState(0);
  const [rereadCv, setRereadCv] = useState(false);
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
            <h2 id="onboarding-title">Start with your CV?</h2>
            <p className="modal-lede">
              It’s the quickest way in: we pick out your roles, what you did and the tools you used, and you check them
              before anything is used. Or skip and type it in. Every step is optional.
            </p>
            {hasCv && !rereadCv ? (
              <p className="modal-lede">
                Your CV is already loaded; you can review it under <strong>Your profile</strong>.{" "}
                <button type="button" className="linkish" onClick={() => setRereadCv(true)}>
                  Read a different one
                </button>
              </p>
            ) : (
              <CvReader
                onApply={(apply) => {
                  onApplyCv(apply);
                  setRereadCv(false);
                  next();
                }}
              />
            )}
            <label className="linkish file-pick">
              Been here before? Load your saved profile
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onLoadFile(file);
                  e.target.value = "";
                }}
              />
            </label>
          </section>
        )}

        {step === 1 && (
          <section className="modal-body">
            <h2 id="onboarding-title">What do you do for work?</h2>
            <p className="modal-lede">
              {hasCv
                ? "Filled in from your CV. Fix anything that’s off."
                : "Your current or most recent job title, and what the work actually involves."}
            </p>
            <JobTitles titles={titles} onChange={onTitles} />
            <label className="cv-row">
              <span className="q-text">What do you actually do?</span>
              <span className="q-help">A few lines in your own words. Titles hide a lot.</span>
              <textarea
                className="field area"
                rows={3}
                placeholder="Run the front desk, handle bookings and complaints, train new staff, plan the weekly rota"
                value={description}
                onChange={(e) => onDescription(e.target.value)}
              />
            </label>
            <div className="cv-row">
              <span className="q-text">How much work experience do you have?</span>
              <ExperiencePicker years={experienceYears} onChange={onExperience} />
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="modal-body">
            <h2 id="onboarding-title">What are you into?</h2>
            <label className="cv-row">
              <span className="q-text">What do you do for fun?</span>
              <span className="q-help">Hobbies, side projects, things you’d do unpaid. We match them to fields of work.</span>
              <textarea
                className="field area"
                rows={2}
                placeholder="Gardening, cycling, cooking for friends"
                value={hobbies}
                onChange={(e) => onHobbies(e.target.value)}
              />
            </label>
            <div className="cv-row">
              <span className="q-text">Topics you’d enjoy working with</span>
              <span className="q-help">Whether or not they’re part of your job now. Pick as many as you like.</span>
            </div>
            {meta && <ChipGroups chips={meta.chips} order={meta.riasec_order} picked={profile.chips} onToggle={onToggleChip} />}
          </section>
        )}

        {step === 3 && (
          <section className="modal-body">
            <h2 id="onboarding-title">What do you want from a change?</h2>
            <p className="modal-lede">Pick any that matter. They reorder your suggestions; nothing gets hidden.</p>
            <GoalPicker goals={profile.goals ?? []} onToggle={onToggleGoal} />
            <p className="modal-lede">
              Then welcome to Job City: every block is a job, and neighbours need similar skills. Your best next stops
              are the numbered pins. Click one to see what it is and how you’d get there.
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
