import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const IMAGE_BUDGET_BYTES = 500 * 1024;
const imagePattern = /\.(?:avif|jpe?g|png|webp)$/i;

async function findImages(directory) {
  const images = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) images.push(...(await findImages(filename)));
    else if (imagePattern.test(entry.name)) images.push(filename);
  }
  return images;
}

const images = await findImages('public');
const measured = await Promise.all(
  images.map(async (filename) => ({
    filename: filename.replaceAll('\\', '/'),
    bytes: (await stat(filename)).size,
  })),
);
const oversized = measured.filter(({ bytes }) => bytes > IMAGE_BUDGET_BYTES);
const largest = measured.sort((left, right) => right.bytes - left.bytes)[0];

if (oversized.length > 0) {
  for (const image of oversized)
    console.error(
      `${image.filename}: ${(image.bytes / 1024).toFixed(0)}KB exceeds 500KB`,
    );
  process.exitCode = 1;
} else if (largest) {
  console.log(
    `Image budget OK: ${measured.length} files, largest ${largest.filename} (${(largest.bytes / 1024).toFixed(0)}KB)`,
  );
}
