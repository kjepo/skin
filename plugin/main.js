'use strict';
// Skin Tone Curves - UXP panel. Reads the document's Color Samplers, solves
// RGB curves toward the chosen preset (see core/), and writes them as a
// Curves adjustment layer.

const { app, core: psCore, action, constants, imaging } = require('photoshop');
const { entrypoints } = require('uxp');
const skin = require('./core/index.js');

const LAYER_PREFIX = 'Skin Tone – ';
// Samplers are read as the average of an 11 x 11 pixel square, like the
// Info panel with Sample Size "11 by 11 Average". Scripted sampler colours are
// always single pixels whatever the tool setting, so the plugin averages itself.
const SAMPLE_RADIUS = 5;
const EYEDROPPER_11X11 = 5; // eyeDropperSample value: the radius (0 = point sample)

const $ = (id) => document.getElementById(id);

let selectedPreset = skin.PRESETS[0].key;

function selectPreset(key) {
  selectedPreset = key;
  for (const tile of $('presets').children) {
    tile.className = tile.getAttribute('data-key') === key ? 'preset selected' : 'preset';
  }
}

function init() {
  for (const p of skin.PRESETS) {
    const tile = document.createElement('div');
    tile.className = 'preset';
    tile.setAttribute('data-key', p.key);
    tile.title = `${p.label} skin preset`;
    tile.innerHTML = `<img src="icons/preset-${p.key}.png" alt="" width="48" height="48"><span>${p.label}</span>`;
    tile.addEventListener('click', () => selectPreset(p.key));
    $('presets').appendChild(tile);
  }
  selectPreset(selectedPreset);
  $('sampler').addEventListener('click', selectSamplerTool);
  $('detailsToggle').addEventListener('click', () => {
    detailsOpen = !detailsOpen;
    updateDetailsToggle();
  });
  $('analyze').addEventListener('click', () => run(analyze));
  $('apply').addEventListener('click', () => run(apply));
}

function options() {
  return {
    preset: selectedPreset,
    splitByLightness: $('split').checked,
    keepWhitesNeutral: $('neutral').checked,
    replace: $('replace').checked,
  };
}

// Results describe one document at one moment; drop them when the panel is
// reopened or the user moves to another document.
function clearResults() {
  setStatus('');
  $('samples').innerHTML = '';
  $('details').style.display = 'none';
}

// Per-sampler numbers fold out under a "Details" line; the choice sticks.
let detailsOpen = false;

function updateDetailsToggle() {
  const n = $('samples').children.length;
  $('detailsToggle').textContent = `${detailsOpen ? '▾' : '▸'} Details (${n} sampler${n === 1 ? '' : 's'})`;
  $('samples').style.display = detailsOpen ? 'block' : 'none';
}

// Color Sampler is the Eyedropper variant that drops a sampler on each click.
async function selectSamplerTool() {
  try {
    await psCore.executeAsModal(
      () => action.batchPlay([
        { _obj: 'select', _target: [{ _ref: 'colorSamplerTool' }] },
        {
          _obj: 'set',
          _target: [{ _ref: 'colorSamplerTool' }],
          to: { _obj: 'currentToolOptions', eyeDropperSample: EYEDROPPER_11X11 },
        },
      ], {}),
      { commandName: 'Select Color Sampler Tool' },
    );
  } catch (e) {
    console.warn('Could not select the Color Sampler tool', e);
  }
}

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.className = isError ? 'error' : '';
}

async function run(fn) {
  try {
    setStatus('');
    await fn(options());
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  }
}

function activeRgbDocument() {
  const doc = app.activeDocument;
  if (!doc) throw new Error('Open an image first.');
  if (doc.mode !== constants.DocumentMode.RGB) throw new Error('The document must be in RGB mode.');
  if (!skin.resolveSpace(doc.colorProfileName)) {
    throw new Error(`Unsupported profile "${doc.colorProfileName}". Convert to sRGB, Adobe RGB, Display P3 or ProPhoto RGB.`);
  }
  return doc;
}

// Mean RGB (0-255) of the square around a sampler, from the visible composite.
async function averageAround(doc, position) {
  const x = Math.floor(position.x), y = Math.floor(position.y);
  const { imageData } = await imaging.getPixels({
    documentID: doc.id,
    sourceBounds: {
      left: Math.max(0, x - SAMPLE_RADIUS),
      top: Math.max(0, y - SAMPLE_RADIUS),
      right: Math.min(doc.width, x + SAMPLE_RADIUS + 1),
      bottom: Math.min(doc.height, y + SAMPLE_RADIUS + 1),
    },
    componentSize: 8,
  });
  try {
    const data = await imageData.getData();
    const n = imageData.width * imageData.height, step = imageData.components;
    const sum = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sum[c] += data[i * step + c];
    return sum.map((v) => v / n);
  } finally {
    imageData.dispose();
  }
}

// Must run inside executeAsModal (getPixels requires it).
async function readSamplers(doc) {
  const samplers = doc.colorSamplers;
  const out = [];
  for (let i = 0; i < samplers.length; i++) {
    try {
      out.push(await averageAround(doc, samplers[i].position));
    } catch (e) {
      console.warn('Averaging failed, using the single sampled pixel', e);
      const { red, green, blue } = samplers[i].color.rgb;
      out.push([red, green, blue]);
    }
  }
  if (out.length === 0) {
    selectSamplerTool();
    throw new Error('No Color Samplers yet. The Color Sampler tool is selected: click skin to add some.');
  }
  return out;
}

// With "keep whites neutral", the last sampler is the white reference.
function splitSamples(all, opts) {
  if (!opts.keepWhitesNeutral) return { samples: all, neutral: null };
  if (all.length < 2) throw new Error('Keep whites neutral needs at least one skin sampler plus a last sampler on white.');
  return { samples: all.slice(0, -1), neutral: all[all.length - 1] };
}

