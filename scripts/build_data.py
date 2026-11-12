#!/usr/bin/env python3
"""Build public/molecules.json from data/molecules.yaml.

Every molecule is validated; any error aborts the build (nothing is written).
Run from anywhere:  python scripts/build_data.py
"""
from __future__ import annotations

import json
import re
import sys
import warnings
from collections import Counter
from pathlib import Path

import yaml
from rdkit import Chem
from rdkit.Chem import AllChem

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "molecules.yaml"
GROUPS = ROOT / "data" / "groups.json"
PLAYLISTS = ROOT / "data" / "playlists.yaml"
OUT = ROOT / "public" / "molecules.json"

ROLES = {"locant", "substituent", "parent", "ending", "suffix", "separator", "descriptor"}
NO_ATOM_ROLES = {"locant", "separator", "descriptor"}
POINTER_ROLES = {"locant", "descriptor"}  # take the color of the fragment they point at
HALOGENS = {"F", "Cl", "Br", "I"}
REQUIRED = ("id", "name", "commonName", "smiles", "tier", "tags", "fragments", "locants")
SEED = 0xC0FFEE  # fixed -> reproducible coordinates
N_CONFS = 30


# ---------------------------------------------------------------- groups

def load_groups(path: Path = GROUPS) -> dict:
    return {g["id"]: g for g in json.loads(path.read_text())["groups"]}


def resolve_groups(group_ids, groups) -> list[str]:
    """Expand composite groups through their recipes into base group ids."""
    out = []
    for gid in group_ids:
        recipe = groups[gid].get("recipe")
        out += resolve_groups(recipe, groups) if recipe else [gid]
    return out


def element_bounds(group_ids, groups) -> dict:
    """{element: (min, max or None)} summed over the resolved base groups."""
    bounds = {}
    for gid in resolve_groups(group_ids, groups):
        for el, spec in groups[gid]["elements"].items():
            lo, hi = (int(spec[:-1]), None) if isinstance(spec, str) else (spec, spec)
            plo, phi = bounds.get(el, (0, 0))
            bounds[el] = (plo + lo, None if hi is None or phi is None else phi + hi)
    return bounds


# ---------------------------------------------------------------- helpers

def owning(frags):
    """(index, fragment) for fragments that may own atoms."""
    return [(i, f) for i, f in enumerate(frags) if f["role"] not in NO_ATOM_ROLES]


def locant_target(frags, i):
    """A locant (or descriptor) points at the next atom-owning fragment, or at
    the first later fragment whose text equals its `for:`. None if there is none."""
    want = frags[i].get("for")
    return next((j for j, f in owning(frags) if j > i and (want is None or f["text"] == want)), None)


def frames(m) -> list[dict[int, str]]:
    """Numbering frames as {heavyAtomIndex: label}: the parent chain/ring first,
    then any substituent rings/chains that carry their own locants. Labels are
    strings: chain numbers ('1', '2') or letter locants ('N')."""
    return [{int(a): str(v) for a, v in fr.items()} for fr in [m["locants"], *m.get("frames", [])]]


def all_labels(m) -> dict[int, str]:
    return {a: v for fr in frames(m) for a, v in fr.items()}


def numeric(frame) -> dict[int, int]:
    return {a: int(v) for a, v in frame.items() if str(v).isdigit()}


def is_fixed(m) -> bool:
    """`numbering: fixed` = a retained fused parent (purine) whose numbering is
    data, not a walk along bonded atoms, and may number heteroatoms."""
    return m.get("numbering") == "fixed"


def locant_tokens(text) -> list[str]:
    """'1,3,7-' -> ['1','3','7'];  'N-' -> ['N'];  '-2,6-' -> ['2','6']"""
    return re.findall(r"\d+|[A-Z][a-z]?", text)


def label_sort(labels) -> list[str]:
    return sorted(labels, key=lambda v: (not v.isdigit(), int(v) if v.isdigit() else 0, v))


