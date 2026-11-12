"""Data invariants + proof that each validator actually catches bad data.

Run:  python -m pytest tests
"""
import copy
import shutil
import sys
from pathlib import Path

import pytest
import yaml
from rdkit import Chem

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import build_data as bd  # noqa: E402

GROUPS = bd.load_groups()
MOLS = yaml.safe_load(bd.SRC.read_text())
BY_ID = {m["id"]: m for m in MOLS}


def variant(mol_id, edit):
    m = copy.deepcopy(BY_ID[mol_id])
    edit(m)
    return m, Chem.MolFromSmiles(m["smiles"])


@pytest.mark.parametrize("m", MOLS, ids=lambda m: m["id"])
def test_fragments_concatenate_to_name(m):
    assert "".join(f["text"] for f in m["fragments"]) == m["name"]


@pytest.mark.parametrize("m", MOLS, ids=lambda m: m["id"])
def test_offline_checks_pass(m):
    mol = Chem.MolFromSmiles(m["smiles"])
    assert bd.check_schema(m, GROUPS) == []
    assert bd.check_ownership(m, mol) == []
    assert bd.check_elements(m, mol, GROUPS) == []
    assert bd.check_locants(m, mol) == []
    assert bd.check_lowest_locants(m, mol) == []
    assert bd.check_stereo(mol) == []


def test_name_mismatch_caught():
    m, _ = variant("propan-2-one", lambda m: m["fragments"][1].update(text="-2"))
    assert bd.check_name(m)


def test_unowned_and_double_owned_atoms_caught():
    m, mol = variant("propan-2-one", lambda m: m["fragments"][0].update(atoms=[0]))
    assert any("C3 owned by 0" in e for e in bd.check_ownership(m, mol))
    m, mol = variant("propan-2-one", lambda m: m["fragments"][0].update(atoms=[0, 1, 3]))
    assert any("C1 owned by 2" in e for e in bd.check_ownership(m, mol))


def test_wrong_locant_caught():
    # says -1- but the carbonyl sits on chain carbon 2
    def edit(m):
        m["name"] = "propan-1-one"
        m["fragments"][1]["text"] = "-1-"
    m, mol = variant("propan-2-one", edit)
    assert any("says ['1']" in e for e in bd.check_locants(m, mol))


def test_wrong_chain_numbering_caught():
    # 1 and 2 swapped -> methyl no longer on "2", and 2-3 not bonded
    m, mol = variant("2-methylpropan-1-ol", lambda m: m.update(locants={1: 1, 3: 2, 0: 3}))
    errs = bd.check_locants(m, mol)
    assert any("not bonded" in e for e in errs) and any("says" in e for e in errs)


def backwards(m):
    # self-consistent but numbered from the wrong end: "2-methylpropan-3-ol"
    m["name"] = "2-methylpropan-3-ol"
    m["fragments"][3]["text"] = "-3-"
    m["locants"] = {0: 1, 1: 2, 3: 3}


def test_non_lowest_numbering_caught():
    m, mol = variant("2-methylpropan-1-ol", backwards)
    assert bd.check_name(m) == [] and bd.check_locants(m, mol) == []  # internally consistent
    assert any("not lowest-locant" in e for e in bd.check_lowest_locants(m, mol))
    # ring: 3-methylcyclohexan-1-ol numbered the long way round as 5-methyl
    ring = {
        "fragments": [
            {"text": "methyl", "role": "substituent", "groupIds": ["alkyl"], "atoms": [0]},
            {"text": "cyclohexan", "role": "parent", "groupIds": ["parent"], "atoms": [1, 2, 3, 4, 5, 6]},
            {"text": "ol", "role": "suffix", "groupIds": ["hydroxyl"], "atoms": [7]},
        ],
        "locants": {3: 1, 4: 2, 5: 3, 6: 4, 1: 5, 2: 6},
    }
    mol = Chem.MolFromSmiles("CC1CC(CCC1)O")  # CH3 on atom 1, OH on atom 3
    assert any("not lowest-locant" in e for e in bd.check_lowest_locants(ring, mol))
    ring["locants"] = {3: 1, 2: 2, 1: 3, 6: 4, 5: 5, 4: 6}
    assert bd.check_lowest_locants(ring, mol) == []


