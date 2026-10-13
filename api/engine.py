"""Scoring logic behind the API: profile → origin station → ranker → history blend → interests → outlook."""
import json
from dataclasses import dataclass, field
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from rapidfuzz import fuzz, process, utils

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "api" / "assets"
DERIVED = ROOT / "data" / "derived"

PAIR_FEATURES = ["log_dest_size", "log_origin_size", "wage_diff", "zone_diff", "same_major", "sim_ks"]
IMPUTE_RIDGE = 1.0  # same regularisation as impute_k in notebook 05
# Weight on a person's own rating when nudging a known profile toward it. From the classmate survey:
# self-ratings are ~1.2 points off O*NET while occupations differ by ~0.66 per item, so the
# shrinkage weight is 0.66^2 / (0.66^2 + 1.2^2) ~= 0.23.
ANSWER_WEIGHT = 0.25
MIN_ANSWERS_FOR_RANK_MATCH = 4
# People in software read "Engineering and Technology" as software engineering. For jobs where computer
# knowledge is central, that answer is moved to "Computers and Electronics" (classmate survey: the real job's
# match rank improved for all 5 software-type respondents).
ENGINEERING_ITEM = "kn: Engineering and Technology"
COMPUTERS_ITEM = "kn: Computers and Electronics"
SOFTWARE_JOB_THRESHOLD = 4.0  # O*NET importance of Computers and Electronics for the job


@dataclass
class Profile:
    """Everything a person has told us so far. Every field is optional."""
    job: int | None = None                                   # census code of current / last job
    answers: dict[str, float] = field(default_factory=dict)  # survey item key -> 1..5
    chips: list[str] = field(default_factory=list)           # interest area names
    quiz: dict[str, float] = field(default_factory=dict)     # quiz activity id -> 1..5
    education: str | None = None                             # BLS education label