def components(atoms: set, mol) -> list[set]:
    """Connected components of `atoms` in the heavy-atom graph."""
    left, comps = set(atoms), []
    while left:
        stack, comp = [left.pop()], set()
        while stack:
            a = stack.pop()
            comp.add(a)
            for n in mol.GetAtomWithIdx(a).GetNeighbors():
                if n.GetIdx() in left:
                    left.remove(n.GetIdx())
                    stack.append(n.GetIdx())
        comps.append(comp)
    return comps


def locant_sites(frag, mol, labels) -> list[str]:
    """Locants a fragment is cited at, from `labels` ({atom: label}):
    - ending (ene/yne): the lower number of each multiple bond it owns
    - suffix: the numbers of its own chain atoms (C=O carbon); if it owns none
      (-ol, -amine), the numbers of the atoms it is bonded to
    - substituent: the labels (numbers or letters) of the atoms it is bonded to
    """
    atoms = set(frag["atoms"])
    num = numeric(labels)
    if frag["role"] == "ending":
        return label_sort(
            str(min(num[b.GetBeginAtomIdx()], num[b.GetEndAtomIdx()]))
            for b in mol.GetBonds()
            if b.GetBondTypeAsDouble() > 1
            and {b.GetBeginAtomIdx(), b.GetEndAtomIdx()} <= atoms & num.keys()
        )

    def outside(comp, lab):
        return [
            str(lab[n.GetIdx()])
            for a in comp
            for n in mol.GetAtomWithIdx(a).GetNeighbors()
            if n.GetIdx() not in atoms and n.GetIdx() in lab
        ]

    sites = []
    for comp in components(atoms, mol):
        if frag["role"] == "substituent":
            sites += outside(comp, labels)
        else:
            sites += [str(num[a]) for a in comp if a in num] or outside(comp, num)
    return label_sort(sites)


# ---------------------------------------------------------------- validators
# Each returns a list of error strings (empty = pass). Pure; no I/O.

def check_schema(m, groups) -> list[str]:
    errs = [f"missing field '{k}'" for k in REQUIRED if k not in m]
    for i, f in enumerate(m.get("fragments", [])):
        tag = f"fragment {i} {f.get('text')!r}"
        if not f.get("text"):
            errs.append(f"{tag}: empty text")
        if f.get("role") not in ROLES:
            errs.append(f"{tag}: bad role {f.get('role')!r}")
        if not isinstance(f.get("groupIds"), list):
            errs.append(f"{tag}: groupIds must be a list")
        for gid in f.get("groupIds") or []:
            if gid not in groups:
                errs.append(f"{tag}: unknown group '{gid}'")
        if f.get("role") in NO_ATOM_ROLES and f.get("atoms"):
            errs.append(f"{tag}: {f['role']} fragments own no atoms")
        if f.get("role") in ROLES - NO_ATOM_ROLES and not isinstance(f.get("atoms"), list):
            errs.append(f"{tag}: needs an atoms list")
    return errs


def check_name(m) -> list[str]:
    joined = "".join(f["text"] for f in m["fragments"])
    return [] if joined == m["name"] else [f"fragments spell {joined!r}, name is {m['name']!r}"]


def check_ownership(m, mol) -> list[str]:
    n, errs = mol.GetNumAtoms(), []
    count = Counter()
    for _, f in owning(m["fragments"]):
        for a in f["atoms"]:
            if not (isinstance(a, int) and 0 <= a < n):
                errs.append(f"{f['text']!r}: atom index {a} out of range (0..{n - 1})")
            else:
                count[a] += 1
    for a in range(n):
        if count[a] != 1:
            sym = mol.GetAtomWithIdx(a).GetSymbol()
            errs.append(f"atom {sym}{a} owned by {count[a]} fragments (must be exactly 1)")
    return errs


def check_elements(m, mol, groups) -> list[str]:
    errs = []
    for _, f in owning(m["fragments"]):
        have = Counter(
            "X" if (s := mol.GetAtomWithIdx(a).GetSymbol()) in HALOGENS else s for a in f["atoms"]
        )
        bounds = element_bounds(f["groupIds"], groups)
        for el in sorted(set(have) | set(bounds)):
            lo, hi = bounds.get(el, (0, 0))
            if have[el] < lo or (hi is not None and have[el] > hi):
                want = f"{lo}" if hi == lo else f"{lo}+" if hi is None else f"{lo}..{hi}"
                errs.append(f"{f['text']!r} {f['groupIds']}: has {have[el]} {el}, expected {want}")
    return errs


