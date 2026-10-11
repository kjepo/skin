'use strict';
// RGB working spaces <-> CIE Lab (D50), matching ICC matrix/TRC profiles as
// Photoshop uses them. RGB values are 0..255 floats throughout.

const D50 = [0.9642, 1.0, 0.8249];

const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

function mul(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function matmul(a, b) {
  return a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
}

function invert(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];

// RGB -> XYZ(D50) matrix from chromaticities, Bradford-adapted like ICC profiles.
function rgbToXYZMatrix(primaries, whiteXY) {
  const cols = primaries.map(xyToXYZ);
  const P = [0, 1, 2].map((r) => cols.map((c) => c[r]));
  const W = xyToXYZ(whiteXY);
  const S = mul(invert(P), W);
  const M = P.map((row) => row.map((v, j) => v * S[j]));
  const src = mul(BRADFORD, W);
  const dst = mul(BRADFORD, D50);
  const scale = [[dst[0] / src[0], 0, 0], [0, dst[1] / src[1], 0], [0, 0, dst[2] / src[2]]];
  const adapt = matmul(invert(BRADFORD), matmul(scale, BRADFORD));
  return matmul(adapt, M);
}

const srgbTRC = {
  decode: (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)),
  encode: (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055),
};

const gammaTRC = (g) => ({
  decode: (v) => Math.sign(v) * Math.pow(Math.abs(v), g),
  encode: (v) => Math.sign(v) * Math.pow(Math.abs(v), 1 / g),
});

const D65_XY = [0.3127, 0.329];
const D50_XY = [0.3457, 0.3585];

function makeSpace(name, primaries, whiteXY, trc) {
  const toXYZ = rgbToXYZMatrix(primaries, whiteXY);
  return { name, toXYZ, fromXYZ: invert(toXYZ), trc };
}

const SPACES = {
  sRGB: makeSpace('sRGB', [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], D65_XY, srgbTRC),
  'Adobe RGB (1998)': makeSpace('Adobe RGB (1998)', [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], D65_XY, gammaTRC(563 / 256)),
  'Display P3': makeSpace('Display P3', [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], D65_XY, srgbTRC),
  'ProPhoto RGB': makeSpace('ProPhoto RGB', [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]], D50_XY, gammaTRC(1.8)),
};

// Map a Photoshop profile name ("sRGB IEC61966-2.1", "Adobe RGB (1998)", ...) to a space.
function resolveSpace(profileName) {
  const n = (profileName || '').toLowerCase();
  if (n.includes('adobe rgb')) return SPACES['Adobe RGB (1998)'];
  if (n.includes('prophoto') || n.includes('romm')) return SPACES['ProPhoto RGB'];
  if (n.includes('p3')) return SPACES['Display P3'];
  if (n.includes('srgb')) return SPACES.sRGB;
  return null;
}

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;
const f = (t) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const finv = (t) => (t * t * t > EPS ? t * t * t : (116 * t - 16) / KAPPA);

function xyzToLab([X, Y, Z]) {
  const fx = f(X / D50[0]), fy = f(Y / D50[1]), fz = f(Z / D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labToXYZ([L, a, b]) {
  const fy = (L + 16) / 116;
  return [finv(fy + a / 500) * D50[0], finv(fy) * D50[1], finv(fy - b / 200) * D50[2]];
}

function rgbToLab(rgb, space) {
  const lin = rgb.map((v) => space.trc.decode(v / 255));
  return xyzToLab(mul(space.toXYZ, lin));
}

// Returns { rgb: clamped 0..255 floats, inGamut }.
function labToRgb(lab, space) {
  const lin = mul(space.fromXYZ, labToXYZ(lab));
  const inGamut = lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  const rgb = lin.map((v) => Math.min(255, Math.max(0, 255 * space.trc.encode(Math.min(1, Math.max(0, v))))));
  return { rgb, inGamut };
}

const chroma = ([, a, b]) => Math.hypot(a, b);
const hue = ([, a, b]) => (Math.atan2(b, a) * 180) / Math.PI;
const deltaE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

module.exports = { SPACES, resolveSpace, rgbToLab, labToRgb, xyzToLab, labToXYZ, chroma, hue, deltaE };
