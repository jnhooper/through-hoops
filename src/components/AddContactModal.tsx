import React, { useState, useEffect, useCallback } from 'react';
import { X, UserPlus, Fingerprint, AlertCircle, Loader2 } from 'lucide-react';
import { performHandshake } from '../services/db';

interface AddContactModalProps {
  isOpen: boolean;
  onClose: () => void;
  onContactAdded: () => Promise<void> | void;
  onSaveContact: (
    irohNodeId: string,
    name: string,
    photoPath?: string | null
  ) => Promise<void>;
}

export const AddContactModal: React.FC<AddContactModalProps> = ({
  isOpen,
  onClose,
  onContactAdded,
  onSaveContact,
}) => {
  const [irohNodeId, setIrohNodeId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    setIrohNodeId('');
    setError(null);
    onClose();
  }, [isSubmitting, onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !isSubmitting) {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, handleClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = irohNodeId.trim();

    if (!cleanId) {
      setError('Please provide the Iroh Node ID.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      const handshake = await performHandshake(cleanId);
      await onSaveContact(
        handshake.remote_node_id,
        handshake.remote_name?.trim() || 'Anonymous',
        handshake.remote_photo_path
      );
      await onContactAdded();
      handleClose();
    } catch (err: unknown) {
      console.error('Failed to add contact:', err);
      const message = err instanceof Error ? err.message : String(err);
      // insertContact is an upsert, so adding an existing contact just updates it.
      setError(message || 'Failed to add contact. Please check your inputs.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm transition-opacity"
        onClick={() => !isSubmitting && handleClose()}
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl shadow-black/80 transition-all z-10">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600/15 text-violet-400 border border-violet-500/20">
              <UserPlus className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-zinc-100">Add New Contact</h3>
              <p className="text-xs text-zinc-400">Exchange profiles directly with a peer</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 text-sm text-rose-300">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed">{error}</p>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1.5">
              Iroh Node ID / Peer Key
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                <Fingerprint className="h-4 w-4" />
              </div>
              <input
                type="text"
                autoFocus
                required
                spellCheck={false}
                value={irohNodeId}
                onChange={(e) => setIrohNodeId(e.target.value)}
                placeholder="e.g. 7ba390d4f1883c749a02d41b..."
                className="w-full rounded-xl bg-zinc-950/70 border border-zinc-800 pl-10 pr-4 py-2.5 text-sm font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500 transition-all"
              />
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
              Paste a peer code. Both contacts lists will update after profiles and avatars are exchanged.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-sm font-medium rounded-xl text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 px-5 py-2 text-sm font-medium rounded-xl bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-600/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4" />
                  Add Contact
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
