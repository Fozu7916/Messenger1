// DTO — формат объектов REST/SignalR из DOCUMENTATION.md
export interface User { id: string; login: string; displayName: string; avatarUrl: string | null }
export interface AuthResponse { accessToken: string; expiresAt: string; user: User }
export interface MessageDto {
  id: string; clientMessageId: string; dialogId: string; senderId: string;
  text: string; mediaUrl: string | null; createdAt: string;
  editedAt: string | null;
}
export interface DialogDto {
  id: string; createdAt: string; peer: User; lastMessage: MessageDto | null;
  unreadCount: number;              // сколько сообщений собеседника я ещё не прочитал
  peerLastReadId: string | null;    // ULID последнего моего сообщения, которое прочитал собеседник
}

// Документы локальной БД (RxDB)
export type MsgStatus = 'pending' | 'sent' | 'failed';
export interface MessageDoc {
  clientMessageId: string; // первичный ключ: одинаков у pending и у подтверждённого сообщения
  id: string;              // серверный ULID; '' пока не подтверждено
  dialogId: string;        // серверный ULID или временный id 'L<peerId>' (диалог создан офлайн)
  senderId: string; text: string;
  createdAt: number; status: MsgStatus;
  isDeleted: boolean;      // не «deleted»: это имя занято самим RxDocument
  editedAt: number;        // когда изменено; 0 — не менялось
}
export interface PeerDoc { id: string; login: string; displayName: string; avatarUrl: string }
export interface DialogDoc {
  id: string; createdAt: number; peer: PeerDoc; unread: number;
  peerRead: string;        // ULID последнего сообщения, прочитанного собеседником; '' — ничего
  pending: boolean;        // true — диалог создан локально и ещё не создан на сервере
}