class Engine:
    def __init__(self):
        self.meta = json.loads((ASSETS / "meta.json").read_text())
        self.census = pd.read_parquet(ASSETS / "census.parquet").set_index("census")
        self.codes = self.census.index.to_numpy()
        self.position = {code: i for i, code in enumerate(self.codes)}

        self.item_order = self.meta["item_order"]
        self.item_position = {key: i for i, key in enumerate(self.item_order)}
        self.onet_mean = np.array(self.meta["onet_mean"])
        self.onet_scale = np.array(self.meta["onet_scale"])
        self.pca = np.array(self.meta["pca_components"])
        self.census_mean = np.array(self.meta["census_mean"])
        self.census_scale = np.array(self.meta["census_scale"])

        skills = pd.read_parquet(ASSETS / "census-skills.parquet").set_index("census").loc[self.codes, self.item_order]
        self.census_skills_raw = skills.to_numpy()
        standardized = (self.census_skills_raw - self.census_mean) / self.census_scale
        self.census_skills_unit = standardized / np.linalg.norm(standardized, axis=1, keepdims=True)

        riasec = pd.read_parquet(ASSETS / "census-riasec.parquet").set_index("census").loc[self.codes, self.meta["riasec_order"]]
        self.census_riasec = riasec.to_numpy()
        self.interest_areas = pd.read_parquet(ASSETS / "census-interest-areas.parquet").set_index("census").loc[self.codes]
        self.quiz_type = {q["id"]: q["type"] for q in self.meta["quiz"]}

        config = json.loads((DERIVED / "ranker-config.json").read_text())
        self.flow_scale = config["flow_scale_w"]
        self.blend_k = config["known_occupation"]["k"]
        self.known_model = joblib.load(DERIVED / config["known_occupation"]["model"])["model"]
        self.new_model = joblib.load(DERIVED / config["new_profile"]["model"])["model"]
        history = pd.read_parquet(DERIVED / config["history_file"])
        history = history[history["OCC10LY"].isin(self.position) & history["OCC2010"].isin(self.position)]
        self.history = np.zeros((len(self.codes), len(self.codes)))
        self.history[history["OCC10LY"].map(self.position), history["OCC2010"].map(self.position)] = (
            history["weighted_movers"] / self.flow_scale)

        search = pd.read_parquet(ASSETS / "title-search.parquet")
        self.search_titles = search["title"].tolist()
        self.search_rows = search[["title", "census", "onet_title", "source"]].to_dict("records")

        self.education_rank = {label: i for i, label in enumerate(self.meta["education_ladder"])}

        city = pd.read_parquet(ASSETS / "census-map.parquet").set_index("census").loc[self.codes]
        layout = json.loads((ASSETS / "map.json").read_text())
        self.city = {
            "stations": [
                {"census": int(code), "title": self.census.at[code, "title"], "family": self.census.at[code, "family"],
                 "x": float(row.x), "y": float(row.y), "district": int(row.district)}
                for code, row in city.iterrows()
            ],
            "districts": layout["districts"],
            "lines": layout["lines"],
            "blocks": layout["blocks"],
        }

    # ---- lookups ---------------------------------------------------------------------------
    def search_jobs(self, query: str, limit: int = 8):
        """Fuzzy match a typed job title against O*NET titles, alternate titles and reported titles."""
        if len(query.strip()) < 2:
            return []
        query = _expand_abbreviations(query)
        matches = process.extract(query, self.search_titles, scorer=_title_score,
                                  processor=utils.default_process, limit=limit * 6)
        seen, results = set(), []
        for _, score, i in matches:
            row = self.search_rows[i]
            if row["census"] in seen:
                continue
            seen.add(row["census"])
            results.append({"census": int(row["census"]), "matched_title": row["title"],
                            "occupation": self.census.at[row["census"], "title"], "score": round(score)})
            if len(results) == limit:
                break
        return results

    def occupation(self, code: int):
        row = self.census.loc[code]
        return {"census": int(code), **_clean(row.to_dict())}

    # ---- skills ----------------------------------------------------------------------------
    def impute(self, answered: dict[str, float]):
        """Raw 1-5 vector over the 43 items: answered items as given, the rest filled from the PCA patterns."""
        observed = np.array([self.item_position[k] for k in answered])
        z_obs = (np.array(list(answered.values()), dtype=float) - self.onet_mean[observed]) / self.onet_scale[observed]
        loadings = self.pca[:, observed]
        latent = np.linalg.solve(loadings @ loadings.T + IMPUTE_RIDGE * np.eye(len(self.pca)), loadings @ z_obs)
        z = latent @ self.pca
        z[observed] = z_obs
        return z * self.onet_scale + self.onet_mean

    def nearest_stations(self, answered: dict[str, float], k: int = 5):
        """The k occupations that best match the answers, with weights summing to 1.

        Two match scores are combined as percentiles: cosine similarity on the imputed profile, and (with
        enough answers) rank correlation between the *order* of the person's ratings and each occupation's
        order on the same items, which ignores how generously someone uses the 1-5 scale. On the classmate
        survey the combination put people's real job at a median rank of ~30 of 517 (cosine alone: ~70),
        but the single best match was often wrong, so the planner starts from several nearby stations.
        """
        match = _percentile(self.skill_similarity(self.impute(answered)))
        if len(answered) >= MIN_ANSWERS_FOR_RANK_MATCH:
            cols = [self.item_position[key] for key in answered]
            person = pd.Series(list(answered.values())).rank().to_numpy()
            person = person - person.mean()
            if np.linalg.norm(person) > 0:
                occupations = pd.DataFrame(self.census_skills_raw[:, cols]).rank(axis=1).to_numpy()
                occupations = occupations - occupations.mean(axis=1, keepdims=True)
                denom = np.linalg.norm(occupations, axis=1) * np.linalg.norm(person)
                order_match = occupations @ person / np.where(denom == 0, np.inf, denom)
                match = match + _percentile(order_match)
        top = np.argsort(-match)[:k]
        weights = np.arange(k, 0, -1, dtype=float)
        return top, weights / weights.sum()

    def reinterpret_for_software(self, answered: dict[str, float], job_row: int):
        """Move an Engineering answer to Computers and Electronics when the job is a software-type job."""
        computers = self.item_position[COMPUTERS_ITEM]
        if (ENGINEERING_ITEM in answered and COMPUTERS_ITEM not in answered
                and self.census_skills_raw[job_row, computers] >= SOFTWARE_JOB_THRESHOLD):
            answered = dict(answered)
            answered[COMPUTERS_ITEM] = answered.pop(ENGINEERING_ITEM)
        return answered

    def nudged_profile(self, anchor: int, answered: dict[str, float]):
        """The anchor occupation's profile, with answered items moved a quarter of the way to the person's rating.

        Noisy self-ratings refine a reliable occupation profile instead of replacing it (ANSWER_WEIGHT).
        """
        vector = self.census_skills_raw[anchor].copy()
        for key, value in answered.items():
            i = self.item_position[key]
            vector[i] = (1 - ANSWER_WEIGHT) * vector[i] + ANSWER_WEIGHT * value
        return vector

    def skill_similarity(self, raw_vector):
        standardized = (raw_vector - self.census_mean) / self.census_scale
        return self.census_skills_unit @ (standardized / np.linalg.norm(standardized))

    # ---- ranker ----------------------------------------------------------------------------
    def move_shares(self, origin: int, similarity: np.ndarray, known_job: bool):
        """Share of movers from `origin` expected to land in each occupation (sums to 1 over destinations)."""
        o = self.position[origin]
        c = self.census
        medians = self.meta["pair_medians"]
        pairs = pd.DataFrame({
            "log_dest_size": c["log_size"].to_numpy(),
            "log_origin_size": c["log_size"].iat[o],
            "wage_diff": c["log_wage"].to_numpy() - c["log_wage"].iat[o],
            "zone_diff": c["job_zone"].to_numpy() - c["job_zone"].iat[o],
            "same_major": (c["soc_major"].to_numpy() == c["soc_major"].iat[o]).astype(int),
            "sim_ks": similarity,
        })[PAIR_FEATURES].fillna(medians)
        model = self.known_model if known_job else self.new_model
        predicted = model.predict(pairs)
        predicted[o] = 0.0
        share = predicted / predicted.sum()
        if known_job:
            observed = self.history[o].copy()
            observed[o] = 0.0
            share = (observed + self.blend_k * share) / (observed.sum() + self.blend_k)
        return share

    # ---- interests -------------------------------------------------------------------------
    def interest_fit(self, profile: Profile):
        """Percentile (0-1) of how well each occupation matches the person's interests, or None."""
        parts = []
        chips = [chip for chip in profile.chips if chip in self.interest_areas.columns]
        if chips:
            parts.append(_percentile(self.interest_areas[chips].mean(axis=1).to_numpy()))
        by_type = {}
        for qid, value in profile.quiz.items():
            if qid in self.quiz_type:
                by_type.setdefault(self.quiz_type[qid], []).append(value)
        if len(by_type) >= 2:
            order = [t for t in self.meta["riasec_order"] if t in by_type]
            person = np.array([np.mean(by_type[t]) for t in order])
            cols = [self.meta["riasec_order"].index(t) for t in order]
            occ = self.census_riasec[:, cols]
            person_c = person - person.mean()
            occ_c = occ - occ.mean(axis=1, keepdims=True)
            if np.linalg.norm(person_c) > 0:
                fit = occ_c @ person_c / (np.linalg.norm(occ_c, axis=1) * np.linalg.norm(person_c) + 1e-9)
                parts.append(_percentile(fit))
        return np.mean(parts, axis=0) if parts else None

    # ---- main entry ------------------------------------------------------------------------
    def recommend(self, profile: Profile, sort: str = "best", limit: int = 30):
        answered = {k: v for k, v in profile.answers.items() if k in self.item_position}
        origin, origin_kind, nearby, similarity, reach = None, None, [], None, None

        if profile.job is not None and profile.job in self.position:
            origin, origin_kind = profile.job, "your job"
            answered = self.reinterpret_for_software(answered, self.position[origin])
            similarity = self.skill_similarity(self.nudged_profile(self.position[origin], answered))
            reach = self.move_shares(origin, similarity, known_job=True)
        elif answered:
            stations, weights = self.nearest_stations(answered)
            origin, origin_kind = int(self.codes[stations[0]]), "nearest station"
            nearby = [self.census["title"].iat[i] for i in stations[1:]]
            reach = np.zeros(len(self.codes))
            similarity = np.zeros(len(self.codes))
            for station, weight in zip(stations, weights):
                station_similarity = self.skill_similarity(self.nudged_profile(station, answered))
                reach += weight * self.move_shares(int(self.codes[station]), station_similarity, known_job=False)
                similarity += weight * station_similarity
        n_answered = len(answered)

        appeal = self.interest_fit(profile)

        frame = self.census.copy()
        frame["skill_match"] = similarity
        frame["reach_share"] = reach
        frame["reach_pct"] = _percentile(reach) if reach is not None else None
        frame["reach_score"] = _log_scale(reach) if reach is not None else None
        frame["appeal_pct"] = appeal
        if origin is not None:
            frame = frame.drop(index=origin)
            frame["same_line"] = frame["soc_major"] == self.census.at[origin, "soc_major"]
        user_level = self.education_rank.get(profile.education) if profile.education else None
        frame["education_gap"] = frame["education_level"] - user_level if user_level is not None else None

        if reach is not None and appeal is not None:
            frame["best"] = np.sqrt(frame["reach_score"] * frame["appeal_pct"])
        elif reach is not None:
            frame["best"] = frame["reach_share"]
        elif appeal is not None:
            frame["best"] = frame["appeal_pct"]
        else:
            frame["best"] = None
        order_by = {"best": "best", "reachable": "reach_share", "appealing": "appeal_pct"}.get(sort, "best")
        if frame[order_by].isna().all():
            order_by = "best"
        ranked = frame.sort_values(order_by, ascending=False).head(limit) if frame[order_by].notna().any() else frame.head(0)

        return {
            "origin": self.occupation(origin) | {"kind": origin_kind, "nearby": nearby} if origin else None,
            "signals": {
                "job": profile.job is not None,
                "skills_answered": n_answered,
                "skills_total": len(self.item_order),
                "chips": len(profile.chips),
                "quiz_answered": len(profile.quiz),
                "education": profile.education is not None,
            },
            "confidence": _confidence(profile, n_answered),
            "sort": order_by,
            "results": [{"census": int(code), **_clean(row.to_dict())} for code, row in ranked.iterrows()],
        }


