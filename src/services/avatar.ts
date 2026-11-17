import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

/**
 * Prompts for an image and stores a private copy in the app's data directory.
 * Returns the absolute path to persist in the local profile, or null on cancel.
 *
 * Rust reads and validates the file by its contents: on Android the dialog
 * returns a `content://` URI with no file extension to check.
 */
export async function pickAndCopyAvatar(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Images', extensions: IMAGE_EXTENSIONS }],
  });

  if (!selected) return null;

  return await invoke<string>('import_local_avatar', { source: selected });
}
