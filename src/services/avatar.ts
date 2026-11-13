import { appDataDir, join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { BaseDirectory, copyFile, mkdir } from '@tauri-apps/plugin-fs';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/**
 * Prompts for an image and stores a private copy in the app's data directory.
 * Returns the absolute path to persist in the local profile, or null on cancel.
 */
export async function pickAndCopyAvatar(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }],
  });

  if (!selected) return null;

  const extension = selected.split('.').pop()?.toLowerCase();
  if (!extension || !IMAGE_EXTENSIONS.includes(extension)) {
    throw new Error('Please choose a PNG, JPEG, GIF, or WebP image.');
  }

  const fileName = `avatar-${Date.now()}.${extension}`;
  const relativePath = `avatars/${fileName}`;

  await mkdir('avatars', {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });
  await copyFile(selected, relativePath, {
    toPathBaseDir: BaseDirectory.AppData,
  });

  return join(await appDataDir(), relativePath);
}
