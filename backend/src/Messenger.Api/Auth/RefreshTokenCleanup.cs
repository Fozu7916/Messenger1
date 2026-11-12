using Messenger.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Messenger.Api.Auth;

/// <summary>Раз в час удаляет refresh-токены, просроченные более суток назад (раньше это делалось на каждом логине).</summary>
public sealed class RefreshTokenCleanup(IServiceScopeFactory scopes, ILogger<RefreshTokenCleanup> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1));
        try
        {
            do
            {
                try
                {
                    await using var scope = scopes.CreateAsyncScope();
                    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                    var old = DateTime.UtcNow.AddDays(-1);
                    var n = await db.RefreshTokens.Where(t => t.ExpiresAt < old).ExecuteDeleteAsync(stoppingToken);
                    if (n > 0) log.LogInformation("Removed {Count} expired refresh tokens", n);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogWarning(ex, "Refresh token cleanup failed");
                }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { }
    }
}