// Samples the image without our previous correction on top of it. Must run
// inside executeAsModal.
async function solve(doc, opts) {
  const previous = findSkinLayers(doc.layers);
  const wasVisible = previous.map((l) => l.visible);
  previous.forEach((l) => { l.visible = false; });
  let all;
  try {
    all = await readSamplers(doc);
  } finally {
    previous.forEach((l, i) => { l.visible = wasVisible[i]; });
  }
  const { samples, neutral } = splitSamples(all, opts);
  const result = skin.solveCurves({ samples, neutral, profile: doc.colorProfileName, ...opts });
  return { samples, neutral, result, previous };
}

function findSkinLayers(layers, found = []) {
  for (const layer of layers) {
    if (layer.name.startsWith(LAYER_PREFIX)) found.push(layer);
    if (layer.layers) findSkinLayers(layer.layers, found);
  }
  return found;
}

// CMYK as Photoshop's Info panel would show it, using the user's colour settings.
function toCmyk(rgb) {
  try {
    const c = new app.SolidColor();
    c.rgb.red = rgb[0];
    c.rgb.green = rgb[1];
    c.rgb.blue = rgb[2];
    return [c.cmyk.cyan, c.cmyk.magenta, c.cmyk.yellow, c.cmyk.black].map(Math.round);
  } catch (e) {
    return null;
  }
}

const fmt = (v) => v.map((x) => Math.round(x)).join('/');

function sampleRow(title, rgb, after, space) {
  const cmyk = toCmyk(rgb), cmykAfter = toCmyk(after);
  const div = document.createElement('div');
  div.className = 'sample';
  div.innerHTML =
    `<div class="title">${title}</div>` +
    `<div class="mono">RGB ${fmt(rgb)} → ${fmt(after)}</div>` +
    (cmyk ? `<div class="mono">CMYK ${fmt(cmyk)} → ${fmt(cmykAfter)}</div>` : '') +
    `<div class="mono">Lab ${fmt(skin.rgbToLab(rgb, space))} → ${fmt(skin.rgbToLab(after, space))}</div>`;
  return div;
}

function render({ samples, neutral, result }, profile) {
  const space = skin.resolveSpace(profile);
  const box = $('samples');
  box.innerHTML = '';
  samples.forEach((rgb, i) => {
    const lab = skin.rgbToLab(rgb, space);
    const notes = skin.diagnose(lab, skin.targetLab(result.preset, lab)).notes;
    const cls = notes[0] === 'ok' ? 'good' : 'bad';
    const title = `#${i + 1} <span class="${cls}">${notes.join(', ')}</span>`;
    box.appendChild(sampleRow(title, rgb, skin.applyCurves(result.curves, rgb), space));
  });
  if (neutral) {
    const state = result.neutral && result.neutral.ignored ? 'ignored' : 'kept neutral';
    const title = `#${samples.length + 1} <span class="ref">white reference, ${state}</span>`;
    box.appendChild(sampleRow(title, neutral, skin.applyCurves(result.curves, neutral), space));
  }
  $('details').style.display = 'block';
  updateDetailsToggle();
}

async function analyze(opts) {
  const doc = activeRgbDocument();
  let solved;
  await psCore.executeAsModal(async () => { solved = await solve(doc, opts); }, { commandName: 'Analyze Skin Samplers' });
  render(solved, doc.colorProfileName);
  setStatus(['Preview of Apply (→ values are predicted).', ...solved.result.warnings].join(' '));
}

function curvesDescriptor(curves) {
  return {
    _obj: 'curves',
    presetKind: { _enum: 'presetKindType', _value: 'presetKindCustom' },
    adjustment: skin.CHANNELS.map((channel) => ({
      _obj: 'curvesAdjustment',
      channel: { _ref: 'channel', _enum: 'channel', _value: channel },
      curve: curves[channel].map(([x, y]) => ({ _obj: 'paint', horizontal: x, vertical: y })),
    })),
  };
}

async function apply(opts) {
  const doc = activeRgbDocument();
  const label = skin.PRESETS.find((p) => p.key === opts.preset).label;
  let solved;
  await psCore.executeAsModal(async () => {
    solved = await solve(doc, opts);
    if (opts.replace) solved.previous.forEach((l) => l.delete());

    await action.batchPlay([
      {
        _obj: 'make',
        _target: [{ _ref: 'adjustmentLayer' }],
        using: { _obj: 'adjustmentLayer', name: `${LAYER_PREFIX}${label}`, type: { _obj: 'curves' } },
      },
      {
        _obj: 'set',
        _target: [{ _ref: 'adjustmentLayer', _enum: 'ordinal', _value: 'targetEnum' }],
        to: curvesDescriptor(solved.result.curves),
      },
    ], {});
  }, { commandName: `Skin Tone: ${label}` });

  render(solved, doc.colorProfileName);
  setStatus([`Added "${LAYER_PREFIX}${label}".`, ...solved.result.warnings].join(' '));
}

entrypoints.setup({
  panels: {
    skinTonePanel: {
      show: clearResults,
      hide: clearResults,
    },
  },
});
action.addNotificationListener(['select', 'open', 'close', 'newDocument'], (event, descriptor) => {
  const target = descriptor && descriptor._target && descriptor._target[0];
  if (event !== 'select' || (target && target._ref === 'document')) clearResults();
});
// Photoshop doesn't tell the panel when it's closed or reopened, so clear
// instead whenever the samplers change: results must match what's on the image.
action.addNotificationListener(['make', 'delete', 'move', 'set'], (event, descriptor) => {
  if (JSON.stringify(descriptor || {}).includes('colorSampler')) clearResults();
});

init();
