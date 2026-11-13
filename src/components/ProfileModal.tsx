import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Camera,
  Loader2,
  Save,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  getLocalProfile,
  isTauriEnvironment,
  resolveAvatarUrl,
  saveLocalProfile,
} from '../services/db';
import { pickAndCopyAvatar } from '../services/avatar';
import type { LocalProfile } from '../types/profile';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (profile: LocalProfile) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ProfileModal: React.FC<ProfileModalProps> = ({
  isOpen,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState('');
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPicking, setIsPicking] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClose = useCallback(() => {
    if (!isSaving) onClose();
  }, [isSaving, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    let ignore = false;

    getLocalProfile()
      .then((profile) => {
        if (ignore) return;
        setName(profile.name);
        setPhotoPath(profile.photo_path || null);
      })
      .catch((err: unknown) => {
        if (!ignore) setError(errorMessage(err));
      })
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const handlePickAvatar = async () => {
    if (!isTauriEnvironment()) {
      fileInputRef.current?.click();
      return;
    }

    try {
      setIsPicking(true);
      setError(null);
      const copiedPath = await pickAndCopyAvatar();
      if (copiedPath) setPhotoPath(copiedPath);
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setIsPicking(false);
    }
  };

  const handleBrowserAvatar = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setPhotoPath(reader.result);
    };
    reader.onerror = () => setError('Failed to read the selected image.');
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Please enter a display name.');
      return;
    }

    try {
      setIsSaving(true);
      setError(null);
      const profile = await saveLocalProfile(trimmedName, photoPath);
      onSaved(profile);
      onClose();
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const avatarUrl = resolveAvatarUrl(photoPath);
  const busy = isSaving || isPicking;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/75 backdrop-blur-sm"
        onClick={handleClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-modal-title"
        className="relative z-10 w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl shadow-black/80"
      >
        <div className="flex items-center justify-between border-b border-zinc-800/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-violet-500/20 bg-violet-600/15 text-violet-400">
              <UserRound className="h-5 w-5" />
            </div>
            <div>
              <h3 id="profile-modal-title" className="text-lg font-semibold text-zinc-100">
                Your Profile
              </h3>
              <p className="text-xs text-zinc-400">Shared with peers when adding contacts</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSaving}
            aria-label="Close profile settings"
            className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs leading-relaxed">{error}</p>
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-400">
            <Loader2 className="mb-2 h-7 w-7 animate-spin text-violet-500" />
            <p className="text-xs">Loading your profile...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-5 space-y-5">
            <div className="flex flex-col items-center gap-3">
              <div className="relative">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt="Your avatar"
                    className="h-24 w-24 rounded-2xl border border-zinc-700 object-cover ring-2 ring-violet-500/20"
                  />
                ) : (
                  <div className="flex h-24 w-24 items-center justify-center rounded-2xl border border-zinc-700 bg-zinc-800 text-zinc-500">
                    <UserRound className="h-10 w-10" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={handlePickAvatar}
                  disabled={busy}
                  title="Choose avatar image"
                  aria-label="Choose avatar image"
                  className="absolute -bottom-2 -right-2 rounded-xl border border-violet-400/30 bg-violet-600 p-2 text-white shadow-lg transition-colors hover:bg-violet-500 disabled:opacity-50"
                >
                  {isPicking ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Camera className="h-4 w-4" />
                  )}
                </button>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handlePickAvatar}
                  disabled={busy}
                  className="text-xs font-medium text-violet-400 hover:text-violet-300 disabled:opacity-50"
                >
                  Choose image
                </button>
                {photoPath && (
                  <button
                    type="button"
                    onClick={() => setPhotoPath(null)}
                    disabled={busy}
                    className="flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-rose-400 disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                onChange={handleBrowserAvatar}
                className="hidden"
              />
            </div>

            <div>
              <label
                htmlFor="profile-display-name"
                className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-zinc-400"
              >
                Display Name
              </label>
              <input
                id="profile-display-name"
                type="text"
                autoFocus
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={busy}
                placeholder="e.g. Alice Cooper"
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 transition-all focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 disabled:opacity-50"
              />
              <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
                Your latest saved name and avatar are read for every new contact handshake.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={handleClose}
                disabled={isSaving}
                className="rounded-xl px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-800/80 hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-2 text-sm font-medium text-white shadow-lg shadow-violet-600/30 transition-all hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {isSaving ? 'Saving...' : 'Save Profile'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
