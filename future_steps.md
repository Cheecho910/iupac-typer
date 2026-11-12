# Future steps

## Done (2026-11-11, second pass)

1. **Thicker double/triple bonds** in ball-and-stick.
2. **Labels on the atoms**: chain number on carbons, element symbol on the
   rest, both toggles kept. The hover-only variant was not built.
3. **Session stats row** under the per-molecule stats. Muted, not red; change
   `--session` in `src/style.css` if you want red.
4. **Playlists**: `data/playlists.yaml`, picker in the top bar, unlock-in-order
   ramp (setting), per-playlist progress in Explore. Three lists: Foundations,
   Medicine cabinet, Caffeine and cousins. 13 new molecules.
5. **On-screen keyboard** (asked for mid-build): clickable, lights the next key
   only when the character is already visible.
6. **Data model** grew to carry the new molecules: letter locants (`N-`),
   substituent numbering frames, explicit locant targets (`for:`), fixed
   numbering for purine, `descriptor` fragments, alias groups.
7. **Bug fixed**: the lowest-locant check compared chains against a nonsense
   renumbering instead of the reversed chain, so a backwards chain could pass
   (`butan-3-one`). None of the 24 original molecules was affected.

8. **Bug fixed (2026-11-12)**: the playlist dropdown closed the moment it was
   clicked, because the top bar blurred every clicked control to keep the
   keyboard on the game. Dropdowns are now exempt, and a focused form control
   keeps its own keys (arrows, Enter, Esc).

## Done (2026-11-12, third pass)

- **Molecule generator** (`scripts/make_molecules.py`): one-line recipes for
  chains, cycloalkanes, benzenes and monocyclic heterocycles. This is the
  "real authoring helper" for those families. 127 new molecules, 164 total.
- **Three new playlists**: Longer chains, more groups (53); Rings with groups
  (42); Heterocycles (32). The first playlist is now called Beginner.
- **New checks**: longest chain for open-chain parents; ring direction for
  monocyclic heterocycles; ring-closing double-bond locants.
- **Common name** moved above the typed name, larger.
- **End-group motion**: methyls, hydroxyls and amino groups spin; small end
  groups wag.
- **GitHub**: repo, CI (unit + browser + data) and Pages deploy.

## Next

- **Fused heterocycles** (indole, quinoline) need locants like `3a`/`8a`,
  which the label format does not carry yet.
- **Generator gaps**: nested substituents (parentheses), nitro/cyano/alkoxy
  prefixes, nitriles, E/Z and R/S. It does not check suffix seniority.
- **Bundle size**: molecule data is now a quarter of the download. Past a few
  hundred molecules, load each playlist on demand.

- **Authoring helper, real version.** `scripts/draft_molecule.py` only prints
  atom indices and checks OPSIN. Proposing fragment-to-atom assignments from
  the name is still by hand, and it is the cost that limits how many drugs
  get added. Lidocaine took 13 fragments.
- **Stereo** (below). Blocks ibuprofen, nicotine and most of the pharmacopoeia.
- **More parents**: pyridine, quinoline, indole, piperidine, morpholine. Each
  retained name is a deliberate exception to list in the README, and each
  fused one needs `numbering: fixed`.
- **Palette**: full at 13 colors. New groups should alias an existing color
  unless one is retired.
- **Per-fragment result summary** after long names, so one wrong locant in a
  49-character name does not read as total failure.
- **Hover-only labels** as a third label state for crowded molecules.
- **Validation gaps to close**: parent-chain choice (longest chain), fused
  numbering, and the content of hydro/indicated-hydrogen descriptors.

## Notes kept from the planning pass

Written before the second pass. Points 1, 2 and 6 below are now partly
addressed (see Done); 3, 4, 5 and 7 still stand.

### Why drugs are a different project (large)
Be honest about this: the playlist UI is a day; the content is weeks.

1. **Fused and heterocyclic parents break the data model.** Caffeine's
   systematic name is `1,3,7-trimethyl-3,7-dihydro-1H-purine-2,6-dione`. The
   build assumes the parent is a chain or single ring numbered 1..n with
   consecutive numbers bonded and carbon-only. Purine numbering is not a
   walk around the ring, includes nitrogens, and carries indicated hydrogen
   (`3,7-dihydro-1H`). Needed: heteroatom-capable parents, fused-ring numbering
   authored as data (not checked as a path), a new fragment role for
   hydro/indicated-hydrogen prefixes, and a rewrite of `check_locants` and
   `check_lowest_locants`. OPSIN will still validate the name.
2. **Retained parent names.** `purine`, `quinoline`, etc. are retained. The
   naming convention in the README has one exception (phenol) and must be
   widened deliberately, with each exception listed.
3. **Stereo is the next wall.** Many drugs have stereocentres (ibuprofen,
   nicotine), and the build rejects them. Early lists should be achiral:
   caffeine, theobromine, theophylline, paracetamol, aspirin, lidocaine,
   benzocaine. Real stereo support is in "Deferred" below.
