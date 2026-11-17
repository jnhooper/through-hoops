export type SignalMessageType = 'ring' | 'offer' | 'answer' | 'candidate' | 'hangup';
// 'busy' is newer; older builds treat any hangup the same regardless of reason.
export type HangupReason = 'ended' | 'declined' | 'cancelled' | 'busy';

export interface SignalMessage {
  type: SignalMessageType;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  sender?: string;
  reason?: HangupReason;
}
