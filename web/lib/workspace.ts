// The workspace: several plans (one per move the person is weighing), each with its own conversation, plus an
// Explore conversation for everything that isn't about one plan yet. Kept in this browser.
import type { ChatMessage } from "./api";
import { loadPlan, type ApplicationStatus, type Plan, type SavedOpening } from "./plan";

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
      return { plans: saved.plans, chats: { [EXPLORE]: [], ...saved.chats }, active, memory: saved.memory ?? {} };
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

export function saveWorkspace(ws: Workspace) {
  try {
    const chats = Object.fromEntries(
      Object.entries(ws.chats).map(([id, turns]) => [
        id,
        turns.map(({ role, content, failed, error }) => (failed ? { role, content, failed, error } : { role, content })),
      ]),
    );
    localStorage.setItem(KEY, JSON.stringify({ ...ws, chats }));
  } catch {
    /* not remembered */
  }
}

/** Add or replace a plan. A plan for a move that already has one revises it (same id, same conversation). */
export function upsertPlan(ws: Workspace, plan: Plan): { ws: Workspace; id: string; created: boolean } {
  const existing = ws.plans.find((p) => p.id === plan.id || p.census === plan.census);
  if (existing) {
    const id = existing.id!;
    return { ws: { ...ws, plans: ws.plans.map((p) => (p.id === id ? { ...plan, id } : p)) }, id, created: false };
  }
  const id = plan.id ?? newId();
  const intro: StoredTurn = {
    role: "assistant",
    content:
      `This is the space for your move to **${plan.occupation}**. Your plan is in the plan panel. ` +
      "Ask me anything about it here: help with a step, a practice session, openings, or changes to the plan.",
    suggestions: ["Help me start the first step", "Find openings for this move", "Quiz me on what I'm learning"],
  };
  return {
    ws: { ...ws, plans: [...ws.plans, { ...plan, id }].slice(-MAX_PLANS), chats: { ...ws.chats, [id]: [intro] } },
    id,
    created: true,
  };
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
const today = () => new Date().toISOString().slice(0, 10);
export const KEEP_FOUND = 5; // unsaved finds kept per plan; saved ones are always kept

/** Openings just found for this plan's move: add them as "found" (newest first, at most KEEP_FOUND of those),
 * leaving the ones the person saved or hid as they are. */
export function addFound(plan: Plan, found: Omit<SavedOpening, "status" | "found">[]): Plan {
  const known = new Map((plan.openings ?? []).map((o) => [o.url, o]));
  const fresh = found.filter((o) => !known.has(o.url)).map((o) => ({ ...o, status: "found" as const, found: today() }));
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
      .filter(([id, turns]) => id !== current && turns.length)
      .map(([id, turns]) => {
        const plan = ws.plans.find((p) => p.id === id);
        return [
          plan ? planName(plan) : "Explore",
          turns.slice(-perChat).map((t) => ({ role: t.role, content: t.content.slice(0, 1200) })),
        ];
      }),
  );
}
