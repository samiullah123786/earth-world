import Phaser from 'phaser';

export type MatrixPalette = Record<string, string>;
export type AnimationFrames = {
  idle: string[];
  walk: string[][];
};

/**
 * Renders an animated sprite texture from a pixel color key matrix onto a Phaser.Scene texture key.
 */
export function buildTextureFromMatrix(
  scene: Phaser.Scene,
  textureKey: string,
  matrix: string[],
  palette: MatrixPalette,
  scale = 4
): void {
  const height = matrix.length;
  const width = matrix[0].length;
  const graphics = scene.make.graphics({ x: 0, y: 0 }, false);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const char = matrix[y][x];
      if (char !== '.') {
        const hexStr = palette[char];
        if (hexStr) {
          const colorHex = hexStr.replace('#', '0x');
          graphics.fillStyle(parseInt(colorHex, 16), 1);
          graphics.fillRect(x * scale, y * scale, scale, scale);
        }
      }
    }
  }

  if (scene.textures.exists(textureKey)) {
    scene.textures.remove(textureKey);
  }
  graphics.generateTexture(textureKey, width * scale, height * scale);
  graphics.destroy();
}

/**
 * Bakes animated textures and initializes Phaser animation for a matrix-based agent.
 */
export function registerAgentMatrixAnimation(
  scene: Phaser.Scene,
  agentKey: string,
  frames: AnimationFrames,
  palette: MatrixPalette,
  scale = 4
): string {
  // 1. Bake textures in memory
  const idleKey = `${agentKey}_idle`;
  buildTextureFromMatrix(scene, idleKey, frames.idle, palette, scale);

  const walkKeys: string[] = [];
  frames.walk.forEach((frameMatrix, idx) => {
    const walkKey = `${agentKey}_walk_${idx + 1}`;
    buildTextureFromMatrix(scene, walkKey, frameMatrix, palette, scale);
    walkKeys.push(walkKey);
  });

  const animKey = `${agentKey}_walking`;

  // 2. Create the Phaser animation loop
  if (scene.anims.exists(animKey)) {
    scene.anims.remove(animKey);
  }

  const animFrames = [
    { key: walkKeys[0] },
    { key: idleKey },
    { key: walkKeys[1] || walkKeys[0] }
  ];

  scene.anims.create({
    key: animKey,
    frames: animFrames,
    frameRate: 6,
    repeat: -1
  });

  return animKey;
}
