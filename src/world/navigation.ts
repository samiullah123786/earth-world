import EasyStar from 'easystarjs';

export class DynamicNavigationGrid {
  private width = 0;
  private height = 0;
  private grid: number[][] = [];
  private finder = new EasyStar.js();

  rebuild(width: number, height: number, blocked: (x: number, y: number) => boolean) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('navigation bounds must be positive whole tiles');
    }
    this.width = width;
    this.height = height;
    this.grid = Array.from({ length: height }, (_row, y) =>
      Array.from({ length: width }, (_cell, x) => blocked(x, y) ? 1 : 0));
    this.finder = new EasyStar.js();
    this.finder.setGrid(this.grid);
    this.finder.setAcceptableTiles([0]);
    this.finder.enableSync();
  }

  putCollisionChunk(originX: number, originY: number, width: number, height: number, gids: ReadonlyArray<number>) {
    if (gids.length !== width * height) throw new Error('collision chunk does not match its dimensions');
    for (let localY = 0; localY < height; localY++) for (let localX = 0; localX < width; localX++) {
      const x = originX + localX, y = originY + localY;
      if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
      this.grid[y][x] = gids[localY * width + localX] === 0 ? 0 : 1;
    }
    this.finder.setGrid(this.grid);
    this.finder.setAcceptableTiles([0]);
  }

  blockCells(cells: ReadonlyArray<Readonly<{ x: number; y: number }>>) {
    for (const { x, y } of cells) {
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
      this.grid[y][x] = 1;
    }
    this.finder.setGrid(this.grid);
    this.finder.setAcceptableTiles([0]);
  }

  isWalkable(x: number, y: number) {
    return Number.isInteger(x) && Number.isInteger(y)
      && x >= 0 && y >= 0 && x < this.width && y < this.height
      && this.grid[y]?.[x] === 0;
  }

  route(fromX: number, fromY: number, toX: number, toY: number) {
    if (![fromX, fromY, toX, toY].every(Number.isInteger)
      || !this.isWalkable(fromX, fromY) || !this.isWalkable(toX, toY)) return null;
    let result: Array<{ x: number; y: number }> | null = null;
    this.finder.findPath(fromX, fromY, toX, toY, (path) => { result = path ?? null; });
    this.finder.calculate();
    return result;
  }

  diagnostics() {
    return {
      width: this.width,
      height: this.height,
      blocked: this.grid.reduce((sum, row) => sum + row.filter((cell) => cell === 1).length, 0),
    };
  }
}