def check_locants(m, mol) -> list[str]:
    errs, frags = [], m["fragments"]
    try:
        frs = frames(m)
    except (TypeError, ValueError, AttributeError):
        return ["locants/frames must map heavy-atom index -> label"]
    n = mol.GetNumAtoms()
    if bad := [a for fr in frs for a in fr if not 0 <= a < n]:
        return [f"locants reference atoms out of range: {bad}"]
    if dup := [a for a, c in Counter(a for fr in frs for a in fr).items() if c > 1]:
        return [f"atoms {dup} are numbered in more than one frame"]

    for fi, fr in enumerate(frs):
        tag = "parent numbering" if fi == 0 else f"frame {fi}"
        fixed = fi == 0 and is_fixed(m)
        num = numeric(fr)
        by_num = {v: a for a, v in num.items()}
        # numbers: 1..n, unique; unless fixed: carbons only, consecutive numbers bonded
        if sorted(num.values()) != list(range(1, len(num) + 1)):
            errs.append(f"{tag}: numbers must be 1..{len(num)} with no repeats: {sorted(num.values())}")
        elif not fixed:
            for k in range(1, len(num)):
                if mol.GetBondBetweenAtoms(by_num[k], by_num[k + 1]) is None:
                    errs.append(f"{tag}: atoms numbered {k} and {k + 1} are not bonded")
        for a, v in fr.items():
            sym = mol.GetAtomWithIdx(a).GetSymbol()
            if v.isdigit():
                if sym != "C" and not fixed:
                    errs.append(f"{tag}: numbered atom {a} is not carbon")
            elif v != sym:
                errs.append(f"{tag}: letter locant {v!r} is on a {sym} atom")
    for _, f in owning(frags):
        if f["role"] == "parent":
            if missing := [a for a in f["atoms"] if a not in frs[0]]:
                errs.append(f"parent {f['text']!r}: atoms {missing} have no chain number")

    # each locant's labels == where its target sits/attaches
    labels = all_labels(m)
    for i, f in enumerate(frags):
        if f["role"] not in POINTER_ROLES:
            continue
        j = locant_target(frags, i)
        if j is None:
            errs.append(f"{f['role']} {f['text']!r}: no atom-owning fragment {f.get('for', '')!r} after it")
            continue
        tgt = frags[j]
        if f["groupIds"] != tgt["groupIds"]:
            errs.append(f"{f['role']} {f['text']!r} groupIds {f['groupIds']} != target {tgt['text']!r} {tgt['groupIds']}")
        if f["role"] == "descriptor":
            continue  # hydro prefixes / indicated hydrogen: only OPSIN checks these
        said = label_sort(locant_tokens(f["text"]))
        sites = locant_sites(tgt, mol, labels)
        if said != sites:
            errs.append(f"locant {f['text']!r} says {said} but {tgt['text']!r} is at position(s) {sites}")
    return errs


def renumberings(num, mol, pinned) -> list[dict[int, int]]:
    """Every other legal numbering of the same atoms. Chain: reversed. Ring: all
    rotations in both directions. pinned (substituent frame): atom 1 stays put."""
    n = len(num)
    by_num = {v: a for a, v in num.items()}
    if n > 2 and mol.GetBondBetweenAtoms(by_num[1], by_num[n]) is not None:  # ring
        maps = [lambda k, d=d, s=s: (d * (k - 1) + s) % n + 1 for s in ([0] if pinned else range(n)) for d in (1, -1)]
    else:
        maps = [lambda k: k] + ([] if pinned else [lambda k: n + 1 - k])
    return [{by_num[k]: f(k) for k in by_num} for f in maps]


