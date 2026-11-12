# IUPAC Typer

Typing game for learning IUPAC names from 3D molecules. Each fragment of a name
(locant, substituent, parent, suffix) has one color, and so do the atoms it
stands for. You type the name; as each fragment completes, its atoms pulse.

Three playlists, 37 molecules: Foundations, Medicine cabinet (aspirin,
benzocaine, paracetamol, lidocaine) and Caffeine and cousins.

Full spec: `docs/SPEC.md`. What is done and what is next: `future_steps.md`.

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # typing engine, color math, mastery rules
npm run build      # static site in dist/ (no backend)
```

`npm run e2e` builds the site and clicks every control in a real browser
(`npx playwright install chromium` once, or set `CHROME_PATH`).

GitHub Actions (`.github/workflows/`): `ci.yml` runs the unit, browser and data
tests on every push; `deploy.yml` publishes `dist/` to GitHub Pages from `main`
(one-time: repo Settings -> Pages -> Source: GitHub Actions).

Vanilla JS on purpose: the UI is one screen and the state is a handful of
variables, so a framework would be the largest dependency for no gain.

## Rebuild the molecule data (only when you edit `data/`)

Needs Python 3.10+ and **Java 8+** (OPSIN is a jar; `py2opsin` bundles it).

```sh
brew install openjdk                 # if `java -version` fails
pip install -r scripts/requirements.txt
python scripts/build_data.py         # validates, prints a report, writes public/molecules.json
python -m pytest tests
```

Any validation error aborts the build and nothing is written.
`public/molecules.json` is committed, so the game runs without Python.

## How to play

| Key | Does |
| --- | --- |
| letters, digits, `-` `,` space `(` `)` | type the name (case-insensitive; a wrong key does not advance) |
| `Tab` | hint: reveal the fragment at the cursor (levels 2-3; breaks the clean streak) |
| `Enter` | next molecule when finished; skip when not (a skip demotes one level) |
| `Esc` | pause, menu, lifetime stats |

Everything else is an on-screen button, because every letter and digit is input.
The on-screen keyboard (toggle "Keyboard") is clickable, so the game also works
by mouse or touch. It lights the next key only when that character is already
visible; in Slots and Recall it stays dark so it cannot give the answer away.

- **Levels, per molecule.** 1 Copy (name shown as ghost text), 2 Slots (one
  colored blank per character, punctuation shown), 3 Recall (structure only).
  Two clean runs in a row (95%+ accuracy, no hints) promote; under 70% or a
  skip demotes.
- **Zen** is untimed. **Sprint** is 60 s from the first key; score per molecule
  is its length times the combo (consecutive clean molecules, up to x5).
  **Explore** shows any molecule with its full name; hover a token or an atom.
- **Show name** turns every level into copy-along practice. Those runs never
  touch levels, and their accuracy/WPM are logged separately.
- **Playlists** are ordered ramps. With "Unlock in order" on (Settings), four
  molecules are open and one more opens for each that reaches level 2. Levels
  belong to the molecule, so progress carries across playlists.
- **Stats**: the first row is the current molecule; the "session" row is every
  keystroke since the page loaded (all modes, practice included).

## Naming convention

Fully systematic substitutive names, locant immediately before the suffix:
`propan-2-one` (not 2-propanone), `ethanoic acid` (not acetic acid),
`methylbenzene` (not toluene). No stereo yet. One canonical name string per
molecule; the common name is display-only.

Retained names, each a deliberate exception: `phenol`; `benzoic acid` and its
esters (`benz` + `oic acid` / `oate`); `purine` with its fixed numbering.
Acyl groups stay systematic (`ethanoyl`, not acetyl).

Xanthines carry their hydro prefixes and indicated hydrogen:
`1,3,7-trimethyl-3,7-dihydro-1H-purine-2,6-dione`. PubChem prints the shorter
`1,3,7-trimethylpurine-2,6-dione`; OPSIN accepts both. If you prefer the short
form, delete the `descriptor` fragment and edit `name`.

## Add a molecule

Append to `data/molecules.yaml` (format documented at the top of that file),
then run the data build. Rules:

- Fragment `text`s concatenate exactly to `name`.
- Every heavy atom is owned by exactly one fragment. Indices are SMILES order;
  the build report prints `element+index` per fragment so you can check.
- The suffix owns the characteristic-group atoms even if they are chain carbons
  (`one` owns C=O; `oate` owns C(=O)O; `ol` owns only O).
- `locants` number the parent chain/ring, independent of ownership.
- A locant fragment points at the next atom-owning fragment and carries its
  `groupIds`. When that is the wrong fragment, name the right one with `for:`
  (`2-` in `2-(ethanoyloxy)...` is `for: "oxy"`).
- Letter locants: label the heteroatom in `locants` (`{3: N}`), then `N-`
  is checked like any number.
- A substituent ring with its own locants (`4-` in `N-(4-hydroxyphenyl)...`)
  gets a map under `frames:`; its atom 1 is the point of attachment.
- Retained fused parents (purine): `numbering: fixed`. Numbers may then sit on
  heteroatoms and need not follow bonds.
- Hydro prefixes and indicated hydrogen are one `descriptor` fragment
  (`-3,7-dihydro-1H-`): typed and colored with the parent, owns no atoms.
- Parentheses are `separator` fragments.
- Add the id to at least one playlist in `data/playlists.yaml`; the build fails
  on a molecule nobody can reach.

`python scripts/draft_molecule.py "name" "SMILES"` (run from `scripts/`)
prints the atom indices and neighbours you need, plus a YAML skeleton.

The name is checked against OPSIN, so a wrong SMILES or wrong name fails.

## Add a playlist

Append to `data/playlists.yaml`: `id`, `name`, `description`, and `molecules`
in ramp order. A molecule can be in several playlists.

## Add a group

Add an entry to `data/groups.json`: `id`, `name`, `priority`, and either
`color` + `elements` (base group) or `recipe` (composite of base group ids).
`elements` is the heavy-atom composition a fragment of that group must own
(`1` exact, `"1+"` at least, `X` = any halogen); composites sum their recipe.
A composite's color is the OKLab average of its recipe unless the player pins
one. `npm test` fails if the default palette stops being distinct. The palette
is full: prefer `"alias": "<group>"` (same color, own element rule, as
`heteroaromatic` does with `aromatic`) to a 14th color.

## Layout

```
data/molecules.yaml, playlists.yaml, groups.json   source of truth
scripts/build_data.py              embed, orient, validate -> public/molecules.json
scripts/draft_molecule.py          authoring aid: atom table + OPSIN check
src/engine.js                      typing engine (pure)
src/color.js                       OKLab, blends, recipes, deltaE, CVD simulation (pure)
src/mastery.js                     levels + adaptive picker (pure)
src/viewer.js                      3Dmol wrapper
src/main.js, style.css             UI wiring
tests/                             pytest (data) + vitest (engine, color, mastery)
```

## Decisions made where the spec was ambiguous

Data
- **Locant target** is inferred (next atom-owning fragment), not authored.
- **Locant check**: the locants in the text must equal where the target is
  cited. Suffix: the numbers of the chain atoms it owns, else of the atoms it
  is bonded to. Substituent: the labels (numbers or letters) of the atoms it
  is bonded to. `ending` (ene/yne): the lower number of each multiple bond.
- **Chain numbering** is hand-authored but checked: 1..n, carbons only,
  consecutive numbers bonded, every `parent` atom numbered, and no alternative
  numbering of the same chain/ring gives lower locants (suffix, then ene/yne,
  then substituents). Substituent rings are checked the same way with atom 1
  pinned to the attachment point.
- **Not checked for fixed numbering (purine)**: the numbering itself is trusted
  data, tied to the name only through the locants the name cites. Hydro
  prefixes and indicated hydrogen (`descriptor`) are validated by OPSIN alone,
  and OPSIN cannot tell `3,7-dihydro-1H` from another valid distribution.
- **Known validation gap: parent-chain choice.** OPSIN is permissive: it
  confirms the name *denotes* the structure, not that it is the preferred
  name. Wrong direction is caught (above); picking a non-longest chain
  (`2-ethylpropane` for 2-methylbutane) is NOT. Review that by eye.
- **Esters**: only the acid chain is numbered; the O-alkyl group is a
  `substituent` (alkyl) with no locants. The space is a `separator`.
- **"an" belongs to the parent** (`propan`); `ene`/`yne` are `ending` fragments
  that own the two multiple-bond carbons. `cyclohexan` and `phen` are parents.
- **Aldehydes** use the `carbonyl` group (`al` owns C=O); no separate group yet.
- **Element sanity** is data-driven from `groups.json`, not hard-coded per suffix.
- **OPSIN** via bundled jar only (no web-service fallback). Comparison is by
  InChIKey computed by RDKit on both sides.
- **3D coords**: 30 conformers from a fixed seed; the one with the flattest
  parent chain wins (then lowest MMFF energy), then it is rotated so the parent
  lies in the screen plane with the molecule's long axis horizontal. Rebuilds
  are reproducible.
- **Stereo**: molecules with potential stereo are rejected, not silently skipped.
- **Common name** is empty for benzene and cyclohexanone (none worth showing).
- `public/molecules.json` is imported at build time (bundled), not fetched.

Game
- **Explore** (named in the Show-name addendum, not defined in the spec) is a
  molecule browser: full name, no typing, hover both ways.
- **Auto-rotate** is a slow rock of +/-22 degrees, not a full spin, so the parent
  chain keeps facing the camera. It stops on drag/scroll and resumes after 3.5 s.
- **Hint** shows the fragment as ghost text; you still type it. Any hint makes
  the run not clean. No-op in level 1 and while Show name is on.
- **Auto-punctuation ON**: punctuation is typed for you and punctuation keys
  are ignored (not errors). Toggling it restarts the current molecule.
- **Picker**: weighted random over the open part of the active playlist, never
  the same molecule twice running. Weak and low-level molecules weigh more;
  unseen ones enter at `3 / tier^2`.
- **Sprint** runs at each molecule's own level and counts toward levels (unless
  Show name is on). Auto-advances 0.34 s after a finished molecule.
- **Atom labels** sit on the atom, one per heavy atom, so they cannot collide:
  the chain number on carbons (toggle "Locants"), the element symbol on
  everything else (toggle "Elements"), `N1` when a ring nitrogen is numbered.
  Ink flips dark/light against the group color. Hydrogens are small and dimmed.
- **Double and triple bonds** are drawn at 0.7 / 0.45 of single-bond radius per
  line (3Dmol defaults 0.4 / 0.25). Constants at the top of `src/viewer.js`.
- **Framing**: the camera is fitted to each molecule and the stage's aspect,
  and refitted on resize until you rotate or zoom it yourself.
- **Session row** is muted, not red: red is the error flash and sits next to
  the carbonyl color. One line to change: `--session` in `src/style.css`.
- **Long names** shrink to fit one line (down to 14 px, then wrap).
- **Color preview** in Settings is the current molecule, live, beside the panel.
- **Palette export/import** goes through a text box (plus Copy), because hosted
  sandboxes block file downloads.
- **deltaE warning** fires under 8 (OKLab distance x100) for any two of the 13
  colors, derived blends included; the panel can also check simulated
  protanopia, deuteranopia and tritanopia.
- **Default palette** was searched to maximise the smallest pairwise distance
  across all four vision types. Achieved floors, enforced by tests: 9 normal,
  7 protan, 7 deutan, 4.5 tritan. Thirteen colors that stay far apart for
  dichromats is not achievable, so the element badges and the text itself are
  the non-color cues.
- **Group `priority`** ("atom claimed twice") is carried in the registry but
  unused at runtime: the build guarantees every atom has exactly one owner.
- **Touch**: 3D rotation works, and the on-screen keyboard types.
