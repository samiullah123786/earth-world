import { LPC_GRID_SIZE, assertTileInteger, structureSortAnchor } from './grid';
import { canonicalRenderLayer } from '../../shared/lpc-prefabs';

export type WorldRenderLayer = 'ground' | 'midground' | 'overhead';

export type ComponentRenderContract = Readonly<{
  layer: WorldRenderLayer;
  anchorRow: number;
  visualOffsetY: number;
  collisionCells: ReadonlyArray<Readonly<{ x: number; y: number }>>;
}>;

export function renderLayerForComponent(componentId: string): WorldRenderLayer {
  return canonicalRenderLayer(componentId);
}

export function componentRenderContract(
  componentId: string,
  component: { width: number; height: number; solid: boolean; frame?: { height: number } },
): ComponentRenderContract {
  const width = assertTileInteger(component.width, `${componentId}.width`);
  const height = assertTileInteger(component.height, `${componentId}.height`);
  if (width < 1 || height < 1) throw new Error(`${componentId} must occupy at least one tile`);
  const layer = renderLayerForComponent(componentId);
  // Canopies and roofs are visual occluders; their lower-layer collision is
  // supplied by trunks/walls, not inferred from the transparent image bounds.
  const collisionCells = component.solid && layer !== 'overhead'
    ? Array.from({ length: width * height }, (_unused, index) => ({ x: index % width, y: Math.floor(index / width) }))
    : [];
  // LPC props are authored from their visual top but placed by the tile where
  // their feet touch the ground. Bottom-align any art taller than its logical
  // footprint; roofs get one extra row of lift so their eaves overlap the
  // facade instead of sitting below it like a detached second building.
  const visualRows = Math.ceil(Number(component.frame?.height ?? height * LPC_GRID_SIZE) / LPC_GRID_SIZE);
  const visualOffsetY = componentId === 'roof_tile' ? -2 : Math.min(0, height - visualRows);
  return { layer, anchorRow: height, visualOffsetY, collisionCells };
}

export function midgroundDepth(tileY: number, height = 1): number {
  return structureSortAnchor(tileY, height);
}

/**
 * A semantic building image includes a visually open south-facing entry row.
 * Sort the facade from the row immediately north of that apron: citizens on
 * the entry row render in front, while citizens north of the wall still pass
 * behind it. Using the footprint's final row as the anchor made people at a
 * doorway look crushed underneath the entire building composition.
 */
export function semanticStructureDepth(tileY: number, height: number): number {
  const rows = assertTileInteger(height, 'semantic structure height');
  if (rows < 1) throw new Error('semantic structure height must be positive');
  return structureSortAnchor(tileY, Math.max(1, rows - 1));
}

export function citizenDepth(renderedFootY: number): number {
  if (!Number.isInteger(renderedFootY)) throw new Error('citizen foot depth must use an integer pixel');
  return renderedFootY;
}

export function isCitizenInFront(citizenFootY: number, structureAnchorY: number): boolean {
  return citizenDepth(citizenFootY) > structureAnchorY;
}

export const WORLD_LAYER_DEPTH = {
  ground: 0,
  midground: 1,
  overhead: 2,
} as const satisfies Record<WorldRenderLayer, number>;

export function assertGridAlignedPlacement(x: number, y: number) {
  if (x % LPC_GRID_SIZE !== 0 || y % LPC_GRID_SIZE !== 0) {
    throw new Error(`LPC placement (${x}, ${y}) is not aligned to the ${LPC_GRID_SIZE}px grid`);
  }
}
