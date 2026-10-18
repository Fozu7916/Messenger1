using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;

namespace Messenger.Api.Auth;

public static class ClaimsPrincipalExtensions
{
    /// <summary>Id пользователя из claim "sub" (MapInboundClaims отключён).</summary>
    public static string GetUserId(this ClaimsPrincipal user) =>
        user.FindFirstValue("sub") ?? throw new UnauthorizedAccessException("No sub claim");
}

/// <summary>SignalR: Context.UserIdentifier и Clients.Users(...) работают по claim "sub".</summary>
public sealed class SubClaimUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) => connection.User.FindFirstValue("sub");
}
