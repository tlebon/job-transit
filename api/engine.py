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
SENIOR_BOOST = 1.2              # best-fit multiplier for jobs needing 5+ years, when you have them
JUNIOR_PENALTY = 0.7            # ... and when you don't (still shown, just lower)
# When someone gives a job title *and* describes their work, the title is a prior: every occupation gets a bonus
# of TITLE_PRIOR_STRENGTH x its skill similarity to the title before the text placement's softmax. The text then
# decides where in the title's neighbourhood you sit, and needs strong evidence to move you to a distant field.
# notebooks/07_placement_eval: vs the old fixed 50/50 title/text mix, 0.5 keeps the right title first ~90% of the
# time with more weight on it (0.86 vs 0.62-0.69), and lets the text fix a near-miss title about half the time
# (the 50/50 mix never could). On 14 real survey descriptions: weight on the true job 0.28 -> 0.40.
TITLE_PRIOR_STRENGTH = 0.5


@dataclass
class Profile:
    """Everything a person has told us so far. Every field is optional."""
    job: int | None = None                                   # census code of current / last job
    extra_jobs: list[int] = field(default_factory=list)      # further titles that together describe the job
    answers: dict[str, float] = field(default_factory=dict)  # survey item key -> 1..5
    chips: list[str] = field(default_factory=list)           # interest area names
    quiz: dict[str, float] = field(default_factory=dict)     # quiz activity id -> 1..5
    education: str | None = None                             # BLS education label
    description: str | None = None                           # free text: what they actually do
    activities: list[str] = field(default_factory=list)      # short statements, e.g. from a CV
    tools: list[str] = field(default_factory=list)           # software / tools they use
    hobbies: str | None = None                               # free text: what they do for fun
    goals: list[str] = field(default_factory=list)           # pay, stability, less_ai, passion
    experience_years: float | None = None                    # years of work experience (CV or self-reported)


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

        self.placer = None
        self.area_vectors = None
        if (ASSETS / "embed" / "task-vectors.npy").exists():
            from api.embeddings import Placer
            self.placer = Placer(self.codes)
            chips = self.meta["chips"]
            self.area_names = [c["name"] for c in chips]
            self.area_vectors = self.placer.embedder.encode(
                [f"{c['name']}: {c['description']}" for c in chips])
        else:
            print("Placement from text disabled: run api/export_embedder.py and api/build_embeddings.py")

        details_file = ASSETS / "census-details.json"
        self.details = json.loads(details_file.read_text()) if details_file.exists() else {}

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
    def hobby_areas(self, hobbies: str | None, per_hobby_min: float = 0.2):
        """Interest areas matching free-text hobbies ('bouldering, improv comedy'), via the embedding model.

        Each hobby is first described in a sentence by Claude when a key is available (single words embed
        poorly: 'bouldering' alone lands nearer Agriculture than Athletics), then matched to the 41 O*NET
        interest areas; each hobby contributes its best-matching area(s).
        """
        if not hobbies or self.area_vectors is None:
            return []
        import re
        try:
            from api.cv import describe_hobbies
            parts = list(describe_hobbies(hobbies.strip()))
        except Exception:
            parts = []
        if not parts:
            parts = [p.strip() for p in re.split(r"[,;\n]+", hobbies) if p.strip()]
        sims = self.placer.embedder.encode(parts[:20]) @ self.area_vectors.T      # hobbies x areas
        picked = []
        for row in sims:
            order = np.argsort(-row)
            for i in order[:2]:  # a hobby can touch two areas (bouldering: athletics, outdoors)
                if row[i] >= per_hobby_min and (i == order[0] or row[i] >= row[order[0]] - 0.03):
                    picked.append(self.area_names[i])
        return list(dict.fromkeys(picked))

    def interest_fit(self, profile: Profile, hobby_areas: list[str] | None = None):
        """Percentile (0-1) of how well each occupation matches the person's interests, or None."""
        parts = []
        chips = [chip for chip in list(profile.chips) + list(hobby_areas or []) if chip in self.interest_areas.columns]
        chips = list(dict.fromkeys(chips))
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
    def mixture(self, stations, weights, answered, known_job: bool):
        """Expected move shares and skill similarity, averaged over starting stations with the given weights."""
        reach, similarity = np.zeros(len(self.codes)), np.zeros(len(self.codes))
        vector = np.zeros(len(self.item_order))
        for station, weight in zip(stations, weights):
            station_answers = self.reinterpret_for_software(answered, station)
            station_vector = self.nudged_profile(station, station_answers)
            vector += weight * station_vector
            station_similarity = self.skill_similarity(station_vector)
            shares = self.move_shares(int(self.codes[station]), station_similarity, known_job=known_job)
            shares[stations] = 0.0  # don't suggest the places you already are
            reach += weight * shares / max(shares.sum(), 1e-12)
            similarity += weight * station_similarity
        return reach, similarity, vector

    def place(self, profile: Profile, prior: np.ndarray | None = None):
        """Weighted occupations from what the person does (statements + tools), or None.
        `prior`: per-occupation similarity to the person's job title(s), see TITLE_PRIOR_STRENGTH."""
        from api.embeddings import split_statements
        described = []
        if profile.description:
            try:
                from api.cv import activities_from_text
                described = list(activities_from_text(profile.description.strip()))
            except Exception:  # no key, network or API error: use the text as written
                described = split_statements(profile.description) or [profile.description]
        statements = list(profile.activities) + described
        if self.placer is None or not (statements or profile.tools):
            return None
        return self.placer.place(statements, profile.tools, prior=prior, prior_strength=TITLE_PRIOR_STRENGTH)

    def start(self, profile: Profile):
        """Where the person starts: weighted stations, plus everything derived from them."""
        answered = {k: v for k, v in profile.answers.items() if k in self.item_position}
        has_job = profile.job is not None and profile.job in self.position
        # several titles can describe one job (e.g. engineering manager + developer)
        titles = list(dict.fromkeys([profile.job] + [j for j in profile.extra_jobs if j in self.position])) if has_job else []
        prior = None
        if titles:
            rows = [self.position[j] for j in titles]
            prior = (self.census_skills_unit @ self.census_skills_unit[rows].T).max(axis=1)   # closest of the titles
        placement = self.place(profile, prior)
        origin, origin_kind, stations, weights, known = None, None, None, None, True

        if has_job:
            origin, origin_kind = profile.job, "your job"
            if placement:
                # text placed within the title's neighbourhood (title prior); see TITLE_PRIOR_STRENGTH
                stations, weights = np.asarray(placement["stations"]), np.asarray(placement["weights"])
            else:
                stations = np.array([self.position[j] for j in titles])
                weights = np.full(len(titles), 1.0 / len(titles))
        elif placement:
            stations, weights = placement["stations"], placement["weights"]
            origin, origin_kind = int(self.codes[stations[0]]), "your work"
        elif answered:
            stations, weights = self.nearest_stations(answered)
            origin, origin_kind, known = int(self.codes[stations[0]]), "nearest station", False

        reach = similarity = vector = None
        mix = []
        if stations is not None:
            order = np.argsort(-weights)
            stations, weights = stations[order], weights[order] / weights.sum()
            reach, similarity, vector = self.mixture(stations, weights, answered, known_job=known)
            mix = [{"census": int(self.codes[s]), "title": self.census["title"].iat[s], "weight": round(float(w), 3)}
                   for s, w in zip(stations, weights)]
        return {"answered": answered, "placement": placement, "origin": origin, "origin_kind": origin_kind,
                "reach": reach, "similarity": similarity, "vector": vector, "mix": mix}

    def recommend(self, profile: Profile, sort: str = "best", limit: int = 30):
        st = self.start(profile)
        answered, placement, origin, origin_kind = st["answered"], st["placement"], st["origin"], st["origin_kind"]
        reach, similarity, mix = st["reach"], st["similarity"], st["mix"]
        evidence = [e | {"placed_as": self.census["title"].iat[e["placed_as"]]} for e in placement["evidence"]] if placement else []
        nearby = [m["title"] for m in mix if m["census"] != origin][:4]
        n_answered = len(answered)

        hobby_areas = self.hobby_areas(profile.hobbies)
        appeal = self.interest_fit(profile, hobby_areas)

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

        if reach is not None:
            frame["reach_rank"] = frame["reach_share"].rank(ascending=False, method="first")
            frame["reach_label"] = np.select([frame["reach_rank"] <= 10, frame["reach_rank"] <= 50],
                                             ["Common move", "Occasional move"], "Rare move")

        appeal_weight = 0.7 if "passion" in profile.goals else 0.5
        if reach is not None and appeal is not None:
            frame["best"] = frame["reach_score"] ** (1 - appeal_weight) * frame["appeal_pct"] ** appeal_weight
        elif reach is not None:
            frame["best"] = frame["reach_score"]
        elif appeal is not None:
            frame["best"] = frame["appeal_pct"]
        else:
            frame["best"] = None
        if frame["best"].notna().any():
            frame["best"] = frame["best"] * self.goal_factor(frame, profile.goals)
            frame["best"] = frame["best"] * self.experience_factor(frame, profile.experience_years)
        order_by = {"best": "best", "reachable": "reach_share", "appealing": "appeal_pct"}.get(sort, "best")
        if order_by not in frame or frame[order_by].isna().all():
            order_by = "best"
        if frame[order_by].isna().all():
            order_by = "best"
        ranked = frame.sort_values(order_by, ascending=False).head(limit) if frame[order_by].notna().any() else frame.head(0)

        return {
            "origin": self.occupation(origin) | {"kind": origin_kind, "nearby": nearby, "mix": mix} if origin else None,
            "evidence": evidence,
            "tools_matched": placement["tools"] if placement else [],
            "hobby_areas": hobby_areas,
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

    @staticmethod
    def goal_factor(frame: pd.DataFrame, goals: list[str]):
        """Multiplier (0.6-1.4 per goal) nudging 'best fit' toward what the person wants from a change."""
        factor = pd.Series(1.0, index=frame.index)
        signals = {
            "pay": frame["median_wage"].rank(pct=True),
            "stability": frame["growth_pct"].rank(pct=True),
            "less_ai": 1 - frame["ai_theoretical_pct_in_zone"],
        }
        for goal in goals:
            if goal in signals:
                factor *= (0.6 + 0.8 * signals[goal]).fillna(1.0)
        return factor

    @staticmethod
    def experience_factor(frame: pd.DataFrame, years: float | None):
        """BLS lists the related work experience a job usually needs (none, under 5 years, 5 years or more).
        Jobs needing 5+ years (mostly management) move up for people who have it and down for people who don't.
        Our transition data has no seniority, so this is the one place career stage enters the ranking."""
        factor = pd.Series(1.0, index=frame.index)
        if years is None:
            return factor
        needs_five = frame["work_experience"] == "5 years or more"
        factor[needs_five] = SENIOR_BOOST if years >= 5 else JUNIOR_PENALTY
        return factor

    @staticmethod
    def experience_note(required: str | None, years: float | None):
        if required not in ("5 years or more", "Less than 5 years") or years is None:
            return None
        need = 5 if required == "5 years or more" else 1
        have = f"you have about {years:g}" if years < 30 else "you have plenty"
        if years >= need:
            return f"Usually needs {required.lower()} in a related job; {have}."
        return f"Usually needs {required.lower()} in a related job; {have}, so this is more likely a later step."

    def item_label(self, key: str):
        item = next(i for i in self.meta["items"] if i["key"] == key)
        return item.get("label") or (f"Knowledge of {item['name']}" if item["kind"] == "knowledge" else item["name"])

    def stop_details(self, profile: Profile, code: int):
        """Everything the stop page shows for one destination, relative to where the person starts."""
        st = self.start(profile)
        d = self.position[code]
        info = self.details.get(str(code), {})
        out = {"occupation": self.occupation(code), **info}

        if st["reach"] is not None:
            reach = st["reach"].copy()
            ranks = pd.Series(reach).rank(ascending=False, method="first")
            rank = int(ranks.iat[d])
            out["reach"] = {"share": round(float(reach[d]), 5), "rank": rank,
                            "label": "Common move" if rank <= 10 else "Occasional move" if rank <= 50 else "Rare move",
                            "from": self.census["title"].iat[self.position[st["origin"]]] if st["origin"] else None}
            out["skill_match"] = round(float(st["similarity"][d]), 3)

        if st["vector"] is not None:
            you = st["vector"]
            job = self.census_skills_raw[d]
            diff = job - you
            gaps = [i for i in np.argsort(-diff) if diff[i] >= 0.6 and job[i] >= 3.0][:5]
            transfers = [i for i in np.argsort(-np.minimum(you, job)) if you[i] >= 3.0 and job[i] >= 3.0][:5]
            out["gaps"] = [{"item": self.item_label(self.item_order[i]), "needed": round(float(job[i]), 1),
                            "you": round(float(you[i]), 1)} for i in gaps]
            out["transfers"] = [{"item": self.item_label(self.item_order[i]), "needed": round(float(job[i]), 1),
                                 "you": round(float(you[i]), 1)} for i in transfers]

        if st["origin"] is not None:
            here = self.census.loc[st["origin"]]
            there = self.census.loc[code]
            if pd.notna(here["median_wage"]) and pd.notna(there["median_wage"]):
                out["pay_change_pct"] = round(float(there["median_wage"] / here["median_wage"] - 1) * 100, 1)
            out["from_occupation"] = self.occupation(st["origin"])
        note = self.experience_note(self.census.at[code, "work_experience"], profile.experience_years)
        if note:
            out["experience_note"] = note
        return out


ABBREVIATIONS = {
    "it": "information technology", "hr": "human resources", "ux": "user experience", "ui": "user interface",
    "qa": "quality assurance", "pm": "project manager", "em": "engineering manager", "cto": "chief technology officer",
    "ceo": "chief executive officer", "cfo": "chief financial officer", "rn": "registered nurse", "swe": "software engineer",
    "sde": "software developer", "ml": "machine learning", "ai": "artificial intelligence", "devops": "development operations",
}


# Seniority words say how senior, not which job, and pulled matches off ("senior software engineer" landed on
# network architects). Only unambiguous ones: "lead", "staff" and "principal" are jobs on their own too.
SENIORITY_WORDS = {"senior", "sr", "junior", "jr", "ii", "iii", "iv"}


def _expand_abbreviations(query: str) -> str:
    words = [w.strip(".,") for w in query.lower().split()]
    kept = [w for w in words if w not in SENIORITY_WORDS] or words
    return " ".join(ABBREVIATIONS.get(word, word) for word in kept)


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
    score += 0.3 if (profile.description or profile.activities) else 0.0
    score += 0.05 if profile.tools else 0.0
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
