// The workspace: several plans (one per move the person is weighing), each with its own conversation, plus an
// Explore conversation for everything that isn't about one plan yet. Kept in this browser.
import type { ChatMessage } from "./api";
import { loadPlan, type ApplicationStatus, type Plan, type PlanLink, type SavedOpening } from "./plan";

export const EXPLORE = "explore";
export type StoredTurn = ChatMessage & { failed?: boolean; error?: string; suggestions?: string[] };
export type Workspace = {
  plans: Plan[];
  chats: Record<string, StoredTurn[]>; // EXPLORE or a plan id -> its conversation
  active: string; // EXPLORE or a plan id
  memory?: Record<string, Memory>; // a conversation's older part, summarized for the guide
};

// Compaction: every message resends the conversation, so long ones get slow and costly. Once the part the guide
// hasn't had summarized passes these sizes, everything but the last few messages is summarized once (Haiku) and
// the summary goes along instead. The person still sees every message.
export type Memory = { summary: string; upTo: number }; // upTo: how many sent messages the summary covers
export const COMPACT_AT_CHARS = 60_000; // ~15k tokens
export const COMPACT_AT_MESSAGES = 40;
export const KEEP_RECENT = 12;
export const SEND_MAX_CHARS = 12_000; // a very long older message goes trimmed (the screen keeps it whole)

const KEY = "job-transit-workspace-v1";
const OLD_CHAT_KEY = "job-transit-chat-v1";
export const EMPTY: Workspace = { plans: [], chats: { [EXPLORE]: [] }, active: EXPLORE };
export const MAX_PLANS = 5;

export const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** Tab name: what the guide called it, else the occupation up to its first comma or "&" ("IT project managers"). */
export const planName = (plan: Plan) => plan.name || plan.occupation.split(/,| & | and /)[0].trim();

export function loadWorkspace(): Workspace {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Workspace | null;
    if (saved && Array.isArray(saved.plans) && saved.chats) {
      const active = saved.active === EXPLORE || saved.plans.some((p) => p.id === saved.active) ? saved.active : EXPLORE;
      const ids = new Set([EXPLORE, ...saved.plans.map((p) => p.id)]);
      const chats = Object.fromEntries(
        [[EXPLORE, []] as [string, StoredTurn[]], ...Object.entries(saved.chats)]
          .filter(([id]) => ids.has(id)) // no conversations left over from removed paths
          .map(([id, turns]) => [id, repairTurns(turns)]),
      );
      const plans = saved.plans.map((p) => collectLinks(p, chats[p.id!] ?? [])); // paths from before Links
      return { plans, chats, active, memory: saved.memory ?? {} };
    }
    // before plan tabs: one plan and one conversation. The conversation becomes Explore, the plan its own tab.
    const plan = loadPlan();
    const chat = JSON.parse(localStorage.getItem(OLD_CHAT_KEY) ?? "[]") as StoredTurn[];
    const plans = plan ? [{ ...plan, id: plan.id ?? newId() }] : [];
    const chats: Record<string, StoredTurn[]> = { [EXPLORE]: Array.isArray(chat) ? chat : [] };
    for (const p of plans) chats[p.id!] = [];
    return { plans, chats, active: EXPLORE };
  } catch {
    return EMPTY;
  }
}

export const STORE_TURNS = 200; // per conversation: older turns are covered by the summary anyway

export function saveWorkspace(ws: Workspace) {
  try {
    const chats = Object.fromEntries(
      Object.entries(ws.chats).map(([id, turns]) => [
        id,
        turns
          .filter((t) => t && t.role && typeof t.content === "string")
          .slice(-STORE_TURNS)
          .map(({ role, content, failed, error }) => (failed ? { role, content, failed, error } : { role, content })),
      ]),
    );
    localStorage.setItem(KEY, JSON.stringify({ ...ws, chats }));
  } catch {
    /* not remembered */
  }
}

/** Turns saved mid-answer (the page closed while the guide was writing): drop broken and empty replies, and mark
 * a question left without an answer as not sent, so it gets a Retry. */
function repairTurns(turns: StoredTurn[]): StoredTurn[] {
  const clean = (Array.isArray(turns) ? turns : []).filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string");
  const out = clean.filter((t, i) => !(t.role === "assistant" && !t.content && i === clean.length - 1));
  const last = out[out.length - 1];
  if (last?.role === "user" && !last.failed) out[out.length - 1] = { ...last, failed: true, error: "The page closed before the answer arrived." };
  return out;
}

/** Add or replace a plan. A plan for a move that already has one revises it (same id, same conversation). */
export function upsertPlan(ws: Workspace, plan: Plan): { ws: Workspace; id: string; created: boolean } {
  const existing = ws.plans.find((p) => p.id === plan.id || p.census === plan.census);
  if (existing) {
    const id = existing.id!;
    return { ws: { ...ws, plans: ws.plans.map((p) => (p.id === id ? { ...plan, id } : p)) }, id, created: false };
  }
  const id = plan.id ?? newId();
  // at most MAX_PLANS paths: the oldest goes, with its conversation (removePlan), not just its entry
  let base = ws;
  while (base.plans.length >= MAX_PLANS) base = removePlan(base, base.plans[0].id!);
  const intro: StoredTurn = {
    role: "assistant",
    content: planIntro(plan),
    suggestions: ["Help me start the first step", "Find openings for this move", "Quiz me on what I'm learning"],
  };
  return {
    ws: { ...base, plans: [...base.plans, { ...plan, id }], chats: { ...base.chats, [id]: [intro] } },
    id,
    created: true,
  };
}

const shortDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** The first message in a new path's conversation: what the plan is, step by step, so the talk starts from it. */
export function planIntro(plan: Plan): string {
  const steps = plan.steps
    .map((s, i) => {
      const due = s.due ? shortDate(s.due) : "";
      return `${i + 1}. **${s.title}**${due ? ` (by ${due})` : ""}`;
    })
    .join("\n");
  return [
    `This is your path to **${plan.occupation}**.`,
    (plan.summary ?? "").trim(),
    steps ? `The plan:\n\n${steps}` : "",
    "This conversation is just about this move. Ask me for help with a step, a practice session, openings, or changes to the plan.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function removePlan(ws: Workspace, id: string): Workspace {
  const chats = { ...ws.chats };
  delete chats[id];
  const memory = { ...ws.memory };
  delete memory[id];
  return { plans: ws.plans.filter((p) => p.id !== id), chats, memory, active: ws.active === id ? EXPLORE : ws.active };
}

export const activePlan = (ws: Workspace) => ws.plans.find((p) => p.id === ws.active) ?? null;

// ---- openings kept with a plan -------------------------------------------------------------------------------
const today = () => {
  const d = new Date(); // the local date, like the plan's due dates (toISOString would give the UTC one)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const KEEP_FOUND = 5; // unsaved finds kept per plan; saved ones are always kept

/** Openings just found for this plan's move: add them as "found" (newest first, at most KEEP_FOUND of those),
 * leaving the ones the person saved or hid as they are. */
export function addFound(plan: Plan, found: Omit<SavedOpening, "status" | "found">[]): Plan {
  const known = new Map((plan.openings ?? []).map((o) => [o.url, o]));
  const unique = [...new Map(found.map((o) => [o.url, o])).values()]; // the same posting twice in one batch
  const fresh = unique.filter((o) => !known.has(o.url)).map((o) => ({ ...o, status: "found" as const, found: today() }));
  const kept = plan.openings ?? [];
  const unsaved = [...fresh, ...kept.filter((o) => o.status === "found")].slice(0, KEEP_FOUND);
  return { ...plan, openings: [...unsaved, ...kept.filter((o) => o.status !== "found")] };
}

export function setOpeningStatus(plan: Plan, url: string, status: ApplicationStatus): Plan {
  return {
    ...plan,
    openings: (plan.openings ?? []).map((o) => (o.url === url ? { ...o, status, updated: today() } : o)),
  };
}

/** What the guide gets about the other plans: enough to connect them, not their whole conversations. */
export function otherPlansForChat(ws: Workspace, current: string) {
  return ws.plans
    .filter((p) => p.id !== current)
    .map((p) => ({
      name: planName(p),
      occupation: p.occupation,
      census: p.census,
      steps_done: p.steps.filter((s) => s.done).length,
      steps: p.steps.length,
      saved_openings: (p.openings ?? []).filter((o) => !["found", "hidden"].includes(o.status)).length,
    }));
}

/** Recent messages of the other conversations, for the guide's read_chat tool (only sent, never stored there). */
export function otherChatsForChat(ws: Workspace, current: string, perChat = 12) {
  return Object.fromEntries(
    Object.entries(ws.chats)
      .filter(([id, turns]) => id !== current && turns.length && (id === EXPLORE || ws.plans.some((p) => p.id === id)))
      .map(([id, turns]) => {
        const plan = ws.plans.find((p) => p.id === id);
        return [
          plan ? planName(plan) : "Explore",
          turns
            .filter((t) => t && typeof t.content === "string" && t.content)
            .slice(-perChat)
            .map((t) => ({ role: t.role, content: t.content.slice(0, 1200) })),
        ];
      }),
  );
}

// Links: every link the guide gives in a path's conversation (and its steps' resources) lands in the plan's Links,
// except job postings, which are under openings already.
export const MAX_LINKS = 40;
const MD_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /(?<![(\[])\bhttps?:\/\/[^\s<>()\[\]"']+/g;

export function linksIn(text: string): { url: string; title: string }[] {
  const found: { url: string; title: string }[] = [];
  const rest = text.replace(MD_LINK, (_, title: string, url: string) => {
    found.push({ url, title: title.replace(/[*_`]/g, "").trim() });
    return " ";
  });
  for (const m of rest.match(BARE_URL) ?? []) {
    const url = m.replace(/[.,;:!?]+$/, "");
    try {
      const u = new URL(url);
      const title = u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname : "");
      found.push({ url, title: title.length > 60 ? `${title.slice(0, 59)}…` : title });
    } catch {}
  }
  return found;
}

/** Add the links from a path's conversation and steps that aren't kept yet. Returns the same plan when nothing's new. */
export function collectLinks(plan: Plan, turns: StoredTurn[]): Plan {
  const skip = new Set([
    ...(plan.openings ?? []).map((o) => o.url),
    ...(plan.hiddenLinks ?? []),
    ...(plan.links ?? []).map((l) => l.url),
  ]);
  const texts = [
    ...plan.steps.flatMap((s) => s.resources ?? []),
    ...turns.filter((t) => t.role === "assistant" && !t.failed).map((t) => t.content),
  ];
  const added: PlanLink[] = [];
  for (const text of texts)
    for (const l of linksIn(text)) {
      if (skip.has(l.url)) continue;
      skip.add(l.url);
      added.push({ ...l, added: today() });
    }
  if (!added.length) return plan;
  return { ...plan, links: [...(plan.links ?? []), ...added].slice(-MAX_LINKS) };
}

export const removeLink = (plan: Plan, url: string): Plan => ({
  ...plan,
  links: (plan.links ?? []).filter((l) => l.url !== url),
  hiddenLinks: [...(plan.hiddenLinks ?? []).filter((u) => u !== url), url].slice(-200),
});
