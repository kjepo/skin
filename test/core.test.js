'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../plugin/core');
const book = require('./fixtures/book.json');
const lcms = require('./fixtures/colorspaces.json');

const ADOBE = 'Adobe RGB (1998)';
const adobe = core.SPACES[ADOBE];

test('RGB -> Lab matches LittleCMS for every supported space', () => {
  for (const [name, rows] of Object.entries(lcms)) {
    for (const [rgb, lab] of rows) {
      const d = core.deltaE(core.rgbToLab(rgb, core.SPACES[name]), lab);
      assert.ok(d < 0.1, `${name} ${rgb}: dE ${d.toFixed(3)}`);
    }
  }
});

test('Lab -> RGB round-trips', () => {
  for (const space of Object.values(core.SPACES)) {
    for (const rgb of [[10, 20, 30], [185, 152, 125], [250, 240, 230], [128, 128, 128]]) {
      const back = core.labToRgb(core.rgbToLab(rgb, space), space);
      assert.ok(back.inGamut);
      back.rgb.forEach((v, i) => assert.ok(Math.abs(v - rgb[i]) < 1e-6, `${space.name} ${rgb}`));
    }
  }
});

test('Photoshop profile names resolve', () => {
  assert.equal(core.resolveSpace('sRGB IEC61966-2.1').name, 'sRGB');
  assert.equal(core.resolveSpace('Adobe RGB (1998)').name, ADOBE);
  assert.equal(core.resolveSpace('Display P3').name, 'Display P3');
  assert.equal(core.resolveSpace('ProPhoto RGB').name, 'ProPhoto RGB');
  assert.equal(core.resolveSpace('Some Camera Profile'), null);
});

test("preset targets sit close to the book's good samples", () => {
  for (const f of book.filter((f) => f.good)) {
    const d = core.deltaE(core.targetLab(f.preset, f.lab), f.lab);
    assert.ok(d < 3.5, `${f.name}: dE ${d.toFixed(2)}`);
    assert.deepEqual(core.diagnose(f.lab, core.targetLab(f.preset, f.lab)).notes, ['ok'], f.name);
  }
});

test("the book's bad samples are far from target and diagnosed as the book describes", () => {
  const expect = { 'too yellow': /too yellow/, 'too red': /too red/ };
  for (const f of book.filter((f) => !f.good)) {
    const target = core.targetLab(f.preset, f.lab);
    assert.ok(core.deltaE(target, f.lab) > 10, f.name);
    const notes = core.diagnose(f.lab, target).notes.join(',');
    const want = f.name.includes('too yellow') ? expect['too yellow'] : expect['too red'];
    assert.match(notes, want, `${f.name}: ${notes}`);
  }
});

test('targets keep the sample lightness and respect the chroma cap', () => {
  for (const { key, maxChroma } of core.PRESETS) {
    for (let L = 20; L <= 95; L += 5) {
      const t = core.targetLab(key, [L, 40, 60]);
      assert.equal(t[0], L);
      assert.ok(core.chroma(t) <= maxChroma + 1e-9, `${key} L${L}`);
    }
  }
});

test('solved curves move each bad book sample onto its target', () => {
  for (const f of book.filter((f) => !f.good)) {
    const r = core.solveCurves({ samples: [f.adobeRgb], profile: ADOBE, preset: f.preset });
    const after = core.rgbToLab(core.applyCurves(r.curves, f.adobeRgb), adobe);
    const d = core.deltaE(after, r.groups[0].presetLab);
    assert.ok(d < 1, `${f.name}: dE after ${d.toFixed(2)}`);
    assert.ok(Math.abs(after[0] - f.lab[0]) < 1, 'lightness preserved');
  }
});

