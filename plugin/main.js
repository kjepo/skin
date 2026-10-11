'use strict';
// Skin Tone Curves - UXP panel. Reads the document's Color Samplers, solves
// RGB curves toward the chosen preset (see core/), and writes them as a
// Curves adjustment layer.

const { app, core: psCore, action, constants } = require('photoshop');
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
    strength: Number($('strength').value) / 100,
    splitByLightness: $('split').checked,
    replace: $('replace').checked,
  };
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

function render(samples, result, profile) {
  const space = skin.resolveSpace(profile);
  const box = $('samples');
  box.innerHTML = '';
  samples.forEach((rgb, i) => {
    const lab = skin.rgbToLab(rgb, space);
    const target = skin.targetLab(result.preset, lab);
    const notes = skin.diagnose(lab, target).notes;
    const after = skin.applyCurves(result.curves, rgb);
    const cmyk = toCmyk(rgb), cmykAfter = toCmyk(after);
    const ok = notes[0] === 'ok';
    const div = document.createElement('div');
    div.className = 'sample';
    div.innerHTML =
      `<div class="title">#${i + 1} <span class="${ok ? 'good' : 'bad'}">${notes.join(', ')}</span></div>` +
      `<div class="mono">RGB ${fmt(rgb)} → ${fmt(after)}</div>` +
      (cmyk ? `<div class="mono">CMYK ${fmt(cmyk)} → ${fmt(cmykAfter)}</div>` : '') +
      `<div class="mono">Lab ${fmt(lab)} → ${fmt(skin.rgbToLab(after, space))}</div>`;
    box.appendChild(div);
  });
}

async function analyze(opts) {
  const doc = activeRgbDocument();
  const samples = readSamplers(doc);
  const result = skin.solveCurves({ samples, profile: doc.colorProfileName, ...opts });
  render(samples, result, doc.colorProfileName);
  setStatus(['Preview of Apply (→ values are predicted).', ...result.warnings].join(' '));
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
  let result, samples;
  await psCore.executeAsModal(async () => {
    // Sample the image without our previous correction on top of it.
    const previous = findSkinLayers(doc.layers);
    const wasVisible = previous.map((l) => l.visible);
    previous.forEach((l) => { l.visible = false; });
    try {
      samples = readSamplers(doc);
      result = skin.solveCurves({ samples, profile: doc.colorProfileName, ...opts });
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
        to: curvesDescriptor(result.curves),
      },
    ], {});
  }, { commandName: `Skin Tone: ${label}` });

  render(samples, result, doc.colorProfileName);
  setStatus([`Added "${LAYER_PREFIX}${label}".`, ...result.warnings].join(' '));
}

init();
