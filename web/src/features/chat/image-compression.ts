// Browser-side image compression applied before an attachment is uploaded.
//
// Large photos otherwise travel to the Web server, then to the Daemon, and
// finally into a model's image input at full resolution. Re-encoding an
// oversized image down to ~1MB in the browser cuts every hop's cost while
// keeping quality high enough for a model to read it.
//
// Only raster photo formats are touched. GIFs are left alone because canvas
// re-encoding would flatten their animation, and non-images are never passed
// here. Every failure path falls back to the original File so a decode problem
// can never block a send.

const DEFAULT_TARGET_BYTES = 1024 * 1024;
const OUTPUT_TYPE = 'image/webp';
const QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5, 0.4];
const MIN_SCALE = 0.4;
const MAX_SOURCE_PIXELS = 40_000_000; // ~40MP guard against decoding absurd inputs

// GIF is intentionally excluded: it is a native image type but usually animated.
const COMPRESSIBLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const COMPRESSIBLE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);

export interface CompressImageOptions {
  targetBytes?: number;
}

const extensionOf = (name: string): string => name.split('.').pop()?.toLowerCase() ?? '';

export function isCompressibleImage(file: File): boolean {
  return COMPRESSIBLE_TYPES.has(file.type.toLowerCase())
    || COMPRESSIBLE_EXTENSIONS.has(extensionOf(file.name));
}

const canvasToBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), OUTPUT_TYPE, quality);
  });

const withWebpExtension = (name: string): string => {
  const base = name.replace(/\.[^./\\]+$/, '');
  return `${base || 'image'}.webp`;
};

/**
 * Re-encode an image to WebP no larger than `targetBytes`, preferring quality
 * reduction and only downscaling when quality alone is not enough. Returns the
 * original File when compression is unnecessary, unsupported, or unhelpful.
 */
export async function compressImageIfNeeded(
  file: File,
  options: CompressImageOptions = {},
): Promise<File> {
  const targetBytes = options.targetBytes ?? DEFAULT_TARGET_BYTES;
  if (!isCompressibleImage(file) || file.size <= targetBytes) return file;
  if (
    typeof document === 'undefined'
    || typeof createImageBitmap !== 'function'
    || typeof HTMLCanvasElement === 'undefined'
  ) {
    return file;
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) return file;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return file;

    let best: Blob | null = null;
    for (let scale = 1; scale >= MIN_SCALE; scale *= 0.8) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      for (const quality of QUALITY_STEPS) {
        const blob = await canvasToBlob(canvas, quality);
        if (!blob) continue;
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= targetBytes) {
          return finalize(file, blob, targetBytes);
        }
      }
    }
    // Never got under target; keep the smallest attempt only if it actually helps.
    return finalize(file, best, targetBytes);
  } catch {
    return file;
  } finally {
    bitmap?.close?.();
  }
}

function finalize(original: File, blob: Blob | null, targetBytes: number): File {
  // Ignore a re-encode that failed or came out no smaller than the source.
  if (!blob || blob.size >= original.size) return original;
  // Below target we always take it; above target only if meaningfully smaller,
  // so a barely-compressible image is not needlessly converted to WebP.
  if (blob.size > targetBytes && blob.size > original.size * 0.9) return original;
  return new File([blob], withWebpExtension(original.name), {
    type: OUTPUT_TYPE,
    lastModified: original.lastModified,
  });
}
