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
    DateTime CreatedAt);

public sealed record DialogDto(string Id, DateTime CreatedAt, UserDto? Peer, MessageDto? LastMessage);
