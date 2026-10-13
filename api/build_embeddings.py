"""Embeds O*NET task statements and occupation descriptions for placement, and indexes tools.

Run after export_embedder.py:  uv run python api/build_embeddings.py
Writes api/assets/embed/task-vectors.npy, task-index.json and tools.json.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from api.embeddings import EMBED_DIR, Embedder  # noqa: E402

RAW = ROOT / "data" / "raw" / "db_31_0_csv"
crosswalk = pd.read_parquet(ROOT / "data" / "derived" / "census-onet-crosswalk.parquet")
census_of = crosswalk.groupby("onet")["census"].first()

tasks = pd.read_csv(RAW / "task_statements.csv")[["O*NET-SOC Code", "Title", "Task"]]
occupations = pd.read_csv(RAW / "occupation_data.csv")[["O*NET-SOC Code", "Title", "Description"]]
occupations = occupations.rename(columns={"Description": "Task"})
docs = pd.concat([tasks, occupations], ignore_index=True)
docs["census"] = docs["O*NET-SOC Code"].map(census_of)
docs = docs.dropna(subset=["census"]).reset_index(drop=True)

vectors = Embedder().encode(docs["Task"].tolist(), batch_size=128)
np.save(EMBED_DIR / "task-vectors.npy", vectors.astype(np.float16))
(EMBED_DIR / "task-index.json").write_text(json.dumps({
    "text": docs["Task"].tolist(),
    "census": docs["census"].astype(int).tolist(),
    "onet": docs["O*NET-SOC Code"].tolist(),
    "title": docs["Title"].tolist(),
}))

tools = pd.read_csv(RAW / "software_skills.csv")[["O*NET-SOC Code", "Workplace Example"]]
tools["census"] = tools["O*NET-SOC Code"].map(census_of)
tools = tools.dropna(subset=["census"])
tool_map = {name: sorted(set(group["census"].astype(int))) for name, group in tools.groupby("Workplace Example")}
(EMBED_DIR / "tools.json").write_text(json.dumps(tool_map))
print(f"{len(docs):,} task statements and descriptions embedded; {len(tool_map):,} tools indexed")
