using Messenger.Api.Domain;

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
    string Kind = MessageKind.Text,
    int? MediaWidth = null,
    int? MediaHeight = null,
    int? MediaDurationMs = null);

public sealed record WallpaperDto(string Id);

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
    string Kind = DialogKind.Direct,
    string? Title = null,
    int MemberCount = 2,
    string MyRole = MemberRole.Member);

public sealed record MemberDto(UserDto User, string Role);

public static class DtoMappings
{
    public static UserDto ToUserDto(this User u) =>
        new(u.Id, u.Login, u.DisplayName, u.AvatarUrl);

    public static ProfileDto ToProfileDto(this User u, bool? isOnline = null, DateTime? lastSeenAt = null) =>
        new(u.Id, u.Login, u.DisplayName, u.AvatarUrl, u.Bio, u.CreatedAt, isOnline, lastSeenAt);

    public static MessageDto ToDto(this Message m) =>
        new(m.Id, m.ClientMessageId, m.DialogId, m.SenderId, m.Text, m.MediaUrl, m.CreatedAt, m.EditedAt,
            m.ReplyToId, m.ForwardedFromId, m.ForwardedFromName, m.Kind, m.MediaWidth, m.MediaHeight, m.MediaDurationMs);
}