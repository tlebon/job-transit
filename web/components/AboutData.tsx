"use client";

import { useEffect, useRef } from "react";

type Props = { onClose: () => void };

/** Where every number in the app comes from, in plain words. */
export function AboutData({ onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal about" role="dialog" aria-modal="true" aria-labelledby="about-title" ref={panel} tabIndex={-1}>
        <section className="modal-body">
          <h2 id="about-title">About the data</h2>
          <p className="modal-lede">
            Most of the data is from the US, where the best public data on real job changes exists. It’s good for
            comparing jobs with each other; local pay and openings come from live sources.
          </p>
          <dl className="about-list">
            <div>
              <dt>Which moves people make</dt>
              <dd>
                The US Current Population Survey (CPS), 2015–2025, via IPUMS: about 720,000 workers who said what job
                they had last year and this year. The ranking learned from 2015–2021 and was tested on 2022–2025:
                people’s real next job was in its top 10 for 62% of them.
              </dd>
            </div>
            <div>
              <dt>What each job involves</dt>
              <dd>
                O*NET 31.0, the US Department of Labor’s database of about 900 occupations: their skills, knowledge
                and everyday tasks. Skill gaps and “what the job is” come from here.
              </dd>
            </div>
            <div>
              <dt>Pay, growth and education</dt>
              <dd>
                The US Bureau of Labor Statistics (BLS), Employment Projections 2025–2035: median pay, expected
                growth and the education a job usually asks for. These are US figures, so use them to compare jobs,
                not as your local salary.
              </dd>
            </div>
            <div>
              <dt>AI exposure</dt>
              <dd>
                Three views: the BLS’s own rating of each job; a research estimate of how much of each job’s tasks
                AI could speed up (Eloundou et al., 2023); and how often people actually use Claude for each job’s
                tasks (Anthropic Economic Index).
              </dd>
            </div>
            <div>
              <dt>Openings</dt>
              <dd>
                Live postings from Adzuna, the Bundesagentur für Arbeit (Germany’s public job board, with pay ranges
                and whether an ad is open to career changers), Arbeitnow, 80,000 Hours and AI companies’ own job boards.
              </dd>
            </div>
            <div>
              <dt>Your data</dt>
              <dd>
                Your profile and plan stay in this browser. If you turn on email reminders, we store your address and
                the reminder dates, and every email has a link to stop them. When you save an opening or mark it “Not
                for me”, we keep that choice with the posting, under a random id for this browser and nothing else
                about you, to learn which openings to show first.
              </dd>
            </div>
          </dl>
          <div className="modal-actions">
            <span />
            <button type="button" className="action" onClick={onClose}>
              Close
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
