/**
 * Test-only: build the smallest real gzip tar the vault will accept.
 *
 * Pillar 2 made the Kernel open and read every deposit's bytes, which
 * retired the era of fixtures storing `new Blob(['master bytes'])` - the
 * vault now refuses anything that does not parse as the archive it claims
 * to be, in tests exactly as in production.
 */
import { gzipSync } from 'node:zlib';

export function tinyTar(files: Array<{ name: string; text: string; typeflag?: string }>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.text, 'utf-8');
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 'utf-8');
    header.write('0000644\0', 100, 'utf-8');
    header.write('0000000\0', 108, 'utf-8');
    header.write('0000000\0', 116, 'utf-8');
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'utf-8');
    header.write('00000000000\0', 136, 'utf-8');
    header.write('        ', 148, 'utf-8');
    header.write(file.typeflag ?? '0', 156, 'utf-8');
    header.write('ustar\0', 257, 'utf-8');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf-8');
    blocks.push(header, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(blocks));
}

/** A clean, scannable one-file skill archive, gzipped the way real packs are.
 *  Returned as a plain ArrayBuffer: the deploy-time Blob typings refuse a
 *  Uint8Array view whose buffer might be shared, and a copy settles it. */
export function cleanSkillArchive(title = 'test-skill'): ArrayBuffer {
  const packed = gzipSync(Buffer.from(tinyTar([
    { name: 'SKILL.md', text: `# ${title}\n\nHonest knowledge, plainly written.\n` },
  ])));
  const copy = new ArrayBuffer(packed.length);
  new Uint8Array(copy).set(packed);
  return copy;
}
