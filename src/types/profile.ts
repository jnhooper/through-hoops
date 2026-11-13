export interface LocalProfile {
  name: string;
  photo_path?: string | null;
}

export interface HandshakeResult {
  remote_node_id: string;
  remote_name?: string | null;
  remote_photo_path?: string | null;
}