def check_lowest_locants(m, mol) -> list[str]:
    """OPSIN accepts non-preferred numbering ('butan-3-ol'), so check it here:
    no other numbering of the same chain/ring may give lower locants. Compared in
    IUPAC order: suffix first, then ene/yne, then substituents. A substituent
    frame must start (1) at its point of attachment. Fixed numbering is exempt."""
    errs = []
    frs = frames(m)
    owner = {a: f for _, f in owning(m["fragments"]) for a in f["atoms"]}
    for fi, fr in enumerate(frs):
        num = numeric(fr)
        if len(num) < 2 or (fi == 0 and is_fixed(m)):
            continue
        tag = "parent numbering" if fi == 0 else f"frame {fi}"
        if fi > 0:
            attach = {
                a
                for a in fr
                for nb in mol.GetAtomWithIdx(a).GetNeighbors()
                if nb.GetIdx() not in fr
                and (nb.GetIdx() in frs[0] or owner[nb.GetIdx()]["role"] in ("parent", "suffix", "ending"))
            }
            if {v: a for a, v in num.items()}[1] not in attach:
                errs.append(f"{tag}: atom 1 must be the point of attachment (candidates: {sorted(attach)})")
                continue

        def key(lab):
            sites = {"suffix": [], "ending": [], "substituent": []}
            for _, f in owning(m["fragments"]):
                if f["role"] in sites:
                    sites[f["role"]] += [int(v) for v in locant_sites(f, mol, {a: str(v) for a, v in lab.items()})]
            return tuple(sorted(v) for v in sites.values())

        best = min(renumberings(num, mol, pinned=fi > 0), key=key)
        if key(best) < key(num):
            errs.append(f"{tag} is not lowest-locant: got {key(num)}, but {key(best)} is possible (suffix, ene/yne, substituents)")
    return errs


def check_stereo(mol) -> list[str]:
    found = Chem.FindPotentialStereo(mol)
    return [f"has stereo ({len(found)} potential element(s)); MVP skips stereocenters and E/Z"] if found else []


def check_opsin(m, mol, opsin_smiles) -> list[str]:
    """Name -> OPSIN -> structure must equal the authored SMILES (InChIKey)."""
    if not opsin_smiles:
        return [f"OPSIN could not parse name {m['name']!r}"]
    parsed = Chem.MolFromSmiles(opsin_smiles)
    if parsed is None:
        return [f"OPSIN returned unreadable SMILES {opsin_smiles!r}"]
    ours, theirs = Chem.MolToInchiKey(mol), Chem.MolToInchiKey(parsed)
    if ours != theirs:
        return [
            f"name/structure mismatch: {m['name']!r} is {Chem.MolToSmiles(parsed)} per OPSIN, "
            f"but smiles is {Chem.MolToSmiles(mol)}"
        ]
    return []


def validate(m, groups, opsin_smiles):
    """Run every check. Returns (errors, heavy-atom mol or None)."""
    errs = check_schema(m, groups)
    if errs:
        return errs, None
    mol = Chem.MolFromSmiles(m["smiles"])
    if mol is None:
        return [f"unparsable SMILES {m['smiles']!r}"], None
    errs += check_name(m)
    own = check_ownership(m, mol)
    errs += own
    if not own:  # these need sane atom indices
        errs += check_elements(m, mol, groups)
        loc = check_locants(m, mol)
        errs += loc or check_lowest_locants(m, mol)
    errs += check_stereo(mol)
    errs += check_opsin(m, mol, opsin_smiles)
    return errs, mol


# ---------------------------------------------------------------- build

def opsin_batch(names: list[str]) -> list[str]:
    """One JVM start for all names. '' for anything OPSIN can't parse."""
    from py2opsin import py2opsin

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # parse failures are reported by check_opsin
        out = py2opsin(names, "SMILES")
    out = [out] if isinstance(out, str) else list(out or [])
    if len(out) != len(names):
        sys.exit("FATAL: OPSIN did not run (is Java installed? `java -version`)")
    return out


def ref_atoms(mh, parent) -> list[int]:
    """Atoms that define 'flat': the numbered parent chain/ring (`parent` = its
    atom indices); for chains too short to define a plane (< 3 atoms), all
    heavy atoms."""
    heavy = [a.GetIdx() for a in mh.GetAtoms() if a.GetAtomicNum() > 1]
    return list(parent) if len(parent) >= 3 else heavy if len(heavy) >= 3 else list(range(mh.GetNumAtoms()))


