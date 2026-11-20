/**
 * Shrink a picked image to at most `max` pixels on its long side and return it as a PNG data URL
 * (keeps transparency; a logo is typically 10-40 KB after this).
 */
export async function shrinkImage(file: File, max = 192): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type)) throw new Error('Please choose a PNG, JPEG or WebP image');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize images');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const url = canvas.toDataURL('image/png');
  if (url.length > 140_000) throw new Error('That image is too detailed. Try a simpler logo.');
  return url;
}
