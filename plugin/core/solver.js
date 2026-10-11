'use strict';
// Turn skin samples + a preset into per-channel RGB curve points.
//
// Samples are grouped by lightness; each group's mean RGB gets one point on
// each channel's curve, mapping it to the RGB of the preset target at the same
// L. Curves are 1-D per channel, so groups must sit in the same order on all
// three channels; if they don't, everything is merged into a single group.
// An optional neutral reference (a white or grey sampler) adds one more point
// mapping it to neutral at its own lightness, as Varis does before touching skin.
// Between and beyond these points the curve is a smooth monotone function.

const { rgbToLab, labToRgb, resolveSpace, deltaE } = require('./colorspaces.js');
const { targetLab, diagnose } = require('./presets.js');

const GROUP_GAP_L = 15; // a lightness gap this large starts a new group
const MAX_GROUPS = 3;
const MIN_POINT_SPACING = 8; // Photoshop's curve gets wild with closer points
const MAX_END_SLOPE = 1.6; // steepest allowed segment to the black/white ends
const GRID = [0, 32, 64, 96, 128, 160, 192, 224, 255];
// A white reference may sit closer to skin than MIN_POINT_SPACING (bright skin
// is nearly white in red), but the curve between them must stay this gentle.
const NEUTRAL_MIN_SPACING = 3;
const NEUTRAL_MAX_SLOPE = 3;

const CHANNELS = ['red', 'green', 'blue'];

const mean = (rows) => [0, 1, 2].map((i) => rows.reduce((s, r) => s + r[i], 0) / rows.length);

function groupByLightness(samples) {
  const sorted = [...samples].sort((p, q) => p.lab[0] - q.lab[0]);
  let groups = [];
  for (const s of sorted) {
    const g = groups[groups.length - 1];
    if (g && s.lab[0] - g[0].lab[0] < GROUP_GAP_L) g.push(s);
    else groups.push([s]);
  }
  while (groups.length > MAX_GROUPS) {
    // merge the pair of neighbours with the smallest gap
    let best = 0;
    for (let i = 1; i < groups.length - 1; i++) {
      const gap = (k) => groups[k + 1][0].lab[0] - groups[k][groups[k].length - 1].lab[0];
      if (gap(i) < gap(best)) best = i;
    }
    groups = [...groups.slice(0, best), [...groups[best], ...groups[best + 1]], ...groups.slice(best + 2)];
  }
  return groups;
}

// Monotone cubic (Fritsch-Carlson) through knots: never overshoots, so a skin
// point near white can't drag the rest of the channel down.
function monotoneInterpolator(knots) {
  const xs = knots.map((k) => k[0]), ys = knots.map((k) => k[1]);
  const n = knots.length;
  const d = xs.slice(1).map((x, i) => (ys[i + 1] - ys[i]) / (x - xs[i]));
  const m = xs.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const h00 = (1 + 2 * t) * (1 - t) ** 2, h10 = t * (1 - t) ** 2, h01 = t * t * (3 - 2 * t), h11 = t * t * (t - 1);
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}

// Knots for one channel: the skin points plus black/white ends. An end stays
// pinned at 0/255 unless that would make the segment steeper than MAX_END_SLOPE;
// then the end moves instead (e.g. a bright skin point pulled down shifts the
// white end slightly rather than bending the whole channel).
function channelKnots(points) {
  const [x0, y0] = points[0], [x1, y1] = points[points.length - 1];
  const black = y0 / x0 > MAX_END_SLOPE ? y0 - MAX_END_SLOPE * x0 : 0;
  const white = (255 - y1) / (255 - x1) > MAX_END_SLOPE ? y1 + MAX_END_SLOPE * (255 - x1) : 255;
  return [[0, black], ...points, [255, white]];
}

// The curve is built as a shift (output - input) interpolated without
// overshoot, so no tone moves further than the skin points or the ends do.
// Photoshop interpolates Curves with its own spline, so we hand it the anchor
// points plus a grid sampled from that curve to pin its shape.
function curvesFromAnchors(anchors) {
  const curves = {};
  for (const [c, name] of CHANNELS.entries()) {
    const points = anchors.map((g) => [g.inputRgb[c], g.targetRgb[c]]);
    const shift = monotoneInterpolator(channelKnots(points).map(([x, y]) => [x, y - x]));
    const f = [];
    for (let x = 0; x <= 255; x++) f[x] = Math.min(255, Math.max(0, x + shift(x), x ? f[x - 1] : 0)); // never falls
    const at = (x) => f[Math.round(x)];
    const xs = GRID.filter((x) => x === 0 || x === 255 || points.every(([px]) => Math.abs(px - x) >= MIN_POINT_SPACING));
    const all = [...xs, ...points.map(([px]) => px)].sort((a, b) => a - b);
    curves[name] = all.map((x) => [Math.round(x), Math.round(at(x))]);
  }
  return curves;
}

// Anchors (sorted by lightness) must sit in the same order on every channel
// (1-D curves can't map one input to two outputs) and the curve must not fall.
function anchorsAreOrdered(anchors, minSpacing = MIN_POINT_SPACING, maxSlope = Infinity) {
  return [0, 1, 2].every((c) => anchors.every((g, i) => {
    if (i === 0) return true;
    const dx = g.inputRgb[c] - anchors[i - 1].inputRgb[c];
    const dy = g.targetRgb[c] - anchors[i - 1].targetRgb[c];
    return dx >= minSpacing && dy >= 0 && dy / dx <= maxSlope;
  }));
}

const byLightness = (p, q) => p.inputLab[0] - q.inputLab[0];

