import './style.css';
import { Publication } from './publication';
import { MODULAR_MODELS, modularAsset } from '../../shared/modular';
import { NeighborhoodScene } from './scene';
import { BLOCKS, PLAN_VERSION, SIZE, blockFor, footprint, generatePlan, History, parsePlan, placementError, type Placement, type QuarterTurn, type Recipe } from './plan';

const element = <T extends HTMLElement>(id: string) => {
  const node = document.getElementById(id); if (!node) throw new Error(`Missing workshop element: ${id}`); return node as T;
};
const button = (id: string) => element<HTMLButtonElement>(id);
const input = (id: string) => element<HTMLInputElement>(id);
const select = (id: string) => element<HTMLSelectElement>(id);
const STORAGE = 'agentsearth:neighborhood-draft:v1';
let startupNotice = '';
let initial = generatePlan('earth-001', 'village');
try { const saved = localStorage.getItem(STORAGE); if (saved) initial = parsePlan(JSON.parse(saved)); }
catch { startupNotice = 'The saved draft could not be opened. A starter draft is shown; export it if device storage is unavailable.'; }
const history = new History(initial);
const publication = new Publication(() => history.current);
let selectedId: string | null = null;
let activeAsset: string | null = null;
let moveId: string | null = null;
let draftId = '';
let scene: NeighborhoodScene;
let sceneReady = false;
let pendingThumbnail = 0;
let previewKey = '';
let unsaved = false;
let sceneUpdate = 0;
const thumbnails = new Map<string, string>();
function message(text: string, error = false) {
  element('message').textContent = text;
  element('message').style.color = error ? 'var(--color-destructive)' : '';
}
function candidate(): Placement | null {
  if (!activeAsset) return null;
  return { id: moveId ?? draftId, assetId: activeAsset, x: input('tile-x').valueAsNumber, y: input('tile-y').valueAsNumber, rotation: Number(select('rotation').value) as QuarterTurn };
}
function setTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  for (const name of ['build', 'grow', 'agent']) element(`${name}-panel`).hidden = name !== tab;
}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab!)));
function save() {
  try { localStorage.setItem(STORAGE, JSON.stringify(history.current)); unsaved = false; element('save-state').textContent = 'Saved on this device'; return true; }
  catch { unsaved = true; element('save-state').textContent = 'Not saved'; message('Device storage is unavailable or full. Export draft JSON to keep your work.', true); return false; }
}
button('save').addEventListener('click', () => { if (save()) message('Draft saved on this device. Shared Earth is unchanged.'); });
function stopPlacement() {
  activeAsset = null; moveId = null; previewKey = ''; button('cancel').hidden = true;
  void scene?.preview(null); updatePlacement();
  document.querySelectorAll('.block').forEach(b => b.setAttribute('aria-pressed', 'false'));
}
function updatePlacement() {
  const p = candidate(); const error = p ? placementError(p, history.current.objects) : null;
  button('place').disabled = !p || !!error || !sceneReady || (!moveId && history.current.objects.length >= 200);
  button('place').textContent = moveId ? 'Apply move' : 'Place block';
  element('placement-title').textContent = moveId ? 'Move selected block' : 'Place a block';
  element('block-info').textContent = p ? `${blockFor(p.assetId).label} · ${footprint(p).w} × ${footprint(p).h} tiles` : 'Choose from the collection above.';
  element('placement-error').textContent = error ?? (history.current.objects.length >= 200 && !moveId ? 'This draft has reached its 200-block limit.' : '');
  for (const id of ['tile-x', 'tile-y', 'rotation']) element(id).setAttribute('aria-invalid', String(!!error));
  element('scene-help').textContent = p ? 'Click ground to choose a site · Place block to confirm' : 'Drag to pan · scroll to zoom · click a block to inspect';
  const key = JSON.stringify(p) + error;
  if (scene && sceneReady && previewKey !== key) { previewKey = key; void scene.preview(p, !error).catch(() => message('This block preview could not load. Choose another block or reload.', true)); }
}
function updateInspector() {
  const p = history.current.objects.find(o => o.id === selectedId) ?? null;
  element('inspector').hidden = !p;
  if (p) { element('inspector-title').textContent = blockFor(p.assetId).label; element('selected-info').textContent = `Tile ${p.x}, ${p.y} · ${p.rotation * 90}° · ${p.id}`; }
  scene?.select(p);
}
function inspect(id: string) {
  stopPlacement(); selectedId = id; setTab('build'); updateInspector();
  element('inspector').scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
function updateUI() {
  publication.updateDraft();
  element('plan-name').textContent = history.current.name;
  input('seed').value = history.current.seed;
  button('undo').disabled = !history.canUndo; button('redo').disabled = !history.canRedo;
  element('object-count').textContent = `(${history.current.objects.length})`;
  const list = element('objects'); list.replaceChildren();
  for (const p of history.current.objects) {
    const b = document.createElement('button'); b.textContent = `${blockFor(p.assetId).label} · ${p.x}, ${p.y}`;
    b.addEventListener('click', () => inspect(p.id)); list.append(b);
  }
  updateInspector(); updatePlacement();
}
async function refreshScene() {
  const revision = ++sceneUpdate;
  sceneReady = false; updatePlacement();
  const loading = element('loading'); loading.hidden = false;
  loading.replaceChildren(); const title = document.createElement('strong'); title.textContent = 'Preparing the neighborhood'; loading.append(title);
  try { await scene.setPlan(history.current); if (revision !== sceneUpdate) return; sceneReady = true; loading.hidden = true; previewKey = ''; updateInspector(); updatePlacement(); }
  catch {
    if (revision !== sceneUpdate) return;
    loading.replaceChildren(); const p = document.createElement('p'); p.textContent = 'Some models could not load. Your draft is still available.';
    const retry = document.createElement('button'); retry.textContent = 'Reload models'; retry.addEventListener('click', () => location.reload()); loading.append(p, retry);
    message('The neighborhood could not render. Save or export your draft, then reload.', true);
  }
}
function commit(objects: Placement[], text: string) {
  history.commit({ ...history.current, objects }); unsaved = true; stopPlacement(); selectedId = null; updateUI();
  const saved = save(); void refreshScene(); if (saved) message(text);
}
async function renderCatalogue() {
  const revision = ++pendingThumbnail; const category = select('category').value;
  const list = element('catalogue'); list.replaceChildren();
  const visible = BLOCKS.filter(b => b.category === category);
  for (const block of visible) {
    const b = document.createElement('button'); b.className = 'block'; b.setAttribute('aria-pressed', String(activeAsset === block.asset.id));
    const slot = document.createElement('span'); slot.className = 'image-slot'; slot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.textContent = block.label; b.append(slot, label); list.append(b);
    b.addEventListener('click', () => {
      selectedId = null; updateInspector(); activeAsset = block.asset.id; moveId = null;
      draftId = `draft:${crypto.randomUUID()}`; button('cancel').hidden = false;
      list.querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed', String(other === b)));
      updatePlacement(); message(`Choose a site for ${block.label.toLowerCase()}, then press Place block.`);
    });
    void (async () => {
      try {
        const url = thumbnails.get(block.asset.id) ?? await scene.thumbnail(block.asset.id); thumbnails.set(block.asset.id, url);
        if (revision !== pendingThumbnail) return;
        const img = document.createElement('img'); img.src = url; img.alt = ''; img.width = 160; img.height = 120; slot.replaceWith(img);
      } catch { slot.textContent = 'Preview unavailable'; }
    })();
  }
}
select('category').addEventListener('change', () => void renderCatalogue());
for (const id of ['tile-x', 'tile-y', 'rotation']) element(id).addEventListener('input', updatePlacement);
button('cancel').addEventListener('click', stopPlacement);
button('place').addEventListener('click', () => {
  const p = candidate(); if (!p) return;
  const error = placementError(p, history.current.objects); if (error) { message(error, true); return; }
  if (!moveId && history.current.objects.length >= 200) return;
  commit([...history.current.objects.filter(o => o.id !== p.id), p], `${blockFor(p.assetId).label} ${moveId ? 'moved' : 'placed'} in your draft. Undo reverses it.`);
});
button('move').addEventListener('click', () => {
  const p = history.current.objects.find(o => o.id === selectedId); if (!p) return;
  activeAsset = p.assetId; moveId = p.id; input('tile-x').value = String(p.x); input('tile-y').value = String(p.y); select('rotation').value = String(p.rotation);
  button('cancel').hidden = false; updatePlacement(); element('placement-title').scrollIntoView({ block: 'nearest', behavior: 'instant' });
});
button('remove').addEventListener('click', () => {
  if (selectedId) commit(history.current.objects.filter(o => o.id !== selectedId), 'Block removed from your draft. Undo restores it.');
});
function travelHistory(action: 'undo' | 'redo') {
  history[action](); stopPlacement(); selectedId = null; updateUI(); const saved = save(); void refreshScene(); if (saved) message(`${action === 'undo' ? 'Previous' : 'Next'} draft restored.`);
}
button('undo').addEventListener('click', () => travelHistory('undo')); button('redo').addEventListener('click', () => travelHistory('redo'));
button('generate').addEventListener('click', () => {
  const seed = input('seed').value.trim();
  element('seed-error').textContent = seed ? '' : 'Enter a world seed before generating a draft.';
  input('seed').setAttribute('aria-invalid', String(!seed));
  if (!seed) { message('Enter a world seed before generating a draft.', true); input('seed').focus(); return; }
  history.commit(generatePlan(seed, select('recipe').value as Recipe)); stopPlacement(); selectedId = null; updateUI(); const saved = save(); void refreshScene();
  if (saved) message('Neighborhood generated from your seed. Undo restores the previous draft.');
});
button('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(history.current, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'agentsearth-neighborhood-draft.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  message('Draft JSON exported. This file does not publish changes to Earth.');
});
input('import-plan').addEventListener('change', async () => {
  const file = input('import-plan').files?.[0]; if (!file) return;
  element('import-error').textContent = ''; input('import-plan').setAttribute('aria-invalid', 'false');
  try {
    if (file.size > 500_000) throw new Error('This file is too large. Choose a plan under 500 KB.');
    const next = parsePlan(JSON.parse(await file.text())); history.commit(next); stopPlacement(); selectedId = null; updateUI(); const saved = save(); void refreshScene();
    if (saved) message('Agent plan validated and imported as a local draft. Undo restores your previous layout.');
  } catch (error) {
    const text = `Import rejected: ${error instanceof Error ? error.message : 'Invalid JSON plan.'}`;
    element('import-error').textContent = text; input('import-plan').setAttribute('aria-invalid', 'true'); message(text, true);
  }
  finally { input('import-plan').value = ''; }
});
button('copy-prompt').addEventListener('click', async () => {
  const brief = element<HTMLTextAreaElement>('brief').value.trim();
  const instructions = `Design a LOCAL AgentsEarth neighborhood draft. Brief: ${brief}\nReturn only a JSON object, no code fences. No owner names, credentials, private details, URLs, scripts, geometry, or claims of live actions.\nSchema: {"version":"${PLAN_VERSION}","name":"short plan name","seed":"${history.current.seed}","objects":[{"id":"draft:1","assetId":"home-a","x":2,"y":2,"rotation":0}]}\nRules: 32x32 tiles. Integer coordinates >=0; rotated footprints must fit inside. Rotation 0,1,2,3 (quarter turns); odd rotations swap width/height. IDs unique. At most 200 blocks. No overlap. Roads reserve ALL tiles whose x is 14..17 OR y is 14..17. Leave roads clear. These are draft catalogue labels, not claims of live venue functions.\nApproved blocks:\n${JSON.stringify(BLOCKS.map(b => ({ assetId: b.asset.id, label: b.label, width: b.w, height: b.h })))}\nCurrent draft for context:\n${JSON.stringify(history.current)}\nYour output will be validated and previewed. It grants no permissions and does not publish to the shared Earth.`;
  const liveGuide = `\nFor a SEPARATE owner-authorized live build, use the existing signed Earth CLI, inspect your own plot first, and obey Kernel consent. Never publish this entire neighborhood as one citizen. Example: Earth construct home X Y --asset-id home_courtyard --model-id home-a. X,Y are absolute owned-plot tiles, not draft coordinates; canonical south entrance and footprint replace draft rotation. A permit costs 200 Earth Tokens. Approved live mappings:\n${JSON.stringify(Object.keys(MODULAR_MODELS).map(modelId => { const { semanticId, asset } = modularAsset(modelId); return { modelId, assetId: semanticId, kind: asset.kind, footprint: asset.footprint }; }))}`;
  const prompt = instructions + liveGuide;
  try { await navigator.clipboard.writeText(prompt); message('Agent instructions copied. Paste them into your own AI session.'); }
  catch {
    let output = document.getElementById('prompt-output') as HTMLTextAreaElement | null;
    if (!output) { const label = document.createElement('label'); label.htmlFor = 'prompt-output'; label.textContent = 'Agent instructions · select and copy'; output = document.createElement('textarea'); output.id = 'prompt-output'; output.rows = 8; output.readOnly = true; element('agent-panel').append(label, output); }
    output.value = prompt; output.focus(); output.select(); message('Clipboard access was unavailable. Select and copy the instructions shown below.', true);
  }
});
for (const id of ['grid', 'people']) button(id).addEventListener('click', () => {
  const show = button(id).getAttribute('aria-pressed') !== 'true'; button(id).setAttribute('aria-pressed', String(show));
  if (id === 'grid') scene.toggleGrid(show); else scene.togglePeople(show);
  message(id === 'people' ? (show ? 'Sample people shown for scale. They are not live citizens.' : 'Sample people hidden.') : (show ? 'Tile grid shown.' : 'Tile grid hidden.'));
});
button('zoom-in').addEventListener('click', () => scene.zoom(1.2)); button('zoom-out').addEventListener('click', () => scene.zoom(1 / 1.2)); button('reset-view').addEventListener('click', () => scene.resetView());
document.addEventListener('keydown', e => {
  if ((e.target as HTMLElement).matches('input, textarea, select')) return;
  if (e.key === 'Escape') { stopPlacement(); selectedId = null; updateInspector(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); travelHistory(e.shiftKey ? 'redo' : 'undo'); }
});
window.addEventListener('beforeunload', e => { if (unsaved) { e.preventDefault(); e.returnValue = ''; } });
try {
  scene = new NeighborhoodScene(element('scene'));
  scene.onStats = calls => { element('render-info').textContent = `${calls} draw calls`; };
  scene.onPick = (id, x, y) => {
    if (activeAsset) { input('tile-x').value = String(x); input('tile-y').value = String(y); updatePlacement(); }
    else if (id) inspect(id); else { selectedId = null; updateInspector(); }
  };
  scene.onHover = (x, y) => {
    if (!activeAsset || x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    if (input('tile-x').value === String(x) && input('tile-y').value === String(y)) return;
    input('tile-x').value = String(x); input('tile-y').value = String(y); updatePlacement();
  };
  element('scene').addEventListener('scene-error', e => message((e as CustomEvent<string>).detail, true));
  updateUI(); void refreshScene(); void renderCatalogue();
  void scene.loadPeople().catch(() => message('Some sample people could not load. Buildings and editing remain available.', true));
  element('save-state').textContent = 'Local draft · autosaved on edit';
  if (startupNotice) message(startupNotice, true);
} catch {
  element('loading').replaceChildren(); const p = document.createElement('p'); p.textContent = 'This browser could not start WebGL. Enable graphics acceleration or try another browser. Your saved draft is unchanged.'; element('loading').append(p);
  message('The 3D preview could not start on this device.', true);
  document.querySelectorAll<HTMLButtonElement>('button').forEach(b => { if (b.id !== 'save' && !b.dataset.tab) b.disabled = true; });
}
