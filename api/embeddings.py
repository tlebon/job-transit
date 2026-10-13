"""Places a person among occupations from what they actually do (CV activities, a description, tools).

Text is embedded with a small sentence-embedding model (multi-qa-MiniLM-L6, exported from PyTorch to ONNX
and quantized to int8 so the API needs no PyTorch) and matched against all ~18k O*NET task statements and
occupation descriptions. Each statement votes for the occupations whose tasks it resembles most; named tools
add votes for the occupations that use them (rarer tools count more). The result is a weighted mix of
occupations rather than one title, so hybrid roles and "same title, different job" come out naturally.

Scoring: for each statement, every O*NET occupation gets the mean similarity of its two closest tasks; scores
are averaged over statements, so an occupation has to match *several* things the person does (a single generic
match such as "mentor junior colleagues" can't carry it). Scoring happens per O*NET occupation (similar task
counts) and a census occupation takes its best O*NET member; scoring census groups directly favoured big groups
like "Postsecondary teachers" (38 O*NET codes). Tried first: each statement voting for its top-15 tasks, which let
one generic task from an unrelated occupation dominate.
"""
import json
import re
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

EMBED_DIR = Path(__file__).resolve().parent / "assets" / "embed"
TOP_TASKS_PER_OCCUPATION = 2  # an occupation's match to a statement = mean of its 2 closest tasks
TEMPERATURE = 0.02            # softmax temperature turning occupation scores into weights
TOOL_SHARE = 0.3              # share of the vote given to tools when both text and tools are present


class Embedder:
    def __init__(self, directory: Path = EMBED_DIR):
        self.session = ort.InferenceSession(str(directory / "model.onnx"), providers=["CPUExecutionProvider"])
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.enable_padding()
        self.tokenizer.enable_truncation(128)

    def encode(self, texts: list[str], batch_size: int = 64) -> np.ndarray:
        out = []
        for start in range(0, len(texts), batch_size):
            batch = self.tokenizer.encode_batch(texts[start:start + batch_size])
            ids = np.array([e.ids for e in batch], dtype=np.int64)
            mask = np.array([e.attention_mask for e in batch], dtype=np.int64)
            hidden = self.session.run(None, {"input_ids": ids, "attention_mask": mask,
                                             "token_type_ids": np.zeros_like(ids)})[0]
            pooled = (hidden * mask[..., None]).sum(axis=1) / mask.sum(axis=1, keepdims=True)
            out.append(pooled / np.linalg.norm(pooled, axis=1, keepdims=True))
        return np.vstack(out).astype(np.float32)


def split_statements(text: str) -> list[str]:
    """Break free text into short statements (lines, bullets, sentences)."""
    parts = re.split(r"[\n\r•·▪*]+|(?<=[.!?;])\s+", text)
    return [p.strip(" -–—\t") for p in parts if len(p.strip()) > 12]


class Placer:
    def __init__(self, codes: np.ndarray, directory: Path = EMBED_DIR):
        self.embedder = Embedder(directory)
        self.vectors = np.load(directory / "task-vectors.npy").astype(np.float32)
        index = json.loads((directory / "task-index.json").read_text())
        self.task_text = index["text"]
        self.task_census = np.array(index["census"])
        self.task_title = index["title"]
        self.position = {int(c): i for i, c in enumerate(codes)}
        self.n = len(codes)
        self.task_row = np.array([self.position.get(int(c), -1) for c in self.task_census])
        onet = np.array(index["onet"])
        keep = np.array([int(c) in self.position for c in self.task_census])
        order = np.argsort(onet, kind="stable")
        self.task_order = order[keep[order]]                           # tasks grouped by O*NET occupation
        _, self.group_starts = np.unique(onet[self.task_order], return_index=True)
        self.group_rows = np.array([self.position[int(self.task_census[self.task_order[i]])] for i in self.group_starts])
        tools = json.loads((directory / "tools.json").read_text())
        self.tool_names = list(tools)
        self.tool_census = tools

    @staticmethod
    def _tool_key(name: str) -> str:
        return re.sub(r"[^a-z0-9+#]", "", name.lower())

    def tool_votes(self, tools: list[str]):
        """Exact matches only (case and punctuation ignored): fuzzy matching turned 'Next.js' into 'Ext JS'."""
        if not hasattr(self, "_tool_index"):
            self._tool_index = {}
            for name in self.tool_names:
                self._tool_index.setdefault(self._tool_key(name), name)
        votes, matched = np.zeros(self.n), []
        for tool in tools:
            name = self._tool_index.get(self._tool_key(tool))
            if not name:
                continue
            occupations = [self.position[c] for c in self.tool_census[name] if c in self.position]
            if occupations:
                votes[occupations] += 1.0 / len(occupations)  # tools used everywhere say little
                matched.append(name)
        return votes, matched

    def place(self, statements: list[str], tools: list[str] | None = None, k: int = 5):
        statements = [s for s in statements if s.strip()][:40]
        text_votes = np.zeros(self.n)
        evidence = []
        if statements:
            sims = self.embedder.encode(statements) @ self.vectors.T           # statements x tasks
            grouped = sims[:, self.task_order]
            scores = np.zeros((len(statements), len(self.group_rows)))
            bounds = list(self.group_starts) + [grouped.shape[1]]
            for g in range(len(self.group_rows)):
                block = grouped[:, bounds[g]:bounds[g + 1]]
                n = min(TOP_TASKS_PER_OCCUPATION, block.shape[1])
                scores[:, g] = np.sort(block, axis=1)[:, -n:].mean(axis=1)
            onet_score = scores.mean(axis=0)
            census_score = np.full(self.n, -np.inf)
            np.maximum.at(census_score, self.group_rows, onet_score)      # best O*NET member per census code
            weights = np.where(np.isfinite(census_score), np.exp((census_score - onet_score.max()) / TEMPERATURE), 0.0)
            text_votes = weights / weights.sum()
            self._sims = sims

        tool_votes, matched_tools = self.tool_votes(tools or [])
        if matched_tools:
            tool_votes /= tool_votes.sum()
        if statements and matched_tools:
            votes = (1 - TOOL_SHARE) * text_votes + TOOL_SHARE * tool_votes
        else:
            votes = text_votes if statements else tool_votes
        if votes.sum() <= 0:
            return None
        top = np.argsort(-votes)[:k]
        weights = votes[top] / votes[top].sum()
        if statements:
            evidence = self.evidence_for(statements, self._sims, top[:3])
        return {"stations": top, "weights": weights, "evidence": evidence, "tools": matched_tools}

    def evidence_for(self, statements, sims, stations, per_station: int = 2):
        """For each placed occupation, the person's lines that match its tasks best (what drove the placement)."""
        out = []
        for station in stations:
            tasks = np.flatnonzero(self.task_row == station)
            if len(tasks) == 0:
                continue
            block = sims[:, tasks]
            best_task = block.argmax(axis=1)
            best_sim = block.max(axis=1)
            for i in np.argsort(-best_sim)[:per_station]:
                t = tasks[best_task[i]]
                out.append({"placed_as": int(station), "statement": statements[i], "task": self.task_text[t],
                            "occupation": self.task_title[t], "similarity": round(float(best_sim[i]), 3)})
        return out
