export interface Contact {
  iroh_node_id: string;
  name: string;
  photo_path?: string | null;
  added_at: string;
  last_called_at?: string | null;
}
