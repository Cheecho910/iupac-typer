#!/usr/bin/env python3
"""Generate data/molecules.generated.yaml from short recipes.

    python scripts/make_molecules.py        # rewrite the generated file
    python scripts/build_data.py            # then validate + embed as usual

A recipe says what the molecule is (parent, suffix, prefixes, positions); the
generator builds the structure atom by atom, so it knows which atoms each name
fragment owns and what every chain number is. Nothing here is trusted: the
output goes through the same validators and OPSIN check as hand-written YAML.

It covers substitutive names on chains (C1-C9), cycloalkanes, benzene and the
monocyclic heterocycles in HETERO. It does not decide seniority for you: you
choose the suffix and the locants; the build rejects wrong numbering, a
non-longest chain, and any molecule with a stereocentre or E/Z bond.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml
from rdkit import Chem

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "molecules.generated.yaml"

STEM = {1: "meth", 2: "eth", 3: "prop", 4: "but", 5: "pent", 6: "hex", 7: "hept", 8: "oct", 9: "non"}
MULT = {1: "", 2: "di", 3: "tri", 4: "tetra"}
VOWELS = "aeiouy"

# name -> (group id, builder key)
PREFIXES = {
    "methyl": "alkyl", "ethyl": "alkyl", "propyl": "alkyl", "phenyl": "aromatic",
    "chloro": "halide", "bromo": "halide", "fluoro": "halide",
    "hydroxy": "hydroxyl", "amino": "amine", "oxo": "oxo",
}
HALOGEN = {"chloro": "Cl", "bromo": "Br", "fluoro": "F"}
ALKYL = {"methyl": 1, "ethyl": 2, "propyl": 3}

# suffix -> (text, group, on a chain it is terminal and takes no locant, adds an exocyclic carbon)
SUFFIXES = {
    "ol": ("ol", "hydroxyl", False, False),
    "amine": ("amine", "amine", False, False),
    "one": ("one", "carbonyl", False, False),
    "al": ("al", "carbonyl", True, False),
    "oic acid": ("oic acid", "carboxylic-acid", True, False),
    "amide": ("amide", "amide", True, False),
    "oate": ("oate", "ester", True, False),
    "carboxylic acid": ("carboxylic acid", "carboxylic-acid", False, True),
    "carbaldehyde": ("carbaldehyde", "carbonyl", False, True),
    "carboxamide": ("carboxamide", "amide", False, True),
    "carboxylate": ("carboxylate", "ester", False, True),
}
# benzene + one exocyclic suffix uses the retained benz- names
BENZ = {"carboxylic acid": "oic acid", "carbaldehyde": "aldehyde", "carboxamide": "amide", "carboxylate": "oate"}

# Monocyclic heterocycles: SMILES with atom maps = ring numbers.
# name -> (mapped SMILES, group id, indicated hydrogen or None)
HETERO = {
    "pyridine": ("[n:1]1[cH:2][cH:3][cH:4][cH:5][cH:6]1", "heteroaromatic", None),
    "pyrimidine": ("[n:1]1[cH:2][n:3][cH:4][cH:5][cH:6]1", "heteroaromatic", None),
    "furan": ("[o:1]1[cH:2][cH:3][cH:4][cH:5]1", "heteroaromatic", None),
    "thiophene": ("[s:1]1[cH:2][cH:3][cH:4][cH:5]1", "heteroaromatic", None),
    "pyrrole": ("[nH:1]1[cH:2][cH:3][cH:4][cH:5]1", "heteroaromatic", "1H"),
    "imidazole": ("[nH:1]1[cH:2][n:3][cH:4][cH:5]1", "heteroaromatic", "1H"),
    "piperidine": ("[NH:1]1[CH2:2][CH2:3][CH2:4][CH2:5][CH2:6]1", "heterocycle", None),
    "pyrrolidine": ("[NH:1]1[CH2:2][CH2:3][CH2:4][CH2:5]1", "heterocycle", None),
    "morpholine": ("[O:1]1[CH2:2][CH2:3][NH:4][CH2:5][CH2:6]1", "heterocycle", None),
    "oxolane": ("[O:1]1[CH2:2][CH2:3][CH2:4][CH2:5]1", "heterocycle", None),
    "oxane": ("[O:1]1[CH2:2][CH2:3][CH2:4][CH2:5][CH2:6]1", "heterocycle", None),
    "oxirane": ("[O:1]1[CH2:2][CH2:3]1", "heterocycle", None),
    "1,4-dioxane": ("[O:1]1[CH2:2][CH2:3][O:4][CH2:5][CH2:6]1", "heterocycle", None),
}


@dataclass
class Parent:
    kind: str  # chain | cyclo | benzene | hetero
    n: int = 0
    name: str = ""


def chain(n):
    return Parent("chain", n)


def cyclo(n):
    return Parent("cyclo", n)


BENZENE = Parent("benzene", 6)


def hetero(name):
    return Parent("hetero", name=name)


@dataclass
class M:
    """One recipe. `at`: locants of the suffix. `prefixes`: [(name, [locants])],
    a locant is a chain number or "N". `ene`/`yne`: lower locant of each bond.
    `ester`: alkyl name on the O of an -oate / -carboxylate."""
    parent: Parent
    suffix: str | None = None
    at: list = field(default_factory=list)
    prefixes: list = field(default_factory=list)
    ene: list = field(default_factory=list)
    yne: list = field(default_factory=list)
    ester: str | None = None
    common: str = ""
    tier: int = 3
    tags: list = field(default_factory=list)


class Builder:
    def __init__(self, spec: M):
        self.s = spec
        p = spec.parent
        self.lab: dict[int, int] = {}  # ring/chain number -> atom index
        self.n_atom = None  # N of an amine/amide suffix, for N- locants
        if p.kind == "hetero":
            smiles, self.group, self.indicated = HETERO[p.name]
            self.rw = Chem.RWMol(Chem.MolFromSmiles(smiles))
            for a in self.rw.GetAtoms():
                self.lab[a.GetAtomMapNum()] = a.GetIdx()
                a.SetAtomMapNum(0)
                if a.GetSymbol() == "C":
                    a.SetNumExplicitHs(0)
                    a.SetNoImplicit(False)
        else:
            self.rw = Chem.RWMol()
            self.group, self.indicated = ("aromatic" if p.kind == "benzene" else "parent"), None
            for k in range(1, p.n + 1):
                self.lab[k] = self.rw.AddAtom(Chem.Atom(6))
            for k in range(1, p.n):
                order = 2 if p.kind == "benzene" and k % 2 == 1 else 1
                self.bond(self.lab[k], self.lab[k + 1], order)
            if p.kind in ("cyclo", "benzene"):
                self.bond(self.lab[p.n], self.lab[1])
        self.parent_atoms = set(self.lab.values())

    def add(self, symbol):
        return self.rw.AddAtom(Chem.Atom(symbol))

    def bond(self, a, b, order=1):
        self.rw.AddBond(a, b, {1: Chem.BondType.SINGLE, 2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE}[order])

    def attach(self, a, b, order=1):
        """Bond new atom b to existing atom a, spending one explicit H on a heteroatom."""
        atom = self.rw.GetAtomWithIdx(a)
        if atom.GetNumExplicitHs() > 0:
            atom.SetNumExplicitHs(atom.GetNumExplicitHs() - 1)
        self.bond(a, b, order)

    def site(self, locant):
        if locant == "N":
            assert self.n_atom is not None, "N- locant needs an amine or amide suffix"
            return self.n_atom
        return self.lab[locant]

    def add_prefix(self, name, a) -> list[int]:
        if name in ALKYL:
            atoms, prev = [], a
            for _ in range(ALKYL[name]):
                c = self.add("C")
                (self.attach if prev == a else self.bond)(prev, c)
                atoms.append(c)
                prev = c
            return atoms
        if name == "phenyl":
            ring = [self.add("C") for _ in range(6)]
            for i in range(6):
                self.bond(ring[i], ring[(i + 1) % 6], 2 if i % 2 == 0 else 1)
            self.attach(a, ring[0])
            return ring
        x = self.add(HALOGEN.get(name) or {"hydroxy": "O", "amino": "N", "oxo": "O"}[name])
        self.attach(a, x, 2 if name == "oxo" else 1)
        return [x]

    def add_suffix(self, key, a) -> tuple[list[int], list[int]]:
        """Returns (atoms the suffix owns, atoms of the ester alkyl group)."""
        exo = SUFFIXES[key][3]
        c = a
        if exo:
            c = self.add("C")
            self.attach(a, c)
        own, alkyl = ([c] if exo or key in ("one", "al", "oic acid", "amide", "oate") else []), []
        kind = {"carboxylic acid": "oic acid", "carbaldehyde": "al", "carboxamide": "amide", "carboxylate": "oate"}.get(key, key)
        if kind in ("ol", "amine"):
            x = self.add("O" if kind == "ol" else "N")
            self.attach(c, x)
            own.append(x)
            if kind == "amine":
                self.n_atom = x
        else:
            o = self.add("O")
            self.attach(c, o, 2)
            own.append(o)
            if kind in ("oic acid", "oate", "amide"):
                x = self.add("N" if kind == "amide" else "O")
                self.bond(c, x)
                own.append(x)
                if kind == "amide":
                    self.n_atom = x
                if kind == "oate":
                    alkyl = self.add_prefix(self.s.ester, x)
        return own, alkyl

    def build(self) -> dict:
        s, p = self.s, self.s.parent
        n_ring = p.n or len(self.lab)

        # ---- structure
        ending_atoms = []
        for k in s.ene + s.yne:
            b = self.rw.GetBondBetweenAtoms(self.lab[k], self.lab[k % n_ring + 1])
            b.SetBondType(Chem.BondType.DOUBLE if k in s.ene else Chem.BondType.TRIPLE)
            ending_atoms += [self.lab[k], self.lab[k % n_ring + 1]]
        suffix_atoms, ester_atoms = [], []
        positions = s.at or ([1] if s.suffix else [])
        for k in positions:
            own, alkyl = self.add_suffix(s.suffix, self.lab[k])
            suffix_atoms += own
            ester_atoms += alkyl
        prefixes = sorted(s.prefixes, key=lambda pr: pr[0])  # alphabetical, multipliers ignored
        prefix_atoms = [[a for loc in locs for a in self.add_prefix(name, self.site(loc))] for name, locs in prefixes]
        assert not set(ending_atoms) & set(suffix_atoms), "a suffix carbon cannot also be an ene/yne carbon"

        Chem.SanitizeMol(self.rw)
        mol = self.rw.GetMol()
        smiles = Chem.MolToSmiles(mol)
        order = list(mol.GetPropsAsDict(True, True)["_smilesAtomOutputOrder"])
        new = {old: i for i, old in enumerate(order)}
        idx = lambda atoms: sorted(new[a] for a in atoms)

        # ---- which locants are written
        text, group, terminal, exo = SUFFIXES[s.suffix] if s.suffix else ("", None, False, False)
        retained = p.kind == "benzene" and len(positions) == 1 and (s.suffix == "ol" or exo)
        features = len(prefixes) + bool(s.ene or s.yne) + bool(s.suffix)
        lone = features == 1 and len(positions) <= 1 and len(s.ene + s.yne) <= 1 and all(len(l) == 1 for _, l in prefixes)
        omit = (p.kind == "chain" and p.n == 1) or (lone and (p.kind in ("cyclo", "benzene") or (p.kind == "chain" and p.n <= 2)))
        suffix_locant = bool(s.suffix) and not omit and not retained and not (terminal and p.kind == "chain")

        # ---- name fragments, left to right
        frags, name = [], ""

        def emit(txt, role, groups, atoms=None, **extra):
            nonlocal name
            frags.append({"text": txt, "role": role, "groupIds": groups, **({"atoms": idx(atoms)} if atoms is not None else {}), **extra})
            name += txt

        def locant(locs, groups):
            emit(("-" if name and not name.endswith(" ") else "") + ",".join(str(l) for l in locs) + "-", "locant", groups)

        if s.ester:
            emit(s.ester, "substituent", ["alkyl"], ester_atoms)
            emit(" ", "separator", [])
        for (pname, locs), atoms in zip(prefixes, prefix_atoms):
            groups = [PREFIXES[pname]] * (len(locs) if PREFIXES[pname] != "alkyl" and pname != "phenyl" else 1)
            if not omit or "N" in locs:
                locant(sorted(locs, key=str), groups)
            emit(MULT[len(locs)] + pname, "substituent", groups, atoms)
        if self.indicated:
            emit(("-" if name and not name.endswith(" ") else "") + self.indicated + "-", "descriptor", [self.group])

        suffix_text = ""
        if s.suffix:
            suffix_text = "ol" if retained and s.suffix == "ol" else BENZ[s.suffix] if retained else MULT[len(positions)] + text
        keep_e = not s.suffix or suffix_text[0] not in VOWELS
        own_parent = self.parent_atoms - set(suffix_atoms) - set(ending_atoms)
        unsat = s.ene + s.yne
        if retained:
            emit("phen" if s.suffix == "ol" else "benz", "parent", [self.group], own_parent)
        elif unsat:
            stem = ("cyclo" if p.kind == "cyclo" else "") + STEM[p.n]
            emit(stem + ("a" if len(unsat) > 1 else ""), "parent", [self.group], own_parent)
            kind = "alkene" if s.ene else "alkyne"
            if not omit:
                locant(sorted(unsat), [kind] * len(unsat))
            emit(MULT[len(unsat)] + ("en" if s.ene else "yn") + ("e" if keep_e else ""), "ending", [kind] * len(unsat), ending_atoms)
        else:
            base = {"chain": lambda: STEM[p.n] + "an", "cyclo": lambda: "cyclo" + STEM[p.n] + "an", "benzene": lambda: "benzen"}.get(
                p.kind, lambda: p.name[:-1] if p.name.endswith("e") else p.name)()
            full = base + ("e" if keep_e and (p.kind != "hetero" or p.name.endswith("e")) else "")
            emit(full, "parent", [self.group], own_parent)
        if s.suffix:
            groups = [group] * len(positions)
            if suffix_locant:
                locant(sorted(positions), groups)
            emit(suffix_text, "suffix", groups, suffix_atoms)

        locants = {new[a]: k for k, a in self.lab.items()}
        if any("N" in locs for _, locs in prefixes):
            locants[new[self.n_atom]] = "N"
        entry = {
            "id": "".join(ch if ch.isalnum() else "-" for ch in name.lower()).strip("-").replace("--", "-"),
            "name": name,
            "commonName": s.common,
            "smiles": smiles,
            "tier": s.tier,
            "tags": s.tags,
            "fragments": frags,
            "locants": dict(sorted(locants.items(), key=lambda kv: (str(kv[1]).isalpha(), kv[1] if isinstance(kv[1], int) else 0))),
        }
        if p.kind == "hetero":
            entry["numbering"] = "fixed"
        return entry


# ---------------------------------------------------------------- recipes
# Order here is the order in the file. Playlists (data/playlists.yaml) set the ramp.

C = chain
T_CHAIN, T_RING, T_HET = 3, 4, 5

CHAINS = [
    # one group, longer chains, the group somewhere other than the end
    M(C(5), "one", [3], common="diethyl ketone"),
    M(C(5), "ol", [3]),
    M(C(6), "ol", [1], common="hexyl alcohol"),
    M(C(6), "amine", [1], common="hexylamine"),
    M(C(7), "al", common="heptaldehyde"),
    M(C(7), "ol", [4]),
    M(C(8), "oic acid", common="caprylic acid"),
    M(C(9), "one", [5], common="dibutyl ketone"),
    M(C(9), "ol", [1], common="nonyl alcohol"),
    M(C(5), prefixes=[("bromo", [1])], common="pentyl bromide"),
    M(C(7), ene=[1]),
    M(C(8), yne=[1]),
    # branches
    M(C(3), "ol", [1], prefixes=[("methyl", [2, 2])], common="neopentyl alcohol"),
    M(C(3), "oic acid", prefixes=[("methyl", [2, 2])], common="pivalic acid"),
    M(C(4), "al", prefixes=[("methyl", [3])], common="isovaleraldehyde"),
    M(C(4), "one", [2], prefixes=[("methyl", [3, 3])], common="pinacolone"),
    M(C(4), prefixes=[("methyl", [2])], ene=[2], common="amylene"),
    M(C(5), "one", [2], prefixes=[("methyl", [4])], common="methyl isobutyl ketone"),
    M(C(5), "ol", [3], prefixes=[("ethyl", [3])]),
    M(C(6), "one", [2], prefixes=[("methyl", [5])]),
    M(C(7), "one", [4], prefixes=[("methyl", [2, 6])], common="diisobutyl ketone"),
    # the same group twice
    M(C(2), "ol", [1, 2], common="ethylene glycol"),
    M(C(3), "ol", [1, 3]),
    M(C(3), "ol", [1, 2, 3], common="glycerol"),
    M(C(4), "amine", [1, 4], common="putrescine"),
    M(C(5), "one", [2, 4], common="acetylacetone"),
    M(C(3), "oic acid", [1, 3], common="malonic acid"),
    M(C(4), "oic acid", [1, 4], common="succinic acid"),
    M(C(6), "oic acid", [1, 6], common="adipic acid"),
    M(C(6), ene=[1, 5]),
    # two different groups: one is the suffix, the other a prefix
    M(C(2), "ol", [1], prefixes=[("amino", [2])], common="ethanolamine"),
    M(C(2), "oic acid", prefixes=[("amino", [2])], common="glycine"),
    M(C(3), "ol", [1], prefixes=[("chloro", [3])]),
    M(C(3), "oic acid", prefixes=[("hydroxy", [3])], common="hydracrylic acid"),
    M(C(3), "oic acid", prefixes=[("oxo", [2])], common="pyruvic acid"),
    M(C(4), "one", [2], prefixes=[("hydroxy", [4])]),
    M(C(4), "oic acid", prefixes=[("oxo", [3])], common="acetoacetic acid"),
    M(C(4), "oic acid", prefixes=[("amino", [4])], common="GABA"),
    M(C(5), "al", prefixes=[("hydroxy", [5])]),
    M(C(6), "oic acid", prefixes=[("amino", [6])], common="aminocaproic acid"),
    M(C(7), "one", [2], prefixes=[("hydroxy", [7])]),
    # a multiple bond plus a group
    M(C(3), "al", ene=[2], common="acrolein"),
    M(C(3), "oic acid", ene=[2], common="acrylic acid"),
    M(C(3), "oic acid", ene=[2], prefixes=[("methyl", [2])], common="methacrylic acid"),
    M(C(4), "oic acid", ene=[3], common="vinylacetic acid"),
    M(C(5), "ol", [1], ene=[4]),
    M(C(6), "one", [2], ene=[5], common="allylacetone"),
    M(C(8), "ol", [1], yne=[7]),
    M(C(9), "one", [2], ene=[8]),
    # esters and amides with a second group or an N-substituent
    M(C(4), "oate", prefixes=[("oxo", [3])], ester="ethyl", common="ethyl acetoacetate"),
    M(C(4), "oate", prefixes=[("hydroxy", [4])], ester="methyl"),
    M(C(2), "amide", prefixes=[("methyl", ["N"])], common="N-methylacetamide"),
    M(C(1), "amide", prefixes=[("methyl", ["N", "N"])], common="dimethylformamide (DMF)"),
]

RINGS = [
    # cycloalkanes with one group
    M(cyclo(5), "one"),
    M(cyclo(4), "one"),
    M(cyclo(7), "one", common="suberone"),
    M(cyclo(5), "ol"),
    M(cyclo(6), "amine", common="cyclohexylamine"),
    M(cyclo(6), prefixes=[("chloro", [1])], common="cyclohexyl chloride"),
    M(cyclo(5), prefixes=[("methyl", [1])]),
    M(cyclo(6), ene=[1]),
    M(cyclo(6), "carboxylic acid"),
    M(cyclo(3), "carboxylic acid"),
    M(cyclo(5), "carbaldehyde"),
    # two features on the ring: the suffix takes locant 1
    M(cyclo(6), "ol", [1], prefixes=[("methyl", [1])]),
    M(cyclo(6), "one", [1], prefixes=[("methyl", [4])]),
    M(cyclo(6), "one", [1], prefixes=[("methyl", [4, 4])]),
    M(cyclo(6), "one", [1], ene=[2]),
    M(cyclo(5), "one", [1], ene=[2]),
    M(cyclo(5), "one", [1], ene=[2], prefixes=[("methyl", [3])]),
    M(cyclo(6), "one", [1, 3], common="dihydroresorcinol"),
    M(cyclo(6), "one", [1, 4]),
    M(cyclo(6), ene=[1, 3]),
    M(cyclo(6), ene=[1, 4]),
    M(cyclo(6), prefixes=[("methyl", [1, 1])]),
    # benzene with prefixes
    M(BENZENE, prefixes=[("chloro", [1])]),
    M(BENZENE, prefixes=[("ethyl", [1])]),
    M(BENZENE, prefixes=[("methyl", [1, 2])], common="o-xylene"),
    M(BENZENE, prefixes=[("methyl", [1, 4])], common="p-xylene"),
    M(BENZENE, prefixes=[("methyl", [1, 3, 5])], common="mesitylene"),
    M(BENZENE, prefixes=[("chloro", [1, 4])], common="p-dichlorobenzene"),
    # phenols and benzene diols
    M(BENZENE, "ol", [1], prefixes=[("methyl", [4])], common="p-cresol"),
    M(BENZENE, "ol", [1], prefixes=[("chloro", [4])]),
    M(BENZENE, "ol", [1, 2], common="catechol"),
    M(BENZENE, "ol", [1, 4], common="hydroquinone"),
    # benz- acids, aldehydes, amides, esters
    M(BENZENE, "carbaldehyde", common=""),
    M(BENZENE, "carboxamide", common=""),
    M(BENZENE, "carboxylate", ester="methyl"),
    M(BENZENE, "carboxylic acid", [1], prefixes=[("methyl", [4])], common="p-toluic acid"),
    M(BENZENE, "carbaldehyde", [1], prefixes=[("hydroxy", [4])]),
    M(BENZENE, "carboxylic acid", [1, 4], common="terephthalic acid"),
    # a phenyl ring hanging off a chain
    M(C(1), "ol", [1], prefixes=[("phenyl", [1])], common="benzyl alcohol"),
    M(C(2), "one", [1], prefixes=[("phenyl", [1])], common="acetophenone"),
    M(C(2), "ol", [1], prefixes=[("phenyl", [2])], common="phenethyl alcohol"),
    M(C(2), "amine", [1], prefixes=[("phenyl", [2])], common="phenethylamine"),
]

H = hetero
HETEROCYCLES = [
    # aromatic, nitrogen
    M(H("pyridine")),
    M(H("pyridine"), prefixes=[("methyl", [3])], common="3-picoline"),
    M(H("pyridine"), prefixes=[("methyl", [2, 6])], common="2,6-lutidine"),
    M(H("pyridine"), "amine", [2]),
    M(H("pyridine"), "ol", [3]),
    M(H("pyridine"), "carbaldehyde", [4]),
    M(H("pyridine"), "carboxylic acid", [3], common="niacin"),
    M(H("pyridine"), "carboxamide", [3], common="nicotinamide"),
    M(H("pyrimidine")),
    M(H("pyrimidine"), "amine", [2]),
    M(H("pyrrole"), common="pyrrole"),
    M(H("imidazole"), common="imidazole"),
    M(H("imidazole"), prefixes=[("methyl", [1])]),
    # aromatic, oxygen and sulfur
    M(H("furan")),
    M(H("furan"), prefixes=[("methyl", [2])], common="sylvan"),
    M(H("furan"), "carbaldehyde", [2], common="furfural"),
    M(H("thiophene")),
    M(H("thiophene"), "carboxylic acid", [2]),
    # saturated
    M(H("oxirane"), common="ethylene oxide"),
    M(H("oxolane"), common="tetrahydrofuran (THF)"),
    M(H("oxolane"), "one", [2], common="gamma-butyrolactone"),
    M(H("oxane"), common="tetrahydropyran"),
    M(H("1,4-dioxane"), common="dioxane"),
    M(H("pyrrolidine")),
    M(H("pyrrolidine"), "one", [2], common="2-pyrrolidone"),
    M(H("pyrrolidine"), "one", [2], prefixes=[("methyl", [1])], common="NMP"),
    M(H("piperidine")),
    M(H("piperidine"), prefixes=[("methyl", [1])]),
    M(H("piperidine"), "one", [4]),
    M(H("piperidine"), "ol", [4]),
    M(H("morpholine")),
    M(H("morpholine"), prefixes=[("methyl", [4])]),
]

SETS = [("chains", T_CHAIN, CHAINS), ("rings", T_RING, RINGS), ("heterocycles", T_HET, HETEROCYCLES)]


def generate() -> list[dict]:
    out = []
    for tag, tier, recipes in SETS:
        for spec in recipes:
            spec.tier, spec.tags = tier, [tag, "generated"]
            out.append(Builder(spec).build())
    return out


def render(entries) -> str:
    head = "# GENERATED by scripts/make_molecules.py. Edit the recipes there, not this file.\n\n"
    return head + yaml.safe_dump(entries, sort_keys=False, default_flow_style=None, width=200, allow_unicode=True)


if __name__ == "__main__":
    entries = generate()
    OUT.write_text(render(entries))
    print(f"{len(entries)} molecules -> {OUT.relative_to(ROOT)}")
