Build a minimal, fast TYPING GAME for learning IUPAC names from 3D molecules.
Color is the core mechanic, not decoration. Working MVP first, no gold-plating.

GAME LOOP
A 3D molecule appears, colored by functional group. Player types its IUPAC name.

CORE CONCEPT
Each name fragment (locants, substituents, parent, suffix) maps to specific
atoms. One color links a fragment to its atoms. Typed characters render in
their fragment's color; when a fragment completes, its atoms pulse. That's how
the player learns "-ol = this blob".

STACK
Vite + vanilla JS (or React, justify in one line), 3Dmol.js, localStorage.
Static site, no runtime backend. Dark theme, desktop-first.
Python (RDKit) build script for data.

TYPING ENGINE
- Target = ONE canonical name string per molecule. No fuzzy matching.
- Global keydown capture, no visible input box. Pause capture when a panel
  or settings is open.
- Stop-on-error (Monkeytype style): wrong key flashes red, doesn't advance,
  counts as an error on the current fragment. Case-insensitive. Hyphens,
  commas, spaces, parentheses must be typed (setting: auto-punctuation,
  default OFF).
- ALL letters/digits are input, so NO letter/digit hotkeys.
  Enter = next (after finishing) / skip (counts as fail), Esc = pause/menu,
  Tab = hint (reveal next fragment, penalty; preventDefault).
  3D = mouse/touch only. Style toggles (ball-stick / spacefill / wireframe)
  and the locant toggle are on-screen buttons.
- Metrics: accuracy, WPM (chars/5/min), time, per-fragment error counts.

LEVELS (per-molecule, stored in localStorage)
L1 Copy: full name as ghost text, tokens colored. Typing practice + color link.
L2 Slots: colored blanks only, one per fragment, width = fragment length,
   punctuation shown. Color + length are the hint.
L3 Recall: structure only. Tab reveals next fragment (penalty).
Promote after 2 consecutive clean runs (>=95% accuracy, no hints). Demote one
level on <70% accuracy or a skip. Picker weights toward weak molecules.
Common name sits under the structure, non-interactive: shown in L1/L2, hidden
in L3 until finished (settings toggle).

MODES
Zen: untimed, adaptive picker.
Sprint (build last): 60s, combo multiplier for consecutive clean molecules,
end screen with accuracy/WPM/worst fragments.

3D VIEW
- Auto-orient so the parent chain/ring lies flat facing the camera.
  Slow auto-rotate, pauses on interaction. Hydrogens small and dim.
- Locant numbers (1,2,3...) as small labels on parent-chain atoms, using
  correct IUPAC numbering from the data. Toggle to hide (= expert modifier).
- Hover a token -> highlight its atoms, dim the rest. Hover atoms -> token.

COLOR SYSTEM
- `groups.json`: id, name, hex color (compute in OKLab), optional `recipe`
  (list of constituent group ids), priority.
- MVP groups: parent chain (neutral), alkyl, alkene, alkyne, halide, hydroxyl,
  carbonyl, amine, ether-oxygen, aromatic ring. Composites by recipe:
  carboxylic acid = carbonyl+hydroxyl, ester = carbonyl+ether-oxygen,
  amide = carbonyl+amine.
- A fragment's color = OKLab average of its groupIds' colors (composites
  resolve through their recipe) unless the user pinned an explicit color.
  Atoms take their fragment's color. Atom claimed twice -> higher priority wins.
- Color-blind-safe defaults; validate them.
- Settings panel: picker per group, live preview on a sample molecule, reset,
  export/import palette JSON. WARN when any two colors (including derived
  blends) are too close (OKLab deltaE under threshold). Mixing goes to mud fast.
- Locants and hyphens take the color of the fragment they point to.
- Heteroatom identity (O/N/Cl) shown via thin outline or badge (toggle) so
  group color doesn't erase element info. Color must never be the only cue.

NAMING CONVENTION (state in README)
Fully systematic substitutive names, locant immediately before the suffix:
propan-2-one (not 2-propanone), ethanoic acid (not acetic acid),
methylbenzene (not toluene). Sole exception: phenol. No stereo in MVP: skip
any molecule with a stereocenter or E/Z.

