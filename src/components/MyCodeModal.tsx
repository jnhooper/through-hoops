import React, { useState, useEffect, useCallback } from 'react';
import { X, QrCode, Copy, Check, Fingerprint, Loader2, ShieldCheck } from 'lucide-react';
import { getMyNodeId } from '../services/signaling';

interface MyCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const MyCodeModal: React.FC<MyCodeModalProps> = ({ isOpen, onClose }) => {
  const [nodeId, setNodeId] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  const handleClose = useCallback(() => {
    setCopied(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    let ignore = false;

    getMyNodeId()
      .then((id) => {
        if (!ignore) {
          setNodeId(id);
          setError(null);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!ignore) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg || 'Failed to retrieve local Iroh node ID.');
          setIsLoading(false);
        }
      });

    return () => {
      ignore = true;
    };
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    if (!nodeId) return;
    try {
      await navigator.clipboard.writeText(nodeId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy node ID:', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/75 backdrop-blur-sm transition-opacity"
        onClick={handleClose}
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-md rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl shadow-black/80 transition-all z-10">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600/15 text-violet-400 border border-violet-500/20">
              <QrCode className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-zinc-100">My Node Code</h3>
              <p className="text-xs text-zinc-400">Your local Iroh cryptographic peer identity</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="mt-5 space-y-4">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-10 text-zinc-400">
              <Loader2 className="h-7 w-7 animate-spin text-violet-500 mb-2" />
              <p className="text-xs">Reading public key from Iroh node...</p>
            </div>
          ) : error ? (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs leading-relaxed">
              {error}
            </div>
          ) : (
            <>
              {/* Node ID Card */}
              <div className="rounded-xl bg-zinc-950/80 border border-zinc-800 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
                    <Fingerprint className="h-3.5 w-3.5 text-violet-400" />
                    Public Key / Node ID
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-950/50 px-2 py-0.5 rounded-full border border-emerald-500/30">
                    <ShieldCheck className="h-3 w-3" />
                    Active Node
                  </span>
                </div>

                <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800/80 font-mono text-xs text-zinc-200 break-all select-all leading-relaxed">
                  {nodeId}
                </div>

                <div className="pt-1 flex items-center justify-between text-[11px] text-zinc-500">
                  <span>Ed25519 Public Key</span>
                  <span>{nodeId.length} characters</span>
                </div>
              </div>

              {/* Informational description */}
              <p className="text-xs text-zinc-400 leading-relaxed">
                Share this code with your peer so they can save you in their contacts and dial your node directly over encrypted QUIC streams.
              </p>

              {/* Actions */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold shadow-lg shadow-violet-600/30 transition-all cursor-pointer"
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4 text-emerald-300" />
                      <span>Copied to Clipboard!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      <span>Copy Node ID</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2.5 rounded-xl text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
