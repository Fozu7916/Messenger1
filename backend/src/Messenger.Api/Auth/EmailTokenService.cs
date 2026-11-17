using System.Security.Cryptography;
using Messenger.Api.Data;
using Messenger.Api.Domain;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace Messenger.Api.Auth;

public static class EmailTokenPurpose
{
    public const string Confirm = "confirm";
    public const string Reset = "reset";
}

public interface IEmailTokenService
{
    /// <summary>Выдаёт новый токен (старые неиспользованные того же назначения гасятся). null — слишком частый запрос, письмо слать не нужно.</summary>
    Task<string?> IssueAsync(string userId, string purpose, CancellationToken ct);
    /// <summary>Атомарно «сжигает» токен и возвращает владельца. null — токен неизвестен, просрочен или уже использован.</summary>
    Task<User?> ConsumeAsync(string raw, string purpose, CancellationToken ct);
}

public sealed class EmailTokenService(AppDbContext db, IConfiguration config) : IEmailTokenService
{
    private TimeSpan Ttl(string purpose) => purpose == EmailTokenPurpose.Reset
        ? TimeSpan.FromMinutes(config.GetValue("Auth:ResetTokenMinutes", 30))
        : TimeSpan.FromHours(config.GetValue("Auth:ConfirmTokenHours", 24));

    public async Task<string?> IssueAsync(string userId, string purpose, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var cooldown = now - TimeSpan.FromSeconds(config.GetValue("Auth:EmailCooldownSeconds", 60));
        if (await db.EmailTokens.AnyAsync(t => t.UserId == userId && t.Purpose == purpose && t.CreatedAt > cooldown, ct))
            return null;

        await db.EmailTokens.Where(t => t.UserId == userId && t.Purpose == purpose && t.UsedAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.UsedAt, now), ct);

        var raw = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        db.EmailTokens.Add(new EmailToken
        {
            UserId = userId,
            Purpose = purpose,
            TokenHash = RefreshTokenService.Hash(raw),
            CreatedAt = now,
            ExpiresAt = now + Ttl(purpose),
        });
        await db.SaveChangesAsync(ct);
        return raw;
    }

    public async Task<User?> ConsumeAsync(string raw, string purpose, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var hash = RefreshTokenService.Hash(raw);
        var token = await db.EmailTokens.AsNoTracking().FirstOrDefaultAsync(t => t.TokenHash == hash && t.Purpose == purpose, ct);
        if (token is null || token.UsedAt is not null || token.ExpiresAt <= now) return null;

        // Условие UsedAt IS NULL делает «сжигание» атомарным: два параллельных запроса не пройдут оба.
        var claimed = await db.EmailTokens.Where(t => t.Id == token.Id && t.UsedAt == null)
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.UsedAt, now), ct);
        return claimed == 0 ? null : await db.Users.FirstOrDefaultAsync(u => u.Id == token.UserId, ct);
    }
}
