using System.Security.Cryptography;
using System.Text;
using Messenger.Api.Data;
using Messenger.Api.Domain;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Messenger.Api.Auth;

public interface IRefreshTokenService
{
    Task<string> IssueAsync(string userId, CancellationToken ct);
    /// <summary>Меняет токен на новый. null — токен неизвестен, просрочен или отозван.</summary>
    Task<(User User, string Raw)?> RotateAsync(string raw, CancellationToken ct);
    Task RevokeAsync(string? raw, CancellationToken ct);
}

public sealed class RefreshTokenService(AppDbContext db, IOptions<JwtOptions> options, IConfiguration config) : IRefreshTokenService
{
    /// <summary>Параллельные вкладки могут обновиться одним токеном почти одновременно — это не кража.</summary>
    private TimeSpan Grace => TimeSpan.FromSeconds(config.GetValue("Auth:RefreshGraceSeconds", 15));

    public static string Hash(string raw) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant();

    public async Task<string> IssueAsync(string userId, CancellationToken ct)
    {
        var (entity, raw) = Create(userId);
        db.RefreshTokens.Add(entity);
        await db.SaveChangesAsync(ct);
        var old = DateTime.UtcNow.AddDays(-1);
        await db.RefreshTokens.Where(t => t.ExpiresAt < old).ExecuteDeleteAsync(ct);   // уборка просроченных
        return raw;
    }

    public async Task<(User User, string Raw)?> RotateAsync(string raw, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var hash = Hash(raw);
        var token = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct);
        if (token is null || token.ExpiresAt <= now) return null;

        if (token.RevokedAt is { } revokedAt)
        {
            var benignRace = token.ReplacedById is not null && now - revokedAt <= Grace;
            if (!benignRace)
            {
                // Повторное предъявление отозванного токена — признак кражи: отзываем все сессии пользователя.
                await db.RefreshTokens.Where(t => t.UserId == token.UserId && t.RevokedAt == null)
                    .ExecuteUpdateAsync(u => u.SetProperty(t => t.RevokedAt, now), ct);
                return null;
            }
        }

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == token.UserId, ct);
        if (user is null) return null;

        var (next, nextRaw) = Create(token.UserId);
        db.RefreshTokens.Add(next);
        if (token.RevokedAt is null)
        {
            token.RevokedAt = now;
            token.ReplacedById = next.Id;
        }
        await db.SaveChangesAsync(ct);
        return (user, nextRaw);
    }

    public async Task RevokeAsync(string? raw, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(raw)) return;
        var hash = Hash(raw);
        var now = DateTime.UtcNow;
        await db.RefreshTokens.Where(t => t.TokenHash == hash && t.RevokedAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.RevokedAt, now), ct);
    }

    private (RefreshToken Entity, string Raw) Create(string userId)
    {
        var raw = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var now = DateTime.UtcNow;
        return (new RefreshToken { UserId = userId, TokenHash = Hash(raw), CreatedAt = now, ExpiresAt = now.AddDays(options.Value.RefreshTokenDays) }, raw);
    }
}
