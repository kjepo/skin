'use strict';
// Skin-tone presets: turn a sampled Lab colour into the Lab colour the preset
// wants at the same lightness.
//
// Hue always comes from the book-derived table. Chroma comes from the table
// inside the midtone band where Varis' CMY rule applies; below it we fade back
// to the sample's own chroma (the rule over-saturates shadows), and every
// target is capped at the preset's maxChroma.

const { PRESET_META, PRESET_TABLES, MIDTONE_BAND } = require('./preset-tables.js');
const { chroma, hue } = require('./colorspaces.js');

const SHADOW_FADE = 15; // L units below MIDTONE_BAND[0] over which chroma fades to the sample's

const PRESETS = Object.keys(PRESET_META).map((key) => ({ key, ...PRESET_META[key] }));

function getPreset(key) {
  const meta = PRESET_META[key];
  if (!meta) throw new Error(`Unknown skin preset "${key}" (expected one of ${Object.keys(PRESET_META).join(', ')})`);
  return { key, ...meta, table: PRESET_TABLES[key] };
}

// Linear interpolation of [a*, b*] in the table, clamping L to its range.
function tableAB(table, L) {
  const first = table[0][0], last = table[table.length - 1][0];
  const x = Math.min(last, Math.max(first, L));
  const i = Math.min(table.length - 2, Math.floor(x - first));
  const t = x - table[i][0];
  const [, a0, b0] = table[i], [, a1, b1] = table[i + 1];
  return [a0 + (a1 - a0) * t, b0 + (b1 - b0) * t];
}

function targetLab(presetKey, sampleLab) {
  const preset = getPreset(presetKey);
  const L = sampleLab[0];
  const [ta, tb] = tableAB(preset.table, Math.max(L, MIDTONE_BAND[0]));
  const h = Math.atan2(tb, ta);
  const w = Math.min(1, Math.max(0, (L - (MIDTONE_BAND[0] - SHADOW_FADE)) / SHADOW_FADE));
  const c = Math.min(preset.maxChroma, w * Math.hypot(ta, tb) + (1 - w) * chroma(sampleLab));
  return [L, c * Math.cos(h), c * Math.sin(h)];
}

// Plain-language reading of how a sample departs from its target, in the
// book's terms (Y vs M = yellow/red balance, C = greyness).
function diagnose(sampleLab, target, { hueTolerance = 5, chromaTolerance = 0.15 } = {}) {
  const notes = [];
  let dh = hue(sampleLab) - hue(target);
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  if (dh > hueTolerance) notes.push('too yellow');
  else if (dh < -hueTolerance) notes.push('too red/magenta');
  const tc = chroma(target);
  if (tc > 1) {
    const r = chroma(sampleLab) / tc;
    if (r > 1 + chromaTolerance) notes.push('too saturated');
    else if (r < 1 - chromaTolerance) notes.push('too grey');
  }
  return { hueShift: dh, chromaRatio: tc > 1 ? chroma(sampleLab) / tc : 1, notes: notes.length ? notes : ['ok'] };
}

module.exports = { PRESETS, getPreset, targetLab, diagnose };
