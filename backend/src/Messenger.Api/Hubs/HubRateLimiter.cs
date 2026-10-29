using System.Collections.Concurrent;

namespace Messenger.Api.Hubs;

/// <summary>Простой счётчик «не более N вызовов за окно» на ключ (пользователь + действие).</summary>
public sealed class HubRateLimiter
{
    private readonly ConcurrentDictionary<string, (long Start, int Count)> _w = new();

    public bool TryAcquire(string key, int limit, TimeSpan window)
    {
        var now = Environment.TickCount64;
        var ms = (long)window.TotalMilliseconds;
        var allowed = true;
        _w.AddOrUpdate(key, (now, 1), (_, e) =>
        {
            if (now - e.Start >= ms) return (now, 1);
            if (e.Count >= limit) { allowed = false; return e; }
            return (e.Start, e.Count + 1);
        });
        if (_w.Count > 50_000)
            foreach (var k in _w.Where(p => now - p.Value.Start > 600_000).Select(p => p.Key).ToList()) _w.TryRemove(k, out _);
        return allowed;
    }
}
