import { describe, it, expect } from 'vitest';
import {
  hexToOklab, oklabToHex, blend, deltaE, mix, indexGroups, resolveRecipe, groupColor,
  fragmentColor, palette, closePairs, minDeltaE, simulate, WARN_DELTA_E,
} from '../src/color.js';
import registry from '../data/groups.json';

const groups = indexGroups(registry.groups);

describe('OKLab', () => {
  it('matches reference values', () => {
    const near = (hex, lab) => hexToOklab(hex).forEach((v, i) => expect(v).toBeCloseTo(lab[i], 3));
    near('#ffffff', [1, 0, 0]);
    near('#000000', [0, 0, 0]);
    near('#ff0000', [0.628, 0.2249, 0.1258]);
    near('#0000ff', [0.452, -0.0325, -0.3115]);
  });

  it('round-trips', () => {
    for (const h of ['#ff0000', '#00ff00', '#0000ff', '#98a0aa', '#123456', '#c9ce34'])
      expect(oklabToHex(hexToOklab(h))).toBe(h);
  });

  it('deltaE: 0 for identical, 100 for black/white, symmetric', () => {
    expect(deltaE('#336699', '#336699')).toBe(0);
    expect(deltaE('#000000', '#ffffff')).toBeCloseTo(100, 1);
    expect(deltaE('#ff0000', '#00ff00')).toBeCloseTo(deltaE('#00ff00', '#ff0000'), 9);
  });
});

describe('blending', () => {
  it('is the OKLab midpoint, not the sRGB one', () => {
    const b = blend(['#ff0000', '#0000ff']);
    const lab = hexToOklab(b), r = hexToOklab('#ff0000'), u = hexToOklab('#0000ff');
    lab.forEach((v, i) => expect(v).toBeCloseTo((r[i] + u[i]) / 2, 2));
    expect(b).not.toBe('#800080');
    expect(blend(['#123456'])).toBe('#123456');
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
  });
});

describe('recipe resolution', () => {
  it('composites resolve to base groups', () => {
    expect(resolveRecipe('carboxylic-acid', groups)).toEqual(['carbonyl', 'hydroxyl']);
    expect(resolveRecipe('ester', groups)).toEqual(['carbonyl', 'ether-oxygen']);
    expect(resolveRecipe('amide', groups)).toEqual(['carbonyl', 'amine']);
    expect(resolveRecipe('hydroxyl', groups)).toEqual(['hydroxyl']);
  });

  it('resolves nested recipes', () => {
    const g = indexGroups([
      { id: 'a', color: '#ff0000' }, { id: 'b', color: '#00ff00' }, { id: 'c', color: '#0000ff' },
      { id: 'ab', recipe: ['a', 'b'] }, { id: 'abc', recipe: ['ab', 'c'] },
    ]);
    expect(resolveRecipe('abc', g)).toEqual(['a', 'b', 'c']);
    expect(groupColor('abc', g)).toBe(blend(['#ff0000', '#00ff00', '#0000ff']));
  });

  it('composite color = blend of its recipe, and follows edits to the bases', () => {
    const ester = blend([groups.carbonyl.color, groups['ether-oxygen'].color]);
    expect(groupColor('ester', groups)).toBe(ester);
    const pins = { carbonyl: '#ffffff' };
    expect(groupColor('ester', groups, pins)).toBe(blend(['#ffffff', groups['ether-oxygen'].color]));
  });

  it('a pinned color beats both the default and the blend', () => {
    expect(groupColor('ester', groups, { ester: '#00ff00', carbonyl: '#ffffff' })).toBe('#00ff00');
    expect(groupColor('hydroxyl', groups, { hydroxyl: '#111111' })).toBe('#111111');
  });

  it('fragment color = average over its groupIds; none -> null', () => {
    expect(fragmentColor(['hydroxyl'], groups)).toBe(groups.hydroxyl.color.toLowerCase());
    expect(fragmentColor(['carbonyl', 'hydroxyl'], groups)).toBe(groupColor('carboxylic-acid', groups));
    expect(fragmentColor([], groups)).toBe(null);
  });
});

describe('deltaE warning', () => {
  it('flags close pairs, derived blends included, sorted worst first', () => {
    const pins = { hydroxyl: groups.carbonyl.color }; // acid blend collapses onto carbonyl
    const pairs = closePairs(groups, pins);
    expect(pairs[0].dE).toBe(0);
    const ids = pairs.map((p) => [p.a, p.b].sort().join('+'));
    expect(ids).toContain('carbonyl+hydroxyl');
    expect(ids).toContain('carbonyl+carboxylic-acid');
  });

  it('threshold is exclusive and configurable', () => {
    const g = indexGroups([{ id: 'a', color: '#808080' }, { id: 'b', color: '#868686' }]);
    const d = deltaE('#808080', '#868686');
    expect(closePairs(g, {}, d)).toEqual([]);
    expect(closePairs(g, {}, d + 0.01)).toHaveLength(1);
  });
});

describe('default palette is validated', () => {
  it('has 13 colors: 10 base + 3 blends (alias groups add none)', () => {
    expect(Object.keys(palette(groups))).toHaveLength(13);
    expect(groups.heteroaromatic.alias).toBe('aromatic');
    expect(groupColor('heteroaromatic', groups)).toBe(groupColor('aromatic', groups));
    expect(groupColor('heteroaromatic', groups, { aromatic: '#123456', heteroaromatic: '#ffffff' })).toBe('#123456');
    expect(closePairs(groups, {}, 1).some((p) => p.a === 'heteroaromatic' || p.b === 'heteroaromatic')).toBe(false);
  });

  it('raises no warnings in normal vision', () => {
    expect(closePairs(groups, {}, WARN_DELTA_E)).toEqual([]);
  });

  it.each([['normal', 9], ['protan', 7], ['deutan', 7], ['tritan', 4.5]])(
    'every pair stays apart under %s vision (min deltaE >= %d)',
    (vision, floor) => expect(minDeltaE(groups, {}, vision)).toBeGreaterThanOrEqual(floor),
  );

  it('colour-vision simulation actually changes red/green', () => {
    expect(deltaE(simulate('#ff0000', 'deutan'), simulate('#00a000', 'deutan'))).toBeLessThan(deltaE('#ff0000', '#00a000') / 2);
    expect(simulate('#808080', 'protan')).toBe('#808080');
  });

  it('every color is readable on the dark stage (OKLab L >= 0.64)', () => {
    for (const hex of Object.values(palette(groups))) expect(hexToOklab(hex)[0]).toBeGreaterThanOrEqual(0.64);
  });
});
