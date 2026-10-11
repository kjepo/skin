'use strict';
// Skin Tone Curves - UXP panel. Reads the document's Color Samplers, solves
// RGB curves toward the chosen preset (see core/), and writes them as a
// Curves adjustment layer.

const { app, core: psCore, action, constants } = require('photoshop');
const { entrypoints } = require('uxp');
const skin = require('./core/index.js');

const LAYER_PREFIX = 'Skin Tone – ';

const $ = (id) => document.getElementById(id);

function init() {
  const menu = $('presetMenu');
  skin.PRESETS.forEach((p, i) => {
    const item = document.createElement('sp-menu-item');
    item.setAttribute('value', p.key);
    item.textContent = p.label;
    if (i === 0) item.setAttribute('selected', '');
    menu.appendChild(item);
  });
  $('analyze').addEventListener('click', () => run(analyze));
  $('apply').addEventListener('click', () => run(apply));
}

function options() {
  const items = [...$('presetMenu').querySelectorAll('sp-menu-item')];
  const idx = $('preset').selectedIndex;
  const preset = items[idx >= 0 ? idx : 0].getAttribute('value');
  return {
    preset,
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

function readSamplers(doc) {
  const samplers = doc.colorSamplers;
  const out = [];
  for (let i = 0; i < samplers.length; i++) {
    const { red, green, blue } = samplers[i].color.rgb;
    out.push([red, green, blue]);
  }
  if (out.length === 0) throw new Error('No Color Samplers. Shift-click skin with the Eyedropper tool to add some.');
  return out;
}

// With "keep whites neutral", the last sampler is the white reference.
function splitSamples(all, opts) {
  if (!opts.keepWhitesNeutral) return { samples: all, neutral: null };
  if (all.length < 2) throw new Error('Keep whites neutral needs at least one skin sampler plus a last sampler on white.');
  return { samples: all.slice(0, -1), neutral: all[all.length - 1] };
}

function solve(doc, opts) {
  const all = readSamplers(doc);
  const { samples, neutral } = splitSamples(all, opts);
  const result = skin.solveCurves({ samples, neutral, profile: doc.colorProfileName, ...opts });
  return { samples, neutral, result };
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
}

async function analyze(opts) {
  const doc = activeRgbDocument();
  const solved = solve(doc, opts);
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
    // Sample the image without our previous correction on top of it.
    const previous = findSkinLayers(doc.layers);
    const wasVisible = previous.map((l) => l.visible);
    previous.forEach((l) => { l.visible = false; });
    try {
      solved = solve(doc, opts);
    } finally {
      previous.forEach((l, i) => { l.visible = wasVisible[i]; });
    }
    if (opts.replace) previous.forEach((l) => l.delete());

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
    skinTonePanel: { show: clearResults, hide: clearResults },
  },
});
action.addNotificationListener(['select', 'open', 'close', 'newDocument'], (event, descriptor) => {
  const target = descriptor && descriptor._target && descriptor._target[0];
  if (event !== 'select' || (target && target._ref === 'document')) clearResults();
});

init();
