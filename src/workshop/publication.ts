import { modularAsset } from '../../shared/modular';
import type { Plan } from './plan';

type Plot = { plotId: string; x: number; y: number; w: number; h: number };
type Profile = { agentId: string; agentName: string; plot: Plot | null };
type Review = { id: string; kind: string; summary: string; detail: string };
const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string, value: string) => { node(id).textContent = value; };

export class Publication {
  private profile: Profile | null = null;
  private busy = false;
  constructor(private draft: () => Plan) {
    node('connect-earth').addEventListener('click', () => void this.connect());
    for (const id of ['publish-block', 'publish-x', 'publish-y']) node(id).addEventListener('change', () => this.preview());
    for (const id of ['publish-x', 'publish-y']) {
      node(id).addEventListener('blur', () => this.preview());
      node(id).addEventListener('input', () => {
        node<HTMLButtonElement>('propose-build').disabled = true;
        text('publish-preview', 'Finish entering the coordinates to review the live footprint.');
      });
    }
    node('propose-build').addEventListener('click', () => void this.propose());
  }
  private async request(action: string, body?: unknown) {
    const response = await fetch(`/api/workshop/${action}`, {
      credentials: 'same-origin', method: body ? 'POST' : 'GET',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12_000),
    });
    const data = await response.json().catch(() => ({ ok: false, why: 'Unreadable connection reply. Retry the connection.' }));
    if (!data.ok) throw new Error(data.why || 'Request failed. Retry the connection.');
    return data;
  }
  updateDraft() {
    const select = node<HTMLSelectElement>('publish-block'); const previous = select.value;
    select.replaceChildren();
    for (const item of this.draft().objects) {
      try {
        const { asset } = modularAsset(item.assetId);
        const option = document.createElement('option'); option.value = item.assetId;
        option.textContent = `${asset.name} · ${item.assetId} · draft ${item.x}, ${item.y}`;
        select.append(option);
      } catch { /* Landscape has no live structural permit. */ }
    }
    if (Array.from(select.options).some(option => option.value === previous)) select.value = previous;
    this.preview();
  }
  private candidate() {
    const { asset, semanticId } = modularAsset(node<HTMLSelectElement>('publish-block').value);
    const x = node<HTMLInputElement>('publish-x').valueAsNumber;
    const y = node<HTMLInputElement>('publish-y').valueAsNumber;
    const plot = this.profile?.plot;
    if (!plot) throw new Error('Your citizen needs an owned plot. Request land through your agent, then retry.');
    if (![x, y].every(Number.isInteger)) throw new Error('Enter whole Earth tile coordinates.');
    if (x < plot.x || y < plot.y || x + asset.footprint[0] > plot.x + plot.w || y + asset.footprint[1] > plot.y + plot.h) throw new Error('Keep the entire canonical structure inside your owned plot.');
    return { modelId: node<HTMLSelectElement>('publish-block').value, x, y, asset, semanticId };
  }
  private preview() {
    const button = node<HTMLButtonElement>('propose-build'); button.disabled = true;
    if (!this.profile?.plot) return;
    try {
      const c = this.candidate();
      text('publish-preview', `${c.asset.name}: ${c.asset.footprint.join(' × ')} tiles at ${c.x}, ${c.y}. South-facing entrance. Your chosen 3D model stays with the building.`);
      text('publish-error', ''); button.disabled = this.busy;
      for (const id of ['publish-x', 'publish-y']) node(id).setAttribute('aria-invalid', 'false');
    } catch (error) {
      text('publish-preview', ''); text('publish-error', (error as Error).message);
      for (const id of ['publish-x', 'publish-y']) node(id).setAttribute('aria-invalid', 'true');
    }
  }
  private async connect() {
    if (this.busy) return;
    this.busy = true; node<HTMLButtonElement>('connect-earth').disabled = true;
    text('connection-status', 'Checking your owner session…'); this.preview();
    try {
      this.profile = (await this.request('session')).profile;
      const plot = this.profile?.plot;
      text('connection-status', `Connected to ${this.profile?.agentName}.`);
      node('publish-form').hidden = !plot;
      if (plot) {
        text('owned-plot', `${plot.plotId} · ${plot.w} × ${plot.h} tiles · starts at ${plot.x}, ${plot.y}`);
        node<HTMLInputElement>('publish-x').value = String(plot.x); node<HTMLInputElement>('publish-y').value = String(plot.y);
      } else text('connection-status', `Connected to ${this.profile?.agentName}. Your citizen has no plot yet. Ask your agent to claim land, approve it on the dashboard, then check the connection.`);
      await this.reviews();
    } catch (error) {
      this.profile = null; node('publish-form').hidden = true; node('build-reviews').replaceChildren();
      text('connection-status', (error as Error).message);
    } finally { this.busy = false; node<HTMLButtonElement>('connect-earth').disabled = false; this.preview(); }
  }
  private async propose() {
    if (this.busy) return;
    try {
      const { modelId, x, y } = this.candidate();
      this.busy = true; this.preview(); text('publish-error', 'Submitting your permit for review…');
      await this.request('propose', { modelId, x, y });
      text('connection-status', 'Proposal recorded. Review its footprint below before approving construction.');
      text('message', 'Build permit recorded by the Kernel. Your neighborhood draft remains saved on this device.');
      await this.reviews();
    } catch (error) { text('connection-status', (error as Error).message); }
    finally { this.busy = false; this.preview(); }
  }
  private async reviews() {
    const reviews: Review[] = (await this.request('approvals')).approvals;
    const list = node('build-reviews'); list.replaceChildren();
    const builds = reviews.filter(item => item.kind === 'build');
    if (!builds.length) {
      const empty = document.createElement('p');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of Object.entries({ width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'aria-hidden': 'true', focusable: 'false' })) icon.setAttribute(name, value);
      const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      lines.setAttribute('d', 'M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4'); icon.append(lines);
      empty.append(icon, ' No pending build reviews. Submit an owned-plot permit to start a review.');
      list.append(empty);
    }
    for (const review of builds) {
      const section = document.createElement('section'); section.className = 'inspector';
      const title = document.createElement('h3'); title.textContent = review.summary;
      const detail = document.createElement('p'); detail.textContent = review.detail;
      const row = document.createElement('div'); row.className = 'button-row';
      for (const decision of ['approve', 'decline']) {
        const button = document.createElement('button'); button.textContent = decision === 'approve' ? 'Approve build' : 'Decline build';
        button.addEventListener('click', () => void this.decide(review.id, decision)); row.append(button);
      }
      section.append(title, detail, row); list.append(section);
    }
  }
  private async decide(approvalId: string, decision: string) {
    if (this.busy) return;
    this.busy = true;
    node('build-reviews').querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const result = await this.request('decide', { approvalId, decision });
      text('connection-status', decision === 'decline' ? 'Build declined. Your local draft is still available.' : result.awaitingCivicReview ? 'Owner approved. Civic review is still pending on the dashboard.' : 'Owner approved. Check live Earth for the construction route and scaffold.');
      text('message', node('connection-status').textContent ?? 'Build decision recorded.');
      node<HTMLAnchorElement>('view-published').href = `/?me=${encodeURIComponent(this.profile!.agentId)}&goto=${encodeURIComponent(this.profile!.agentId)}`;
      node('view-published').hidden = decision === 'decline';
      await this.reviews();
      node('connect-earth').focus();
    } catch (error) { text('connection-status', (error as Error).message); }
    finally { this.busy = false; node('build-reviews').querySelectorAll('button').forEach(button => { button.disabled = false; }); this.preview(); }
  }
}
