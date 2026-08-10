import lpcManifest from '../data/lpc_manifest.json';

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
  blueprint: AgentWorldPlacement[];
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
    if (!structureTypes.has(input.structureType)) throw new Error('unknown LPC structure type');
    if (!isWholeTile(input.coordinates?.x) || !isWholeTile(input.coordinates?.y)) {
      throw new Error('construction coordinates must use non-negative whole tiles');
    }
    if (!Array.isArray(input.blueprint) || input.blueprint.length < 1 || input.blueprint.length > 64) {
      throw new Error('an LPC blueprint must contain 1 to 64 placements');
    }

    const solidRects: Array<{ x: number; y: number; w: number; h: number }> = [];
    const blueprint = input.blueprint.map((placement) => {
      const hasTile = typeof placement.tile === 'string';
      const hasProp = typeof placement.prop === 'string';
      if (hasTile === hasProp) throw new Error('each placement must specify exactly one tile or prop');
      const assetId = String(hasTile ? placement.tile : placement.prop);
      const component = components[assetId];
      if (!component) throw new Error(`unknown LPC asset: ${assetId}`);
      if (!isWholeTile(placement.xOffset) || !isWholeTile(placement.yOffset)) {
        throw new Error('placement offsets must use non-negative whole tiles');
      }
      const rect = {
        x: placement.xOffset,
        y: placement.yOffset,
        w: component.width,
        h: component.height,
      };
      if (component.solid && solidRects.some((candidate) => overlaps(rect, candidate))) {
        throw new Error(`${assetId} overlaps another solid component`);
      }
      if (component.solid) solidRects.push(rect);
      return hasTile
        ? { tile: assetId, xOffset: placement.xOffset, yOffset: placement.yOffset }
        : { prop: assetId, xOffset: placement.xOffset, yOffset: placement.yOffset };
    });

    return await this.submitSignedAction({
      type: 'construct_structure',
      structureType: input.structureType,
      coordinates: { ...input.coordinates },
      blueprint,
    });
  }
}

export const LPC_BUILD_TEMPLATES = lpcManifest.templates as Record<string, AgentWorldPlacement[]>;
export const LPC_STRUCTURE_TYPES = [...lpcManifest.structureTypes];
