export interface Principal {
  userId: string;
  petId: string;
  deviceId: string;
  expiresAt: number;
  petRegistered?: boolean;
}
export interface Animation {
  name?: string;
  frames: number[];
  fps: number;
}
export interface Manifest {
  schemaVersion: number;
  displaySize: number;
  frameWidth: number;
  frameHeight: number;
  animations: Partial<Record<string, Animation>>;
  idleAnimation?: string;
  walkAnimation?: string;
}
export interface Design {
  id: string;
  version: number;
  ownerId: string;
  name: string;
  imageHash: string;
  manifest: Manifest;
}
export interface Pet {
  builtinId?: string;
  id: string;
  userId: string;
  ownerName: string;
  name: string;
  design: Design | null;
  online: boolean;
}
export interface RegisteredPet extends Pet {
  registered: boolean;
}
export interface Session {
  token: string;
  principal: Principal;
}
export interface PetEvent {
  local?: boolean;
  proposalKind?: 'coffee' | 'meal';
  replyToMessageId?: string;
  outgoing?: { mode: string; recipientCount: number; recipientName?: string };
  id: string;
  type: 'message' | 'notification';
  kind: 'text' | 'emoji' | 'interaction' | 'external';
  body: string;
  sender?: { userId: string; userName: string; petId: string; petName: string; designId?: string; builtinId?: string };
  notification?: { schemaVersion: number; title: string; body: string; sourceKind: string; connectionId: string; eventId: string; occurredAt: number };
  createdAt: number;
  expiresAt: number;
}

export type RecruitmentKind = 'coffee' | 'smoke' | 'meal' | 'chat' | 'walk';

export const recruitmentOptions: Record<RecruitmentKind, { icon: string; label: string; invitation: string }> = {
  coffee: { icon: '☕', label: '커피', invitation: '커피 같이 마실 사람!' },
  smoke: { icon: '🚬', label: '담배', invitation: '담배 같이 피울 사람!' },
  meal: { icon: '🍚', label: '밥', invitation: '밥 같이 먹을 사람!' },
  chat: { icon: '💬', label: '수다', invitation: '같이 수다 떨 사람!' },
  walk: { icon: '🚶', label: '산책', invitation: '같이 산책할 사람!' },
};

export interface Gathering {
  id: string;
  hostPetId: string;
  kind: RecruitmentKind;
  status: string;
  expiresAt: number;
  members: { petId: string; petName: string; userName: string }[];
  origin?: 'message' | 'recruitment';
  host?: PetEvent['sender'];
}

export interface GatheringActivity {
  id: string;
  type: 'gathering_activity';
  action: 'started' | 'joined' | 'completed';
  actor: NonNullable<PetEvent['sender']>;
  gathering: Gathering;
  createdAt: number;
  expiresAt: number;
}
