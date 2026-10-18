export interface User { id: string; login: string; displayName: string; avatarUrl: string | null }

export interface Message {
  id: string;
  clientMessageId: string;
  dialogId: string;
  senderId: string;
  text: string;
  mediaUrl: string | null;
  createdAt: string;
}

export interface Dialog { id: string; createdAt: string; peer: User | null; lastMessage: Message | null }
export interface AuthResponse { accessToken: string; expiresAt: string; user: User }

export type MsgStatus = 'pending' | 'sent' | 'failed';
/** Локальная копия сообщения в RxDB. id = '' пока сервер не присвоил ULID. */
export interface LocalMessage extends Message { status: MsgStatus }
