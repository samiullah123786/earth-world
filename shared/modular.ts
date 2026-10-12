import { CATALOGUE } from './catalogue';
import { EARTHFORGE_ASSETS } from './earthforge';

/** Presentation choices never change the Kernel's footprint or south entry. */
export const MODULAR_MODELS = Object.freeze(Object.fromEntries([
  ...'abcdefghijkl'.split('').map((letter, index) => [`home-${letter}`, ['home_courtyard', 'home_orchard', 'home_timber'][index % 3]]),
  ...'abcdefgh'.split('').map((letter, index) => [`civic-${letter}`, ['library_pavilion', 'workshop_sawtooth', 'civic_hall', 'greenhouse'][index % 4]]),
]));

export function modularAsset(modelId: string) {
  const semanticId = Object.prototype.hasOwnProperty.call(MODULAR_MODELS, modelId) ? MODULAR_MODELS[modelId] : undefined;
  const asset = semanticId ? EARTHFORGE_ASSETS[semanticId] : undefined;
  const model = CATALOGUE.find(item => item.id === modelId);
  if (!asset || !model) throw new Error('Choose a publishable home or community block.');
  return { semanticId, asset, model };
}

export function validatedModel(modelId: unknown, semanticId: string): string | undefined {
  if (modelId === undefined) return undefined;
  if (typeof modelId !== 'string' || modularAsset(modelId).semanticId !== semanticId) {
    throw new Error('3D model must match the canonical semantic asset');
  }
  return modelId;
}
