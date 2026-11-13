export type SignalMessageType = 'offer' | 'answer' | 'candidate';

export interface SignalMessage {
  type: SignalMessageType;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  sender?: string;
}