def test_reversed_chain_caught():
    # butan-3-one: self-consistent, OPSIN-parsable, but numbered from the wrong end
    def edit(m):
        m["name"] = "butan-3-one"
        m["fragments"][1]["text"] = "-3-"
        m["locants"] = {0: 1, 1: 2, 2: 3, 4: 4}
    m, mol = variant("butan-2-one", edit)
    assert bd.check_name(m) == [] and bd.check_locants(m, mol) == []
    assert any("not lowest-locant" in e for e in bd.check_lowest_locants(m, mol))


def test_renumberings_are_real_numberings():
    chain = Chem.MolFromSmiles("CCCC")
    assert bd.renumberings({0: 1, 1: 2, 2: 3, 3: 4}, chain, pinned=False) == [
        {0: 1, 1: 2, 2: 3, 3: 4}, {0: 4, 1: 3, 2: 2, 3: 1}]
    assert bd.renumberings({0: 1, 1: 2, 2: 3, 3: 4}, chain, pinned=True) == [{0: 1, 1: 2, 2: 3, 3: 4}]
    ring = Chem.MolFromSmiles("C1CCCCC1")
    num = {i: i + 1 for i in range(6)}
    assert len(bd.renumberings(num, ring, pinned=False)) == 12
    pinned = bd.renumberings(num, ring, pinned=True)
    assert len(pinned) == 2 and all(alt[0] == 1 for alt in pinned)


def test_letter_locants():
    assert bd.locant_tokens("N-") == ["N"] and bd.locant_tokens("-2,6-") == ["2", "6"]
    assert bd.locant_tokens("N,N-") == ["N", "N"]
    # "N-" must be where the phenyl actually attaches
    m, mol = variant("n-phenylethanamide", lambda m: m["fragments"][0].update(text="2-"))
    assert any("says ['2']" in e and "['N']" in e for e in bd.check_locants(m, mol))
    # a letter locant must sit on that element
    m, mol = variant("n-phenylethanamide", lambda m: m.update(locants={1: 1, 0: 2, 2: "N"}))
    assert any("letter locant 'N' is on a O atom" in e for e in bd.check_locants(m, mol))


def test_explicit_target_needed_and_checked():
    # without `for:` the "2-" of aspirin would point at "ethan", which is not on the ring
    m, mol = variant("2-ethanoyloxybenzoic-acid", lambda m: m["fragments"][0].pop("for"))
    assert any("groupIds" in e for e in bd.check_locants(m, mol))
    m, mol = variant("2-ethanoyloxybenzoic-acid", lambda m: m["fragments"][0].update({"for": "nope"}))
    assert any("no atom-owning fragment 'nope'" in e for e in bd.check_locants(m, mol))


def test_substituent_frame():
    pid = "n-4-hydroxyphenyl-ethanamide"
    # ring locant in the name must match the ring's own numbering
    m, mol = variant(pid, lambda m: m["fragments"][2].update(text="3-"))
    assert any("says ['3']" in e and "['4']" in e for e in bd.check_locants(m, mol))
    # atom 1 of a substituent ring is its point of attachment
    m, mol = variant(pid, lambda m: m.update(frames=[{5: 1, 6: 2, 7: 3, 9: 4, 10: 5, 4: 6}]))
    assert bd.check_locants(m, mol) != [] or any("point of attachment" in e for e in bd.check_lowest_locants(m, mol))
    m, mol = variant(pid, lambda m: m.update(frames=[{7: 1, 6: 2, 5: 3, 4: 4, 10: 5, 9: 6}]))
    assert any("point of attachment" in e for e in bd.check_lowest_locants(m, mol))
    # one atom cannot be numbered in two frames
    m, mol = variant(pid, lambda m: m.update(frames=[{1: 1, 4: 2}]))
    assert any("more than one frame" in e for e in bd.check_locants(m, mol))