ABBREVIATIONS = {
    "it": "information technology", "hr": "human resources", "ux": "user experience", "ui": "user interface",
    "qa": "quality assurance", "pm": "project manager", "em": "engineering manager", "cto": "chief technology officer",
    "ceo": "chief executive officer", "cfo": "chief financial officer", "rn": "registered nurse", "swe": "software engineer",
    "sde": "software developer", "ml": "machine learning", "ai": "artificial intelligence", "devops": "development operations",
}


def _expand_abbreviations(query: str) -> str:
    return " ".join(ABBREVIATIONS.get(word, word) for word in query.lower().split())


def _title_score(query, title, **kwargs):
    """Whole-title similarity, with a slightly discounted subset match ('nurse' in 'charge nurse').

    Titles that contain every query word get a small boost, so 'information technology manager' prefers
    'IT manager'-type titles over 'gaming managers'.
    """
    score = max(fuzz.QRatio(query, title), 0.9 * fuzz.token_set_ratio(query, title))
    words = query.split()
    if words and all(word in title for word in words):
        score += 5
    return score


def _log_scale(share, floor=1e-4):
    """Move shares span orders of magnitude; map log10(share) onto 0-1 between `floor` and the best stop."""
    logs = np.log10(np.clip(share, floor, None))
    top = logs.max()
    return np.clip((logs - np.log10(floor)) / (top - np.log10(floor)), 0, 1) if top > np.log10(floor) else logs * 0


def _percentile(values):
    return pd.Series(values).rank(pct=True).to_numpy()


def _confidence(profile: Profile, n_answered: int):
    """Rough 0-1 indicator of how much the results rest on, for the UI. Not a calibrated probability."""
    score = 0.0
    score += 0.35 if profile.job is not None else 0.0
    score += 0.35 * min(n_answered / 15, 1.0)
    score += 0.1 * min(n_answered / 43, 1.0)
    score += 0.1 if (profile.chips or len(profile.quiz) >= 6) else 0.0
    score += 0.1 if profile.education else 0.0
    return round(min(score, 1.0), 2)


def _clean(record: dict):
    out = {}
    for key, value in record.items():
        if isinstance(value, (np.floating, float)):
            out[key] = None if np.isnan(value) else round(float(value), 4)
        elif isinstance(value, (np.integer,)):
            out[key] = int(value)
        elif isinstance(value, np.bool_):
            out[key] = bool(value)
        elif value is pd.NA or value is None:
            out[key] = None
        else:
            out[key] = value
    return out
