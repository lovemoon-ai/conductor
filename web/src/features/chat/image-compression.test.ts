import { afterEach, describe, expect, it, vi } from 'vitest';

import { compressImageIfNeeded, isCompressibleImage } from './image-compression';

const makeFile = (name: string, type: string, sizeBytes: number): File => {
  const file = new File([new Uint8Array(1)], name, { type });
  // jsdom cannot allocate huge buffers; fake the reported size.
  Object.defineProperty(file, 'size', { value: sizeBytes });
  return file;
};

describe('isCompressibleImage', () => {
  it('accepts raster photo formats by type or extension', () => {
    expect(isCompressibleImage(makeFile('a.png', 'image/png', 1))).toBe(true);
    expect(isCompressibleImage(makeFile('a.jpg', 'image/jpeg', 1))).toBe(true);
    expect(isCompressibleImage(makeFile('a.webp', 'image/webp', 1))).toBe(true);
    expect(isCompressibleImage(makeFile('photo', 'image/jpeg', 1))).toBe(true);
  });

  it('excludes gif and non-images', () => {
    expect(isCompressibleImage(makeFile('a.gif', 'image/gif', 1))).toBe(false);
    expect(isCompressibleImage(makeFile('a.pdf', 'application/pdf', 1))).toBe(false);
    expect(isCompressibleImage(makeFile('a.md', 'text/markdown', 1))).toBe(false);
  });
});

describe('compressImageIfNeeded', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the original for a non-image', async () => {
    const file = makeFile('spec.md', 'text/markdown', 5 * 1024 * 1024);
    expect(await compressImageIfNeeded(file)).toBe(file);
  });

  it('returns the original for a gif even when large', async () => {
    const file = makeFile('anim.gif', 'image/gif', 5 * 1024 * 1024);
    expect(await compressImageIfNeeded(file)).toBe(file);
  });

  it('leaves an image already under the target untouched', async () => {
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    const file = makeFile('small.jpg', 'image/jpeg', 512 * 1024);

    expect(await compressImageIfNeeded(file)).toBe(file);
    // Never even attempts to decode when the file is already small enough.
    expect(bitmap).not.toHaveBeenCalled();
  });

  it('falls back to the original when browser encode APIs are unavailable', async () => {
    // jsdom has no real createImageBitmap/canvas encoder.
    vi.stubGlobal('createImageBitmap', undefined);
    const file = makeFile('big.jpg', 'image/jpeg', 4 * 1024 * 1024);
    expect(await compressImageIfNeeded(file)).toBe(file);
  });

  it('re-encodes an oversized image to a smaller webp file', async () => {
    const smallBytes = 800 * 1024;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 4000,
      height: 3000,
      close: vi.fn(),
    })));
    // Stand in for a canvas whose encoder yields an under-target webp blob.
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }),
      toBlob: (cb: (blob: Blob) => void) => cb(new Blob([new Uint8Array(smallBytes)], { type: 'image/webp' })),
    };
    vi.stubGlobal('document', { createElement: () => canvas });
    vi.stubGlobal('HTMLCanvasElement', class {});

    const original = makeFile('photo.png', 'image/png', 6 * 1024 * 1024);
    const result = await compressImageIfNeeded(original);

    expect(result).not.toBe(original);
    expect(result.type).toBe('image/webp');
    expect(result.name).toBe('photo.webp');
    expect(result.size).toBeLessThanOrEqual(1024 * 1024);
  });

  it('keeps the original when re-encoding does not shrink it', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 100, height: 100, close: vi.fn() })));
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }),
      // Encoder returns something bigger than the source.
      toBlob: (cb: (blob: Blob) => void) => cb(new Blob([new Uint8Array(9 * 1024 * 1024)], { type: 'image/webp' })),
    };
    vi.stubGlobal('document', { createElement: () => canvas });
    vi.stubGlobal('HTMLCanvasElement', class {});

    const original = makeFile('photo.jpg', 'image/jpeg', 2 * 1024 * 1024);
    expect(await compressImageIfNeeded(original)).toBe(original);
  });
});
