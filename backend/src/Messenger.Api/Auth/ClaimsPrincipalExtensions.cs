using System.Security.Claims;
using Microsoft.AspNetCore.SignalR;
using Microsoft.IdentityModel.JsonWebTokens;

namespace Messenger.Api.Auth;

public static class ClaimsPrincipalExtensions
{
    /// <summary>
    /// Возвращает id пользователя из claim "sub".Требует, чтобы MapInboundClaims был отключён.
    /// </summary>
    public static string GetUserId(this ClaimsPrincipal user)
    {
        var userId = user.FindFirstValue(JwtRegisteredClaimNames.Sub);

        if (userId is null)
        {
            throw new UnauthorizedAccessException(
                $"Claim '{JwtRegisteredClaimNames.Sub}' is missing.");
        }

        return userId;
    }
}

/// <summary>
/// SignalR: Context.UserIdentifier и Clients.Users(...) работают по claim "sub".
/// </summary>
public sealed class SubClaimUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) =>
        connection.User.FindFirstValue(JwtRegisteredClaimNames.Sub);
}