def out_of_plane(xyz, ref) -> float:
    """RMS distance of the reference atoms from their best-fit plane (Angstrom)."""
    import numpy as np

    pts = xyz[ref] - xyz[ref].mean(axis=0)
    return float(np.linalg.svd(pts, compute_uv=False)[-1] / np.sqrt(len(ref)))


def embed(mol, parent):
    """3D coords with explicit H. Of N_CONFS optimised conformers, keep the one
    whose parent chain is flattest (extended zig-zag), then lowest in energy.
    AddHs appends, so heavy-atom indices are unchanged."""
    import numpy as np

    mh = Chem.AddHs(mol)
    for a in mol.GetAtoms():
        assert mh.GetAtomWithIdx(a.GetIdx()).GetAtomicNum() == a.GetAtomicNum(), "AddHs reordered atoms"
    params = AllChem.ETKDGv3()
    params.randomSeed = SEED
    ids = list(AllChem.EmbedMultipleConfs(mh, numConfs=N_CONFS, params=params))
    if not ids:
        raise RuntimeError("ETKDG embedding failed")
    results = AllChem.MMFFOptimizeMoleculeConfs(mh, maxIters=2000)
    converged = [(cid, energy) for cid, (failed, energy) in zip(ids, results) if failed == 0]
    if not converged:
        raise RuntimeError("MMFF did not converge")
    ref = ref_atoms(mh, parent)
    flat = lambda cid: round(out_of_plane(np.array(mh.GetConformer(cid).GetPositions()), ref), 1)
    best, _ = min(converged, key=lambda ce: (flat(ce[0]), ce[1]))
    conf = Chem.Conformer(mh.GetConformer(best))
    mh.RemoveAllConformers()
    mh.AddConformer(conf, assignId=True)
    return mh


def orient(mh, parent, num) -> None:
    """Rotate in place so the parent chain/ring lies flat in the XY plane (the
    viewer looks down Z), the molecule's long axis along X, chain atom 1 on the
    left of the highest-numbered one."""
    import numpy as np

    conf = mh.GetConformer()
    xyz = np.array(conf.GetPositions())
    ref = ref_atoms(mh, parent)
    centre = xyz[ref].mean(axis=0)
    _, _, vt = np.linalg.svd(xyz[ref] - centre)
    if np.linalg.det(vt) < 0:  # proper rotation only (never mirror)
        vt[2] *= -1
    out = (xyz - centre) @ vt.T
    # in that plane, turn the molecule's long axis (all heavy atoms) to X: the
    # stage is wide, and a ring alone has no long axis of its own
    heavy = [a.GetIdx() for a in mh.GetAtoms() if a.GetAtomicNum() > 1]
    xy = out[heavy][:, :2] - out[heavy][:, :2].mean(axis=0)
    if len(heavy) >= 2:
        major = np.linalg.svd(xy)[2][0]
        c, s_ = major / np.linalg.norm(major)
        out[:, :2] = out[:, :2] @ np.array([[c, -s_], [s_, c]])
    by_num = {v: a for a, v in num.items()}
    if out[by_num[1]][0] > out[by_num[max(by_num)]][0]:
        out[:, [0, 2]] *= -1  # 180 deg about Y
    for i, (x, y, z) in enumerate(out):
        conf.SetAtomPosition(i, (float(x), float(y), float(z)))


def atom_fragments(m, mh) -> list[int]:
    """Fragment index for every atom incl. H (H -> its heavy neighbour's fragment)."""
    owner = {a: i for i, f in owning(m["fragments"]) for a in f["atoms"]}
    return [
        owner[a.GetIdx()] if a.GetAtomicNum() > 1 else owner[a.GetNeighbors()[0].GetIdx()]
        for a in mh.GetAtoms()
    ]


def build_entry(m, mol) -> dict:
    parent = frames(m)[0]
    mh = embed(mol, list(parent))
    orient(mh, list(parent), numeric(parent))
    frags = [
        {
            "text": f["text"],
            "role": f["role"],
            "groupIds": f["groupIds"],
            "atoms": f.get("atoms", []),
            **({"target": locant_target(m["fragments"], i)} if f["role"] in POINTER_ROLES else {}),
        }
        for i, f in enumerate(m["fragments"])
    ]
    return {
        "id": m["id"],
        "name": m["name"],
        "commonName": m["commonName"],
        "smiles": m["smiles"],
        "tier": m["tier"],
        "tags": m["tags"],
        "fragments": frags,
        "atomFragment": atom_fragments(m, mh),
        "locants": {str(a): v for a, v in all_labels(m).items()},
        "molblock": Chem.MolToMolBlock(mh),
    }