function buildNeutral(rgb, space) {
  const inputLab = rgbToLab(rgb, space);
  const { rgb: targetRgb } = labToRgb([inputLab[0], 0, 0], space);
  return { neutral: true, inputRgb: rgb, inputLab, targetLab: [inputLab[0], 0, 0], targetRgb };
}

function buildGroup(members, space, preset, strength) {
  const inputRgb = mean(members.map((s) => s.rgb));
  const inputLab = rgbToLab(inputRgb, space);
  const presetLab = targetLab(preset, inputLab);
  const goal = [inputLab[0], ...[1, 2].map((i) => inputLab[i] + (presetLab[i] - inputLab[i]) * strength)];
  const { rgb: targetRgb, inGamut } = labToRgb(goal, space);
  return {
    size: members.length, inputRgb, inputLab, presetLab, targetLab: goal, targetRgb, inGamut,
    diagnosis: diagnose(inputLab, presetLab),
  };
}

/**
 * @param {object} opts
 * @param {number[][]} opts.samples  RGB triplets, 0..255, in the document's space
 * @param {string} opts.profile      document colour profile name, e.g. "Adobe RGB (1998)"
 * @param {string} opts.preset       preset key: caucasian | child | asian | dark
 * @param {number} [opts.strength=1] 0..1, how far to move toward the preset
 * @param {boolean} [opts.splitByLightness=true] allow separate highlight/mid/shadow points
 * @param {number[]} [opts.neutral] RGB of a white/grey reference to keep neutral (full strength)
 */
function solveCurves({ samples, profile, preset, strength = 1, splitByLightness = true, neutral = null }) {
  if (!samples || samples.length === 0) throw new Error('No skin samples given');
  const space = resolveSpace(profile);
  if (!space) throw new Error(`Unsupported colour profile "${profile}"`);
  const warnings = [];
  const tagged = samples.map((rgb) => ({ rgb, lab: rgbToLab(rgb, space) }));

  let memberGroups = splitByLightness ? groupByLightness(tagged) : [tagged];
  const build = (s) => memberGroups.map((m) => buildGroup(m, space, preset, s));
  let groups = build(strength);
  if (groups.length > 1 && !anchorsAreOrdered(groups)) {
    warnings.push('Samples could not be kept as separate tonal points; merged into one.');
    memberGroups = [tagged];
    groups = build(strength);
  }

  // Whites take priority: if skin and white can't both be met on a smooth
  // curve, scale the skin correction back until they can.
  let neutralRef = neutral ? buildNeutral(neutral, space) : null;
  let skinStrength = strength;
  const withNeutral = (gs) => [...gs, neutralRef].sort(byLightness);
  const fits = (gs) => anchorsAreOrdered(withNeutral(gs), NEUTRAL_MIN_SPACING, NEUTRAL_MAX_SLOPE);
  if (neutralRef && !fits(groups)) {
    if (!fits(build(0))) {
      warnings.push("White reference can't share a curve with the skin (it isn't brighter than the skin in every channel); ignored. Sample a clean, bright white.");
      neutralRef = { ...neutralRef, ignored: true };
    } else {
      let lo = 0, hi = strength;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (fits(build(mid))) lo = mid; else hi = mid;
      }
      skinStrength = lo;
      groups = build(lo);
      warnings.push(`To keep whites neutral, skin correction was reduced to ${Math.round(lo * 100)}%.`);
    }
  }
  const anchors = neutralRef && !neutralRef.ignored ? withNeutral(groups) : groups;
  const curves = curvesFromAnchors(anchors);
  const whites = CHANNELS.map((ch) => curves[ch][curves[ch].length - 1][1]);
  if ((!neutralRef || neutralRef.ignored) && Math.max(...whites) - Math.min(...whites) > 6) {
    warnings.push(`Skin is close to white; whites shift to ${whites.join('/')}. Lower the layer opacity or mask the layer to protect them.`);
  }
  if (groups.some((g) => !g.inGamut)) warnings.push('Target colour is outside the document gamut and was clipped.');
  const spread = Math.max(...tagged.map((s) => deltaE(s.lab, groups[0].inputLab)));
  if (groups.length === 1 && spread > 20) warnings.push('Samples vary a lot; check that they are all skin.');

  return { space: space.name, preset, strength, skinStrength, groups, neutral: neutralRef, curves, warnings };
}

// Natural cubic spline through the points, clamped to 0..255 - close to how
// Photoshop's Curves interpolates. Used to preview the effect on samples.
function evalCurve(points, x) {
  const n = points.length;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  if (n === 2) return Math.min(255, Math.max(0, ys[0] + ((ys[1] - ys[0]) * (x - xs[0])) / (xs[1] - xs[0])));
  const h = xs.slice(1).map((v, i) => v - xs[i]);
  const alpha = [0];
  for (let i = 1; i < n - 1; i++) alpha.push((3 / h[i]) * (ys[i + 1] - ys[i]) - (3 / h[i - 1]) * (ys[i] - ys[i - 1]));
  const l = [1], mu = [0], z = [0];
  for (let i = 1; i < n - 1; i++) {
    l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
    mu[i] = h[i] / l[i];
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
  }
  const c = new Array(n).fill(0), b = [], d = [];
  for (let j = n - 2; j >= 0; j--) {
    c[j] = j === 0 ? 0 : z[j] - mu[j] * c[j + 1];
    b[j] = (ys[j + 1] - ys[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }
  let j = 0;
  while (j < n - 2 && x > xs[j + 1]) j++;
  const dx = x - xs[j];
  return Math.min(255, Math.max(0, ys[j] + b[j] * dx + c[j] * dx * dx + d[j] * dx * dx * dx));
}

function applyCurves(curves, rgb) {
  return CHANNELS.map((name, i) => evalCurve(curves[name], rgb[i]));
}

module.exports = { solveCurves, evalCurve, applyCurves, CHANNELS };