test('strength 0 leaves curves at identity; 0.5 lands half way', () => {
  const rgb = book.find((f) => f.name.includes('baby')).adobeRgb;
  const zero = core.solveCurves({ samples: [rgb], profile: ADOBE, preset: 'child', strength: 0 });
  for (const pts of Object.values(zero.curves)) for (const [x, y] of pts) assert.ok(Math.abs(x - y) <= 1);
  const half = core.solveCurves({ samples: [rgb], profile: ADOBE, preset: 'child', strength: 0.5 });
  const g = half.groups[0];
  const mid = [1, 2].map((i) => (g.inputLab[i] + g.presetLab[i]) / 2);
  assert.ok(Math.hypot(g.targetLab[1] - mid[0], g.targetLab[2] - mid[1]) < 1e-9);
});

test('several samples at similar lightness are averaged into one point', () => {
  const samples = [[200, 150, 120], [205, 156, 124], [196, 147, 118]];
  const r = core.solveCurves({ samples, profile: ADOBE, preset: 'caucasian' });
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].size, 3);
  const x = Math.round(r.groups[0].inputRgb[0]);
  assert.ok(r.curves.red.some(([px]) => px === x), 'skin point is on the red curve');
});

test('highlight and shadow samples get separate monotonic curve points', () => {
  const samples = [[235, 196, 160], [232, 192, 158], [140, 105, 80], [136, 102, 78]];
  const r = core.solveCurves({ samples, profile: ADOBE, preset: 'caucasian' });
  assert.equal(r.groups.length, 2);
  for (const pts of Object.values(r.curves)) {
    for (let i = 1; i < pts.length; i++) {
      assert.ok(pts[i][0] > pts[i - 1][0]);
      assert.ok(pts[i][1] >= pts[i - 1][1]);
    }
  }
  const single = core.solveCurves({ samples, profile: ADOBE, preset: 'caucasian', splitByLightness: false });
  assert.equal(single.groups.length, 1);
});

test('evalCurve passes through its points and is identity for the default curve', () => {
  const pts = [[0, 0], [90, 70], [180, 200], [255, 255]];
  for (const [x, y] of pts) assert.ok(Math.abs(core.evalCurve(pts, x) - y) < 1e-9);
  for (const x of [0, 33, 128, 255]) assert.equal(core.evalCurve([[0, 0], [255, 255]], x), x);
});

test('bad input is rejected', () => {
  assert.throws(() => core.solveCurves({ samples: [], profile: ADOBE, preset: 'caucasian' }), /No skin samples/);
  assert.throws(() => core.solveCurves({ samples: [[1, 2, 3]], profile: 'Foo', preset: 'caucasian' }), /Unsupported/);
  assert.throws(() => core.solveCurves({ samples: [[1, 2, 3]], profile: ADOBE, preset: 'old' }), /Unknown skin preset/);
});

// Regression: bright, warm skin (red ~244) used to put a curve point 11 levels
// below the pinned 255 end; Photoshop's spline then crushed red mid-tones
// (128 -> 47) and the whole image went cyan.
test('skin near white does not bend the rest of the channel', () => {
  const samples = [[252, 191, 144], [232, 177, 157], [249, 184, 142]];
  for (const profile of ['sRGB IEC61966-2.1', ADOBE]) {
    const r = core.solveCurves({ samples, profile, preset: 'caucasian' });
    const g = r.groups[0];
    for (const [c, ch] of core.CHANNELS.entries()) {
      const pts = r.curves[ch];
      const shift = Math.abs(g.targetRgb[c] - g.inputRgb[c]);
      let prev = -1;
      for (let x = 0; x <= 255; x++) {
        const y = core.evalCurve(pts, x);
        assert.ok(y >= prev - 0.5, `${profile} ${ch} falls at ${x}`);
        assert.ok(Math.abs(y - x) <= shift + 3, `${profile} ${ch}(${x}) = ${y.toFixed(1)}, skin shift only ${shift.toFixed(1)}`);
        prev = y;
      }
    }
    assert.match(r.warnings.join(' '), /whites shift/);
  }
});
