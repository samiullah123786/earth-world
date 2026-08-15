import lpcManifest from '../data/lpc_manifest.json';
import { LPC_PREFABS, requireLpcPrefab } from '../../shared/lpc-prefabs';
import { EARTHFORGE_ASSETS, EARTHFORGE_SYSTEM } from '../../shared/earthforge';

export type AgentWorldPlacement = {
  tile?: string;
  prop?: string;
  xOffset: number;
  yOffset: number;
};

export type ConstructStructureAction = {
  action: 'construct_structure';
  structureType: string;
  coordinates: { x: number; y: number };
  assetId?: string;
  prefabId?: string;
};

export type KernelConstructStructureAction = Omit<ConstructStructureAction, 'action'> & {
  type: 'construct_structure';
};

export type SignedWorldActionSubmitter<Result = unknown> =
  (action: KernelConstructStructureAction) => Promise<Result>;

type ManifestComponent = {
  width: number;
  height: number;
  solid: boolean;
  category: string;
};

const components = lpcManifest.components as Record<string, ManifestComponent>;
const structureTypes = new Set<string>(lpcManifest.structureTypes);

function isWholeTile(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Browser-side ergonomics for a signed agent action. This service never owns a
 * private key and never writes to Convex directly. The injected submitter must
 * use the existing signed agent transport, while the Kernel repeats every
 * manifest, ownership, permission, geometry, and collision check.
 */
export class AgentBuildService<Result = unknown> {
  constructor(private readonly submitSignedAction: SignedWorldActionSubmitter<Result>) {}

  async executeWorldAction(input: ConstructStructureAction): Promise<Result> {
    if (input.action !== 'construct_structure') throw new Error('unsupported world action');
    if (!isWholeTile(input.coordinates?.x) || !isWholeTile(input.coordinates?.y)) {
      throw new Error('construction coordinates must use non-negative whole tiles');
    }
    if (input.assetId) {
      const asset = EARTHFORGE_ASSETS[input.assetId];
      if (!asset) throw new Error('unknown EarthForge semantic asset');
      if (asset.kind !== input.structureType) throw new Error('semantic asset does not match the requested structure type');
      return await this.submitSignedAction({
        type: 'construct_structure',
        structureType: input.structureType,
        coordinates: { ...input.coordinates },
        assetId: input.assetId,
      });
    }
    if (!structureTypes.has(input.structureType)) throw new Error('unknown legacy LPC structure type');
    const prefab = requireLpcPrefab(String(input.prefabId ?? ''));
    if (prefab.structureType !== input.structureType) throw new Error('prefab does not match the requested structure type');

    return await this.submitSignedAction({
      type: 'construct_structure',
      structureType: input.structureType,
      coordinates: { ...input.coordinates },
      prefabId: prefab.id,
    });
  }
}

export const LPC_BUILD_TEMPLATES = Object.fromEntries(Object.entries(LPC_PREFABS).map(([id, prefab]) => [
  id,
  prefab.placements.map((placement) => placement.layer === 'ground'
    ? { tile: placement.assetId, xOffset: placement.xOffset, yOffset: placement.yOffset }
    : { prop: placement.assetId, xOffset: placement.xOffset, yOffset: placement.yOffset }),
])) as Record<string, AgentWorldPlacement[]>;
export const LPC_STRUCTURE_TYPES = [...lpcManifest.structureTypes];
export const EARTHFORGE_BUILD_ASSETS = Object.fromEntries(Object.entries(EARTHFORGE_ASSETS).map(([assetId, asset]) => [
  assetId,
  { system: EARTHFORGE_SYSTEM, kind: asset.kind, name: asset.name, footprint: asset.footprint, features: asset.features },
]));
