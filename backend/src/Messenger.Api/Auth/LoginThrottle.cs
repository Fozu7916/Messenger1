using System.Collections.Concurrent;

namespace Messenger.Api.Auth;

/// <summary>Блокирует перебор пароля к одному аккаунту, даже если запросы идут с разных IP.</summary>
public sealed class LoginThrottle(IConfiguration config)
{
    private readonly int _max = config.GetValue("Auth:MaxFailedLogins", 10);
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(15);
    private readonly ConcurrentDictionary<string, (int Count, DateTime Start)> _fails = new();

    public bool IsBlocked(string key, out TimeSpan retryAfter)
    {
        retryAfter = TimeSpan.Zero;
        if (!_fails.TryGetValue(key, out var e)) return false;
        var left = e.Start + Window - DateTime.UtcNow;
        if (left <= TimeSpan.Zero) { _fails.TryRemove(key, out _); return false; }
        retryAfter = left;
        return e.Count >= _max;
    }

    public void Fail(string key)
    {
        var now = DateTime.UtcNow;
        _fails.AddOrUpdate(key, (1, now), (_, e) => now - e.Start > Window ? (1, now) : (e.Count + 1, e.Start));
        if (_fails.Count > 50_000)
            foreach (var k in _fails.Where(p => now - p.Value.Start > Window).Select(p => p.Key).ToList()) _fails.TryRemove(k, out _);
    }

    public void Reset(string key) => _fails.TryRemove(key, out _);
}
