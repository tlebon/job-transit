"""Builds the small, committed asset files the API serves from.

Reads public O*NET tables from data/raw/db_31_0_csv and the derived files from
data/derived, and writes everything the API needs into api/assets/. Run from the
repo root after the notebooks:  uv run python api/build_assets.py
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.optimize import linear_sum_assignment
from scipy.spatial import ConvexHull, Voronoi
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union
from sklearn.cluster import AgglomerativeClustering
from sklearn.decomposition import PCA
from sklearn.manifold import TSNE
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "db_31_0_csv"
RAW_BLS = ROOT / "data" / "raw" / "bls"
DERIVED = ROOT / "data" / "derived"
OUT = ROOT / "api" / "assets"
OUT.mkdir(exist_ok=True)

# The 15 questions asked first, picked by method 3 in notebook 05 (least correlated set).
CORE_ITEMS = [
    "kn: Biology", "kn: Economics and Accounting", "kn: Engineering and Technology", "kn: Fine Arts",
    "kn: Food Production", "kn: Geography", "kn: Foreign Language", "kn: Public Safety and Security",
    "sk: Speaking", "kn: Customer and Personal Service", "kn: Telecommunications",
    "kn: Therapy and Counseling", "sk: Mathematics", "kn: Law and Government",
    "kn: Personnel and Human Resources",
]

# Clearer wording where classmates misread the O*NET label (survey, Oct 13).
QUESTION_OVERRIDES = {
    "kn: Engineering and Technology": "Engineering: applying engineering science to design and build physical goods, structures, or systems.",
    "kn: Therapy and Counseling": "Diagnosing and treating physical or mental conditions, or providing therapy or counseling (not general mentoring).",
}

# Display names for the catch-all census codes ("..., all other", "Miscellaneous ..."), named after the
# recognisable jobs inside them. The official title is kept as official_title and shown on the stop page.
DISPLAY_TITLES = {
    430: "Compliance, project & other managers",
    740: "Business project managers, sustainability specialists & more",
    950: "Quant analysts & fraud examiners",
    1107: "IT project managers, QA testers, UI designers & more tech",
    1240: "Data scientists & other math roles",
    1530: "Robotics, energy & other engineers",
    1760: "Remote sensing & other physical scientists",
    1860: "Planners, anthropologists, historians & more",
    1965: "Quality control, environmental & forensic technicians",
    2025: "Health educators & community health workers",
    2160: "Title examiners, court reporters & more",
    2760: "DJs & other performers",
    2860: "Interpreters & translators",
    3245: "Art & music therapists",
    3260: "Acupuncturists, naturopaths & more",
    3535: "Neurodiagnostic, prosthetics & hearing aid technicians",
    3655: "Medical equipment preparers & therapy assistants",
    3730: "Security supervisors",
    3955: "Lifeguards, loss prevention & more",
    4430: "Amusement park & venue attendants",
    4520: "Manicurists, skincare specialists & makeup artists",
    4840: "Service sales representatives",
    6050: "Farmworkers & farm equipment operators",
    6765: "Weatherization installers, pavers & more",
    7260: "Tire, RV & bicycle mechanics",
    7750: "Assemblers & fabricators",
    8630: "Refinery, gas & chemical plant operators",
    8965: "CNC operators & other production workers",
}

# Question titles shown in the app where the O*NET name misleads.
QUESTION_LABELS = {
    "kn: Engineering and Technology": "Engineering of physical things (machines, buildings, hardware)",
    "kn: Computers and Electronics": "Software, computers and electronics",
    "kn: Therapy and Counseling": "Therapy or counseling (clinical, not mentoring)",
}

FAMILIES = {
    "Management and business": ["11", "13"],
    "Computer, engineering, science": ["15", "17", "19"],
    "Education, legal, social, arts": ["21", "23", "25", "27"],
    "Healthcare": ["29", "31"],
    "Service": ["33", "35", "37", "39"],
    "Sales and office": ["41", "43"],
    "Trades, production, transport": ["45", "47", "49", "51", "53"],
}
FAMILY_OF = {group: family for family, groups in FAMILIES.items() for group in groups}

# BLS "typical education needed for entry", lowest to highest; the survey uses the same labels.
EDUCATION_LADDER = [
    "No formal educational credential",
    "High school diploma or equivalent",
    "Some college, no degree",
    "Postsecondary nondegree award",
    "Associate's degree",
    "Bachelor's degree",
    "Master's degree",
    "Doctoral or professional degree",
]

# Medians of the training pair features (ranker-pairs.parquet); the notebook filled gaps with these.
PAIR_MEDIANS = {"log_dest_size": 13.4206, "log_origin_size": 13.4206, "wage_diff": 0.0,
                "zone_diff": 0.0, "same_major": 0.0, "sim_ks": -0.0278}


def onet_scale(name, scale_id):
    df = pd.read_csv(RAW / f"{name}.csv")
    df = df[df["Scale ID"] == scale_id]
    return df.pivot(index="O*NET-SOC Code", columns="Element Name", values="Data Value")


descriptions = pd.read_csv(RAW / "content_model_reference.csv").drop_duplicates("Element Name", keep="last")
describe = descriptions.set_index("Element Name")["Description"].to_dict()
describe["Engineering and Technology"] = (
    "Knowledge of the practical application of engineering science and technology. This includes applying "
    "principles, techniques, procedures, and equipment to the design and production of various goods and services.")

# ---- survey items, O*NET-level profiles, imputation model --------------------------------
ks = pd.read_parquet(DERIVED / "survey-basis-onet.parquet").set_index("O*NET-SOC Code")
items = []
for key in CORE_ITEMS + [c for c in ks.columns if c not in CORE_ITEMS]:
    kind, name = key.split(": ", 1)
    items.append({
        "key": key,
        "kind": "knowledge" if kind == "kn" else "skill",
        "name": name,
        "description": QUESTION_OVERRIDES.get(key, describe.get(name, "")),
        "label": QUESTION_LABELS.get(key),
        "core": key in CORE_ITEMS,
    })
item_order = [item["key"] for item in items]
ks = ks[item_order]

onet_scaler = StandardScaler().fit(ks)
pca = PCA(n_components=8).fit(onet_scaler.transform(ks))

# ---- census-level table --------------------------------------------------------------------
census_onet = pd.read_parquet(DERIVED / "census-onet-crosswalk.parquet")
features = pd.read_parquet(DERIVED / "census-features.parquet").set_index("census")
codes = features.index

census_ks = (census_onet.merge(ks, left_on="onet", right_index=True).drop(columns="onet")
             .groupby("census").mean().reindex(codes))
census_ks = census_ks.fillna(census_ks.mean())
census_scaler = StandardScaler().fit(census_ks)

titles = (pd.read_parquet(DERIVED / "census-soc2010-crosswalk.parquet")
          .groupby("census")["title"].first().reindex(codes))

riasec_onet = onet_scale("career_interest_types", "OI")
riasec_order = ["Realistic", "Investigative", "Artistic", "Social", "Enterprising", "Conventional"]
census_riasec = (census_onet.merge(riasec_onet[riasec_order], left_on="onet", right_index=True)
                 .drop(columns="onet").groupby("census").mean().reindex(codes))
census_riasec = census_riasec.fillna(census_riasec.mean())

areas_onet = onet_scale("specific_interest_areas", "OI")
census_areas = (census_onet.merge(areas_onet, left_on="onet", right_index=True)
                .drop(columns="onet").groupby("census").mean().reindex(codes))
census_areas = census_areas.fillna(census_areas.mean())

outlook = pd.read_parquet(DERIVED / "census-outlook.parquet").set_index("census").reindex(codes)
exposure = pd.read_parquet(DERIVED / "census-theoretical-exposure.parquet").set_index("census").reindex(codes)

census = pd.DataFrame({
    "title": pd.Series([DISPLAY_TITLES.get(code, t) for code, t in titles.items()], index=titles.index),
    "official_title": titles,
    "family": features["soc_major"].map(FAMILY_OF),
    "soc_major": features["soc_major"],
    "log_size": features["log_size"],
    "log_wage": features["log_wage"],
    "job_zone": features["job_zone"],
    "employment_2025": outlook["emp_2025"],
    "growth_pct": outlook["growth_pct"],
    "median_wage": outlook["median_wage"],
    "entry_education": outlook["entry_education"],
    "work_experience": outlook["work_experience"],
    "on_the_job_training": outlook["on_the_job_training"],
    "ai_observed": exposure["ai_exposure"],
    "ai_theoretical": exposure["theoretical_gpt4"],
})
zone_band = census["job_zone"].round()
census["ai_theoretical_pct_in_zone"] = census.groupby(zone_band)["ai_theoretical"].rank(pct=True)

# BLS relative AI exposure (2025-35 release), built in notebook 06; optional so older checkouts still build
bls_exposure_path = DERIVED / "census-bls-exposure.parquet"
if bls_exposure_path.exists():
    bls_exposure = pd.read_parquet(bls_exposure_path).set_index("census").reindex(codes)
    census["bls_ai_exposure"] = bls_exposure["bls_ai_category"]
else:
    census["bls_ai_exposure"] = None
census["education_level"] = census["entry_education"].map({label: i for i, label in enumerate(EDUCATION_LADDER)})
census = census.reset_index()
census.to_parquet(OUT / "census.parquet", index=False)

census_ks.rename_axis("census").reset_index().to_parquet(OUT / "census-skills.parquet", index=False)
census_riasec.rename_axis("census").reset_index().to_parquet(OUT / "census-riasec.parquet", index=False)
census_areas.rename_axis("census").reset_index().to_parquet(OUT / "census-interest-areas.parquet", index=False)

# ---- Job City map: 2D layout, districts, transit lines -------------------------------------
# t-SNE on the standardized census-level skill profiles (cosine). Compared with a 2-component PCA it keeps
# far more of each occupation's real neighbours on the map (10 nearest neighbours kept: 58% vs 18%;
# trustworthiness 0.975 vs 0.853), so nearby on the map means similar in skills.
standardized = census_scaler.transform(census_ks)
xy = TSNE(n_components=2, perplexity=30, metric="cosine", init="pca", random_state=0).fit_transform(standardized)
xy = (xy - xy.min(axis=0)) / (xy.max(axis=0) - xy.min(axis=0))
xy = xy * np.array([1000, 700])

N_DISTRICTS = 14
district_of = AgglomerativeClustering(n_clusters=N_DISTRICTS, linkage="ward").fit_predict(xy)

# Each district is named after the items its occupations rate highest compared with everyone else.
# Placeholder names: easy to change here.
DISTRICT_NAMES = [
    (("kn: Computers and Electronics", "kn: Telecommunications"), "Tech Quarter"),
    (("kn: Medicine and Dentistry", "kn: Biology"), "Medical Center"),
    (("sk: Science", "kn: Mathematics", "kn: Physics", "kn: Chemistry"), "Science Park"),
    (("kn: Economics and Accounting", "kn: Clerical"), "Finance Row"),
    (("kn: Administration and Management",), "Downtown"),
    (("kn: Communications and Media", "kn: Fine Arts"), "Arts and Media Quarter"),
    (("kn: Philosophy and Theology", "kn: Sociology and Anthropology", "kn: Psychology", "kn: Education and Training", "kn: Therapy and Counseling"), "Learning Quarter"),
    (("kn: Law and Government", "kn: Public Safety and Security"), "Civic Center"),
    (("kn: Food Production", "kn: Foreign Language"), "Restaurant Row"),
    (("kn: Administrative", "kn: English Language"), "Office Park"),
    (("kn: Transportation",), "Transit Yards"),
    (("kn: Building and Construction",), "Builders' Row"),
    (("kn: Production and Processing",), "Factory Floor"),
    (("kn: Mechanical", "kn: Design"), "Workshop District"),
    (("kn: Physics", "kn: Engineering and Technology"), "Engineering Works"),
    (("kn: Customer and Personal Service", "kn: Sales and Marketing"), "High Street"),
]
std_frame = pd.DataFrame(standardized, columns=item_order)
# Match districts to names jointly (Hungarian assignment): cost = how far down a district's list of most
# distinctive items the first item linked to that name appears.
distinctive = [std_frame[district_of == d].mean().sort_values(ascending=False).index.tolist()
               for d in range(N_DISTRICTS)]
cost = np.full((N_DISTRICTS, len(DISTRICT_NAMES)), 100.0)
for d, top_items in enumerate(distinctive):
    for n, (keys, _) in enumerate(DISTRICT_NAMES):
        hits = [top_items.index(k) for k in keys if k in top_items]
        if hits:
            cost[d, n] = min(hits)
rows, cols = linear_sum_assignment(cost)
name_of = {d: DISTRICT_NAMES[n][1] for d, n in zip(rows, cols)}

# City blocks: each occupation gets its Voronoi cell, cut to a disc around it (so empty space becomes open
# land rather than giant cells) and shrunk a little so the gaps read as streets. A district is the union of
# its members' blocks.
BLOCK_RADIUS, STREET = 34.0, 1.6
vor = Voronoi(np.vstack([xy, [[-3000, -3000], [4000, -3000], [-3000, 4000], [4000, 4000]]]))
frame = box(-60, -60, 1060, 760)
cells = []
for i, (x, y) in enumerate(xy):
    region = vor.regions[vor.point_region[i]]
    if -1 in region or not region:
        cell = Point(x, y).buffer(BLOCK_RADIUS)
    else:
        cell = Polygon(vor.vertices[region])
    cell = cell.intersection(Point(x, y).buffer(BLOCK_RADIUS, quad_segs=6)).intersection(frame)
    cells.append(cell)


def rings(geom, simplify=0.8):
    geom = geom.simplify(simplify)
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    return [np.round(np.asarray(p.exterior.coords)[:-1], 1).tolist() for p in polys if not p.is_empty and p.area > 4]


blocks = [rings(cell.buffer(-STREET / 2)) for cell in cells]
districts = []
for d in range(N_DISTRICTS):
    members = np.flatnonzero(district_of == d)
    area = unary_union([cells[i] for i in members]).buffer(0.5).buffer(-0.5)
    label_at = area.representative_point() if area.area > 0 else Point(xy[members].mean(axis=0))
    centre = Point(np.median(xy[members, 0]), np.median(xy[members, 1]))
    label_at = centre if area.contains(centre) else label_at
    districts.append({"id": d, "name": name_of[d], "x": round(label_at.x, 1), "y": round(label_at.y, 1),
                      "outline": rings(area, 1.2), "size": int(len(members))})

history = pd.read_parquet(DERIVED / "history-flows-2015-2021.parquet")
history = history[history["OCC10LY"].isin(codes) & history["OCC2010"].isin(codes)]
pair = history.assign(a=history[["OCC10LY", "OCC2010"]].min(axis=1), b=history[["OCC10LY", "OCC2010"]].max(axis=1))
pair = pair.groupby(["a", "b"])["weighted_movers"].sum().sort_values(ascending=False)
lines = [{"a": int(a), "b": int(b), "w": round(float(w), 1)} for (a, b), w in pair.head(450).items()]

census_map = pd.DataFrame({"census": codes, "x": np.round(xy[:, 0], 1), "y": np.round(xy[:, 1], 1),
                           "district": district_of})
census_map.to_parquet(OUT / "census-map.parquet", index=False)
(OUT / "map.json").write_text(json.dumps({
    "districts": districts,
    "lines": lines,
    "blocks": {int(code): block for code, block in zip(codes, blocks)},
}, separators=(",", ":")))

# ---- stop pages: what each occupation is ------------------------------------------------
# Description and core tasks from the occupation's main O*NET member (the ".00" code if there is one),
# tasks ordered by rated importance; example titles from O*NET's sample of reported titles. For catch-all
# census codes ("..., all other", "Miscellaneous ...") the member O*NET occupations are listed instead,
# since those are the real jobs hiding inside (e.g. Data Scientists in "Miscellaneous mathematical science").
occupation_data = pd.read_csv(RAW / "occupation_data.csv").set_index("O*NET-SOC Code")
task_statements = pd.read_csv(RAW / "task_statements.csv")
task_importance = pd.read_csv(RAW / "task_ratings.csv")
task_importance = task_importance[task_importance["Scale ID"] == "IM"].set_index("Task ID")["Data Value"]
task_statements["importance"] = task_statements["Task ID"].map(task_importance)
reported_titles = pd.read_csv(RAW / "sample_of_reported_titles.csv")

# Employment per O*NET member, from the BLS 2025 matrix (exact SOC code, else the most specific combined code),
# so a catch-all lists its biggest jobs first.
bls_matrix = pd.read_excel(RAW_BLS / "ai-exposure-categories.xlsx", "AI Exposure Categories", header=1).rename(
    columns={"2025 National Employment Matrix code": "nem_code", "Employment, 2025": "emp_2025"})
bls_matrix = bls_matrix[bls_matrix["nem_code"].astype(str).str.match(r"^\d\d-\d{4}$")]
bls_employment = bls_matrix.set_index("nem_code")["emp_2025"].astype(float).to_dict()
bls_prefixes = {code.rstrip("0").rstrip("-"): emp for code, emp in bls_employment.items()}


def member_employment(onet_code: str) -> float:
    soc = onet_code[:7]
    if soc in bls_employment:
        return bls_employment[soc]
    prefixes = [p for p in bls_prefixes if soc.startswith(p)]
    return bls_prefixes[max(prefixes, key=len)] if prefixes else 0.0


def first_sentence(text: str) -> str:
    return text.split(". ")[0].rstrip(".") + "."


details = {}
for code in codes:
    members = census_onet.loc[census_onet["census"] == code, "onet"].tolist()
    members = [m for m in members if m in occupation_data.index]
    if not members:
        continue
    main = next((m for m in members if m.endswith(".00")), members[0])
    tasks = (task_statements[(task_statements["O*NET-SOC Code"] == main) & (task_statements["Task Type"] == "Core")]
             .sort_values("importance", ascending=False)["Task"].head(5).tolist())
    title = str(titles.get(code, ""))
    catch_all = "all other" in title.lower() or title.lower().startswith("miscellaneous")
    if catch_all:
        named = [m for m in members if not occupation_data.at[m, "Title"].endswith("All Other")]
        # members sharing one SOC code (e.g. the nine under "Computer occupations, all other") split its employment
        sharing = pd.Series([m[:7] for m in named]).value_counts()
        named.sort(key=lambda m: -member_employment(m) / sharing[m[:7]])
        examples = [occupation_data.at[m, "Title"] for m in named]
    else:
        shown = reported_titles[reported_titles["O*NET-SOC Code"].isin(members)]
        shown = shown.sort_values("Shown in My Next Move", ascending=False)
        examples = shown["Reported Job Title"].drop_duplicates().tolist()
    details[str(int(code))] = {
        "description": None if catch_all else occupation_data.at[main, "Description"],
        "tasks": [] if catch_all else tasks,
        "example_titles": examples[:8],
        "catch_all": catch_all,
        "members": [{"title": occupation_data.at[m, "Title"], "summary": first_sentence(occupation_data.at[m, "Description"])}
                    for m in named[:8]] if catch_all else [],
    }
(OUT / "census-details.json").write_text(json.dumps(details, separators=(",", ":")))

# ---- job-title search index ----------------------------------------------------------------
onet_titles = pd.read_parquet(DERIVED / "onet-titles.parquet").rename(columns={"O*NET-SOC Code": "onet"})
alt = pd.read_csv(RAW / "job_titles.csv").rename(columns={"O*NET-SOC Code": "onet", "Job Title": "title"})
reported = pd.read_csv(RAW / "sample_of_reported_titles.csv").rename(
    columns={"O*NET-SOC Code": "onet", "Reported Job Title": "title"})
search = pd.concat([
    onet_titles.assign(source="onet"),
    reported[["onet", "title"]].assign(source="reported"),
    alt[["onet", "title"]].assign(source="alternate"),
])
search = search.merge(census_onet, on="onet").merge(onet_titles.rename(columns={"title": "onet_title"}), on="onet")
search = search[search["census"].isin(codes)].drop_duplicates(["title", "census"])
search.to_parquet(OUT / "title-search.parquet", index=False)

# ---- interests: chips and quiz -------------------------------------------------------------
area_to_type = pd.read_csv(RAW / "specific_interest_areas_to_career_interest_types.csv")
area_to_type = area_to_type.groupby("Specific Interest Areas Element Name")["Career Interest Types Element Name"].first()
chips = [{"name": area, "description": describe.get(area, ""), "riasec": area_to_type.get(area)}
         for area in census_areas.columns]

activities = pd.read_csv(RAW / "interests_illustrative_activities.csv")
activities = activities[activities["Interest Type"] == "Career Type"]
quiz = [{"id": f"q{i}", "type": row["Element Name"], "text": row["Activity"].rstrip(".")}
        for i, (_, row) in enumerate(activities.iterrows())]
# interleave types so consecutive questions differ
quiz = sorted(quiz, key=lambda q: (int(q["id"][1:]) % 4, riasec_order.index(q["type"])))

meta = {
    "items": items,
    "item_order": item_order,
    "onet_mean": onet_scaler.mean_.tolist(),
    "onet_scale": onet_scaler.scale_.tolist(),
    "pca_components": pca.components_.tolist(),
    "census_mean": census_scaler.mean_.tolist(),
    "census_scale": census_scaler.scale_.tolist(),
    "pair_medians": PAIR_MEDIANS,
    "education_ladder": EDUCATION_LADDER,
    "riasec_order": riasec_order,
    "chips": chips,
    "quiz": quiz,
    "families": list(FAMILIES),
}
(OUT / "meta.json").write_text(json.dumps(meta, indent=1))

print("districts:", [d["name"] for d in districts])
print(f"census: {census.shape}, title search: {len(search):,} titles, chips: {len(chips)}, quiz: {len(quiz)}")
print("missing:", census.isna().sum()[census.isna().sum() > 0].to_dict())