DATA PIPELINE: scripts/build_data.py, source of truth data/molecules.yaml
Per molecule, hand-authored: id, name, commonName, smiles, tags/tier,
fragments (ordered: text, role = locant|substituent|parent|ending|suffix|
separator, groupIds, atoms = heavy-atom indices in SMILES order),
locants {heavyAtomIndex: label}.
Ownership rule: the suffix owns the characteristic-group atoms even when they
are chain carbons (the C=O carbon in propan-2-one belongs to "one", not
"propan"). Locant labels are independent of ownership. Locant/separator
fragments own no atoms.
Example: 2-methylpropan-1-ol = "2-"(locant, alkyl) "methyl"(alkyl) "propan"
(parent) "-1-"(locant, hydroxyl) "ol"(hydroxyl; owns O+H).
Script:
 1. Embed 3D from SMILES (RDKit ETKDG + MMFF), AddHs, write molblocks into
    public/molecules.json. Do NOT use PubChem 3D SDFs (atom order mismatch).
 2. Assign each H to its parent heavy atom's fragment.
 3. Validate, fail loudly:
    - fragment texts concatenate EXACTLY to name (also a unit test)
    - every heavy atom owned by exactly one fragment
    - name -> OPSIN (web service or jar) -> structure matches the SMILES
      (InChIKey or canonical SMILES). Do NOT compare against PubChem's name
      string; it prefers retained names.
    - locant consistency: each locant fragment's number equals the chain
      label of the atom its group sits on or attaches to
    - element sanity per fragment ("ol" = exactly one O)
 4. Print a per-molecule report: fragment text -> atoms (element+index).
Never write a name or atom mapping from memory without it passing validation.

SEED MOLECULES (~24, names only; you write SMILES, validation catches errors)
T1: ethanol, propan-1-ol, propan-2-ol, ethanal, propan-2-one, butan-2-one,
    chloroethane, propan-1-amine, prop-1-ene, but-1-yne
T2: 2-methylpropan-1-ol, 2-methylpropan-2-ol, 3-methylbutan-1-ol,
    1-chloro-2-methylpropane
T3: ethanoic acid, propanoic acid, ethyl ethanoate, methyl propanoate,
    propanamide
T4: benzene, methylbenzene, phenol, cyclohexanol, cyclohexanone

BUILD ORDER (stop after each, tell me what to check)
1. Data pipeline + validation report on 5 molecules
2. Static viewer: one molecule, registry colors, locants, orientation
3. Typing engine on L1 with live token coloring + atom pulse
4. L2/L3, mastery storage, adaptive picker
5. Color settings panel + deltaE warning
6. Sprint mode + stats screen

RULES
- Minimal deps. Pure functions + unit tests for: typing engine (stop-on-error,
  punctuation setting, per-fragment error attribution), color blending (recipe
  resolution, deltaE), fragment/name invariant.
- Hooks, not features: molecules carry tags/tier so playlists can come later;
  the group registry supports recipes so richer groups can come later.
  Do NOT build playlists.
- README: setup (RDKit + OPSIN requirements), add a molecule, add a group,
  naming convention.
- Ambiguity: pick the simplest option, note it in the README. Don't ask me.

ADDENDUM 1: SHOW-NAME TOGGLE (add to LEVELS and settings)
- Global toggle "Show name" (on-screen button, no hotkey). When ON, the full
  IUPAC name is displayed as colored ghost text at every level, including
  L3, and typing works exactly the same (stop-on-error, live coloring, atom
  pulse). Typing becomes copy-along practice.
- Show name is also a per-molecule view in Explore: name displayed, no typing
  required, hover tokens <-> atoms.
- When ON, hint penalties are disabled, and runs don't count toward
  promotion/demotion or mastery. They still log WPM/accuracy separately.
- Common name stays under the structure, non-interactive.

ADDENDUM 2: STEREOCHEMISTRY
- Not a concern for now; add later. See future_steps.md.

ADDENDUM 3 (2026-11-11): see future_steps.md "Done"
- Thicker double/triple bonds; labels drawn on atoms; session stats row;
  playlists working up to drug molecules; on-screen interactive keyboard.