def test_fixed_numbering_is_opt_in():
    m, mol = variant("caffeine", lambda m: m.pop("numbering"))
    errs = bd.check_locants(m, mol)
    assert any("not carbon" in e for e in errs) and any("not bonded" in e for e in errs)
    # still checked against the name: move a methyl locant
    m, mol = variant("caffeine", lambda m: m["fragments"][0].update(text="1,3,9-"))
    assert any("says ['1', '3', '9']" in e for e in bd.check_locants(m, mol))


def test_playlists_validated():
    ids = ["a", "b"]
    ok = [{"id": "p", "name": "P", "description": "d", "molecules": ["a", "b"]}]
    assert bd.check_playlists(ok, ids) == []
    assert any("unknown molecule 'zz'" in e for e in bd.check_playlists([{**ok[0], "molecules": ["a", "b", "zz"]}], ids))
    assert any("'b' is in no playlist" in e for e in bd.check_playlists([{**ok[0], "molecules": ["a"]}], ids))
    assert any("listed twice" in e for e in bd.check_playlists([{**ok[0], "molecules": ["a", "a", "b"]}], ids))
    assert any("duplicate playlist id" in e for e in bd.check_playlists(ok + ok, ids))
    real = yaml.safe_load(bd.PLAYLISTS.read_text())
    assert bd.check_playlists(real, [m["id"] for m in MOLS]) == []


def test_locant_group_must_match_target():
    m, mol = variant("2-methylpropan-1-ol", lambda m: m["fragments"][0].update(groupIds=["hydroxyl"]))
    assert any("groupIds" in e for e in bd.check_locants(m, mol))


def test_element_sanity_caught():
    # "ol" must own exactly one O; give the O to the parent instead
    def edit(m):
        m["fragments"][0]["atoms"] = [0, 1, 2]
        m["fragments"][1]["atoms"] = []
    m, mol = variant("ethanol", edit)
    errs = bd.check_elements(m, mol, GROUPS)
    assert any("'ol'" in e and "0 O" in e for e in errs)
    assert any("'ethan'" in e and "1 O" in e for e in errs)


def test_recipe_resolves_for_element_bounds():
    assert bd.resolve_groups(["ester"], GROUPS) == ["carbonyl", "ether-oxygen"]
    assert bd.element_bounds(["ester"], GROUPS) == {"C": (1, 1), "O": (2, 2)}


def test_stereo_rejected():
    assert bd.check_stereo(Chem.MolFromSmiles("CC(O)CC"))   # stereocentre
    assert bd.check_stereo(Chem.MolFromSmiles("CC=CC"))     # E/Z


@pytest.mark.skipif(shutil.which("java") is None, reason="OPSIN needs Java")
def test_opsin_catches_wrong_structure():
    good = BY_ID["propan-2-one"]
    bad, bad_mol = variant("propan-2-one", lambda m: m.update(smiles="CCC=O"))  # propanal
    # why check_lowest_locants exists: OPSIN happily accepts a backwards name
    back, back_mol = variant("2-methylpropan-1-ol", backwards)
    assert bd.check_opsin(back, back_mol, bd.opsin_batch([back["name"]])[0]) == []
    opsin = bd.opsin_batch([good["name"], "definitely not a name"])
    assert bd.check_opsin(good, Chem.MolFromSmiles(good["smiles"]), opsin[0]) == []
    assert any("mismatch" in e for e in bd.check_opsin(bad, bad_mol, opsin[0]))
    assert any("could not parse" in e for e in bd.check_opsin(good, bad_mol, opsin[1]))
