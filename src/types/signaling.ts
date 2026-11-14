export type SignalMessageType = 'ring' | 'offer' | 'answer' | 'candidate' | 'hangup';
export type HangupReason = 'ended' | 'declined' | 'cancelled';

export interface SignalMessage {
  type: SignalMessageType;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  sender?: string;
  reason?: HangupReason;
}
