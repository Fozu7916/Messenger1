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
    DateTime? EditedAt = null,
    string? ReplyToId = null,
    string? ForwardedFromId = null,
    string? ForwardedFromName = null,
    string Kind = "text",
    int? MediaWidth = null,
    int? MediaHeight = null,
    int? MediaDurationMs = null);

public sealed record WallpaperDto(string Id);

/// <summary>Куда клиенту грузить видео: PUT на uploadUrl с заголовком Content-Type = contentType.</summary>
public sealed record VideoUploadDto(string FileId, string Ext, string UploadUrl, string ContentType, DateTime ExpiresAt);

/// <summary>Профиль. IsOnline/LastSeenAt заполняются только для собеседников (с кем есть общий диалог).</summary>
public sealed record ProfileDto(
    string Id,
    string Login,
    string DisplayName,
    string? AvatarUrl,
    string? Bio,
    DateTime CreatedAt,
    bool? IsOnline = null,
    DateTime? LastSeenAt = null);

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
    string? PeerLastReadId = null,
    string Kind = "direct",
    string? Title = null,
    int MemberCount = 2,
    string MyRole = "member");

public sealed record MemberDto(UserDto User, string Role);
