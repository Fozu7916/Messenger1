namespace Messenger.Api.Contracts;

public sealed record UserDto(string Id, string Login, string DisplayName, string? AvatarUrl);

public sealed record AuthResponse(string AccessToken, DateTime ExpiresAt, UserDto User);

public sealed record MessageDto(
    string Id,
    string ClientMessageId,
    string DialogId,
    string SenderId,
    string Text,
    string? MediaUrl,
    DateTime CreatedAt,
    DateTime? EditedAt = null);

/// <summary>
/// UnreadCount — сколько сообщений собеседника это пользователь ещё не прочитал.
/// PeerLastReadId — ULID последнего сообщения, которое прочитал собеседник (для отметки «прочитано»).
/// </summary>
public sealed record DialogDto(
    string Id,
    DateTime CreatedAt,
    UserDto? Peer,
    MessageDto? LastMessage,
    int UnreadCount = 0,
    string? PeerLastReadId = null);