def report(m, mol, entry, errs) -> str:
    lines = [f"== {m.get('name')}   ({m.get('commonName')})   {m.get('smiles')}   T{m.get('tier')}"]
    if mol is not None and entry is not None:
        sym = lambda a: f"{mol.GetAtomWithIdx(a).GetSymbol()}{a}"
        for i, f in enumerate(entry["fragments"]):
            if f["role"] in POINTER_ROLES:
                what = f"-> points at {entry['fragments'][f['target']]['text']!r}"
            elif f["role"] == "separator":
                what = "(no atoms)"
            else:
                nh = sum(1 for k, fi in enumerate(entry["atomFragment"]) if fi == i) - len(f["atoms"])
                what = " ".join(sym(a) for a in f["atoms"]) + (f"  +{nh}H" if nh else "")
            lines.append(f"   {f['text']!r:<10} {f['role']:<12} {','.join(f['groupIds']) or '-':<16} {what}")
        for fi, fr in enumerate(frames(m)):
            order = sorted(fr.items(), key=lambda kv: (not kv[1].isdigit(), int(kv[1]) if kv[1].isdigit() else 0))
            head = ("chain:  " if fi == 0 else f"frame {fi}:") + (" (fixed numbering)" if fi == 0 and is_fixed(m) else "")
            lines.append(f"   {head} " + "  ".join(f"{v}={sym(a)}" for a, v in order))
        lines.append(f"   OPSIN:  name -> structure matches SMILES ({Chem.MolToInchiKey(mol)})")
    lines += [f"   ERROR: {e}" for e in errs]
    lines.append("   PASS" if not errs else f"   FAIL ({len(errs)} error(s))")
    return "\n".join(lines)


def check_playlists(playlists, mol_ids) -> list[str]:
    """Playlists are ordered lists of molecule ids. Every molecule must be reachable."""
    errs = [f"duplicate playlist id '{i}'" for i, c in Counter(p.get("id") for p in playlists).items() if c > 1]
    used = set()
    for p in playlists:
        tag = f"playlist {p.get('id')!r}"
        errs += [f"{tag}: missing field '{k}'" for k in ("id", "name", "description", "molecules") if not p.get(k)]
        ids = p.get("molecules") or []
        errs += [f"{tag}: unknown molecule '{i}'" for i in ids if i not in mol_ids]
        errs += [f"{tag}: '{i}' listed twice" for i, c in Counter(ids).items() if c > 1]
        used |= set(ids)
    errs += [f"molecule '{i}' is in no playlist" for i in mol_ids if i not in used]
    return errs


def main() -> int:
    groups = load_groups()
    mols = yaml.safe_load(SRC.read_text())
    playlists = yaml.safe_load(PLAYLISTS.read_text())
    failed = [f"duplicate id '{i}'" for i, c in Counter(m.get("id") for m in mols).items() if c > 1]
    failed += check_playlists(playlists, [m.get("id") for m in mols])
    opsin = opsin_batch([str(m.get("name", "")) for m in mols])

    entries = []
    for m, osmi in zip(mols, opsin):
        errs, mol = validate(m, groups, osmi)
        entry = None
        if not errs:
            try:
                entry = build_entry(m, mol)
            except RuntimeError as e:
                errs.append(str(e))
        print(report(m, mol, entry, errs), "\n")
        if errs:
            failed.append(m.get("id", "?"))
        else:
            entries.append(entry)

    if failed:
        print(f"BUILD FAILED: {len(failed)} problem(s): {', '.join(map(str, failed))}. Nothing written.", file=sys.stderr)
        return 1
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"playlists": playlists, "molecules": entries}, indent=1) + "\n")
    print(f"OK: {len(entries)} molecules, {len(playlists)} playlists -> {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
