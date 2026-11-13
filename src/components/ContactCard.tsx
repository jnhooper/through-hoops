import React, { useState } from 'react';
import { Video, Copy, Check, Clock, Trash2, Calendar } from 'lucide-react';
import type { Contact } from '../types/contact';

interface ContactCardProps {
  contact: Contact;
  onCall: (contact: Contact) => void;
  onDelete?: (irohNodeId: string) => void;
  variant?: 'recent' | 'standard';
}

const GRADIENT_PRESETS = [
  'from-violet-500 to-indigo-600',
  'from-emerald-500 to-teal-600',
  'from-blue-500 to-cyan-600',
  'from-amber-500 to-orange-600',
  'from-fuchsia-500 to-pink-600',
  'from-rose-500 to-red-600',
];

function getGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
  }
  const index = Math.abs(hash) % GRADIENT_PRESETS.length;
  return GRADIENT_PRESETS[index];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatRelativeTime(dateString?: string | null): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < 0) return 'Just now';

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const ContactCard: React.FC<ContactCardProps> = ({
  contact,
  onCall,
  onDelete,
  variant = 'standard',
}) => {
  const [copied, setCopied] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleCopyId = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(contact.iroh_node_id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy ID', err);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete && window.confirm(`Remove ${contact.name} from contacts?`)) {
      setIsDeleting(true);
      onDelete(contact.iroh_node_id);
    }
  };

  const truncatedId =
    contact.iroh_node_id.length > 18
      ? `${contact.iroh_node_id.slice(0, 8)}...${contact.iroh_node_id.slice(-6)}`
      : contact.iroh_node_id;

  const gradient = getGradient(contact.name);
  const initials = getInitials(contact.name);

  return (
    <div
      className={`group relative flex items-center justify-between p-4 rounded-2xl transition-all duration-200 border ${
        variant === 'recent'
          ? 'bg-gradient-to-br from-zinc-900/90 to-zinc-900/40 border-violet-500/20 hover:border-violet-500/40 hover:shadow-lg hover:shadow-violet-950/20'
          : 'bg-zinc-900/60 border-zinc-800/80 hover:bg-zinc-900/90 hover:border-zinc-700/80'
      }`}
    >
      <div className="flex items-center gap-4 min-w-0">
        {/* Avatar */}
        <div className="relative shrink-0">
          {contact.photo_path ? (
            <img
              src={contact.photo_path}
              alt={contact.name}
              className="h-12 w-12 rounded-xl object-cover ring-2 ring-zinc-700"
            />
          ) : (
            <div
              className={`flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${gradient} text-white font-semibold text-sm shadow-md`}
            >
              {initials}
            </div>
          )}
          {variant === 'recent' && (
            <span
              title="Recent call"
              className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-[9px] text-white ring-2 ring-zinc-900"
            >
              ★
            </span>
          )}
        </div>

        {/* Contact Info */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-base font-semibold text-zinc-100 truncate group-hover:text-violet-300 transition-colors">
              {contact.name}
            </h4>
          </div>

          {/* Iroh Node ID with Copy */}
          <div className="flex items-center gap-2 mt-0.5">
            <span
              className="font-mono text-xs text-zinc-400 bg-zinc-950/60 px-2 py-0.5 rounded-md border border-zinc-800/80 truncate max-w-[210px]"
              title={contact.iroh_node_id}
            >
              {truncatedId}
            </span>
            <button
              type="button"
              onClick={handleCopyId}
              title="Copy Iroh Node ID"
              className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          {/* Meta timestamps */}
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-zinc-400">
            {contact.last_called_at ? (
              <span className="flex items-center gap-1 text-emerald-400/90 font-medium">
                <Clock className="h-3 w-3" />
                Called {formatRelativeTime(contact.last_called_at)}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-zinc-400">
                <Calendar className="h-3 w-3" />
                Added {formatRelativeTime(contact.added_at)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2 ml-4 shrink-0">
        {onDelete && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={isDeleting}
            title="Delete contact"
            className="opacity-0 group-hover:opacity-100 p-2 text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-xl transition-all cursor-pointer"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}

        <button
          type="button"
          onClick={() => onCall(contact)}
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-600/90 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-950/30 transition-all hover:scale-105 active:scale-95 cursor-pointer"
        >
          <Video className="h-3.5 w-3.5" />
          <span>Call</span>
        </button>
      </div>
    </div>
  );
};
