#!/usr/bin/env python3
"""Authoring aid: number the atoms of a SMILES and check the name with OPSIN.

    python scripts/draft_molecule.py "N-phenylethanamide" "CC(=O)Nc1ccccc1"

Prints each heavy atom's index, element and neighbours (what you need to fill
in `atoms:` and `locants:`), then a YAML skeleton to paste into
data/molecules.yaml. It does not guess fragments; build_data.py stays the gate.
"""
import sys

from rdkit import Chem

import build_data as bd


def main(name: str, smiles: str) -> int:
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        print(f"unparsable SMILES {smiles!r}")
        return 1
    errs = bd.check_opsin({"name": name}, mol, bd.opsin_batch([name])[0]) + bd.check_stereo(mol)
    print("OPSIN:", "name matches SMILES" if not errs else "")
    for e in errs:
        print("  ERROR:", e)
    ring = mol.GetRingInfo()
    print("\nidx  el  neighbours")
    for a in mol.GetAtoms():
        nbrs = " ".join(
            f"{n.GetSymbol()}{n.GetIdx()}{'=' if mol.GetBondBetweenAtoms(a.GetIdx(), n.GetIdx()).GetBondTypeAsDouble() == 2 else ''}"
            for n in a.GetNeighbors()
        )
        note = "ring" if ring.NumAtomRings(a.GetIdx()) else ""
        print(f"{a.GetIdx():>3}  {a.GetSymbol():<2}  {nbrs:<24} {a.GetTotalNumHs()}H {note}")
    slug = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
    print(f"""
- id: {slug}
  name: {name}
  commonName: ""
  smiles: {smiles}
  tier: 5
  tags: []
  fragments:
    - {{ text: "", role: parent, groupIds: [parent], atoms: [] }}
  locants: {{ }}
""")
    return 1 if errs else 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