4. **Typing difficulty jumps.** Names get long and punctuation-heavy: nested
   parentheses, `N-` locants, comma-separated locant lists. Check the HUD and
   "auto-punctuation" behave with these, and consider a per-fragment error
   summary at the end of a run, since one wrong locant in a 40-character name
   should not feel like total failure.
5. **Hand-authoring atom ownership does not scale to 20+ atoms.** This is the
   real cost. Build an authoring helper that proposes fragment-to-atom
   assignments from the name and SMILES (substructure match per suffix or
   prefix) and prints them for review. The existing validators stay the gate.
   Without it, each drug is an hour of error-prone indexing.
6. **The palette is already at its ceiling.** 13 colors with a tritan floor of
   4.5. New groups (heteroaromatic ring, acyloxy, N-substituent, hydro prefix)
   will not fit under the current deltaE test. Options: keep a fixed global
   palette and merge related groups into one color, or give each playlist its
   own validated sub-palette. A color that means different things in different
   lists undermines the core mechanic, so prefer merging.
7. **Names must be validated, not recalled.** Candidate names for aspirin
   (`2-(ethanoyloxy)benzoic acid` under this repo's convention) and
   paracetamol (`N-(4-hydroxyphenyl)ethanamide`) go through OPSIN and the
   locant checks like everything else. Do not write them into `molecules.yaml`
   from memory.

### Suggested order
1. Playlist plumbing and "Foundations" (no data changes).
2. Authoring helper (item 5 above).
3. Substituted benzenes and acyl groups: aspirin, paracetamol, benzocaine.
   Needs `N-` locants and parentheses only; no new parent types.
4. Heterocyclic and fused parents: caffeine, theobromine, theophylline. Needs
   items 1-2 above and the palette decision (6).
5. Stereo, then chiral drugs.

## Deferred

### Stereochemistry

Decided 2026-11-12 (Anthony):
- **Scope**: R/S and E/Z together, CIP descriptors only. No cis/trans rings,
  D/L, meso or pseudoasymmetric centres yet.
- **Name format**: always with locant: `(2R)-butan-2-ol`, `(2E)-but-2-ene`,
  `(2R,3S)-...`.
- **3D help**: an on-screen "Priorities" toggle shows CIP ranks 1-4 on the
  substituents of each centre (and the two higher-priority groups of each
  double bond). Forced off at level 3 (Recall).
- **Counterparts**: a chiral molecule is authored once; the build generates
  its mirror image as a second card, which enters the pool when the first
  reaches level 2. Working assumptions, not yet confirmed: for E/Z the second
  card is the other geometric isomer; with 2+ centres only the full enantiomer
  is generated and diastereomers are authored by hand; drugs sold as racemates
  (ibuprofen) appear as the two enantiomer cards, with no `rac-` card.

Build notes:
- New fragment role `stereo` (`(2R)-`): owns no atoms, points at the centre or
  bond. Check: the letter equals RDKit's CIP label (new `rdCIPLabeler`) for the
  atom/bond at that locant, and every stereo element in the SMILES is cited.
- `check_stereo` flips from "reject any" to "reject any left unspecified".
- The stereo token takes no new palette color (the palette is full): neutral
  text, with the centre atom ringed on hover.
- Embedding already uses proper rotations only, so orientation cannot mirror
  a molecule. Add a test that the embedded CIP labels match the SMILES.
- Do E/Z first (no mirror-image machinery), then R/S.
- Ibuprofen's name nests brackets (`2-[4-(2-methylpropyl)phenyl]propanoic
  acid`), so `[` and `]` need adding to the engine's punctuation set and the
  on-screen keyboard.

Original notes:
- MVP has no stereo. `build_data.py` **rejects** any molecule with a potential
  stereocentre or E/Z double bond (`check_stereo`), so one can't slip in by
  accident. That guard is the thing to relax when this lands.
- What adding it means:
  - Names gain stereodescriptor fragments: `(2R)-`, `(E)-`, `(2R,3S)-`. Needs a
    new fragment role (`stereo`) that owns no atoms but points at a centre/bond.
  - SMILES must carry stereo (`@`, `/`, `\`); embedding must preserve it and the
    OPSIN check must compare full (stereo) InChIKeys, which it already does.
  - New validation: the descriptor in the name equals the CIP label RDKit
    computes for the atom/bond it points at.
  - 3D view: wedge/hash is meaningless in 3D; highlight the centre and its
    four substituents by CIP priority instead.
  - `but-2-ene`, `butan-2-ol` and friends become available as seed molecules.

### Richer groups
- `groups.json` supports `recipe` composites, so aldehyde vs ketone, nitrile,
  acyl halide, anhydride, etc. can be added as data. Subject to the palette
  ceiling in playlist item 6.
