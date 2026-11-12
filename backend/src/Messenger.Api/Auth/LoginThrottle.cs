using System.Collections.Concurrent;

namespace Messenger.Api.Auth;

/// <summary>
/// Блокирует перебор пароля двумя счётчиками: «IP + логин» (по умолчанию 10 неудач) и «аккаунт целиком»
/// (50 неудач, с любых IP). Так чужие неудачные попытки с одного адреса не запирают аккаунт для владельца,
/// а распределённый перебор всё равно упирается в общий потолок.
/// </summary>
public sealed class LoginThrottle(IConfiguration config)
{
    private readonly int _perPair = config.GetValue("Auth:MaxFailedLogins", 10);
    private readonly int _perAccount = config.GetValue("Auth:MaxFailedLoginsPerAccount", 50);
    private static readonly TimeSpan Window = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan SweepEvery = TimeSpan.FromMinutes(1);
    private readonly ConcurrentDictionary<string, (int Count, DateTime Start)> _fails = new();
    private long _nextSweepTicks = DateTime.UtcNow.Add(SweepEvery).Ticks;

    private static string PairKey(string ip, string id) => "p:" + ip + "|" + id;
    private static string AccountKey(string id) => "a:" + id;

    public bool IsBlocked(string ip, string id, out TimeSpan retryAfter)
    {
        retryAfter = TimeSpan.Zero;
        var now = DateTime.UtcNow;
        var a = Check(PairKey(ip, id), _perPair, now, ref retryAfter);
        var b = Check(AccountKey(id), _perAccount, now, ref retryAfter);
        return a || b;
    }

    private bool Check(string key, int max, DateTime now, ref TimeSpan retryAfter)
    {
        if (!_fails.TryGetValue(key, out var e)) return false;
        var left = e.Start + Window - now;
        if (left <= TimeSpan.Zero)
        {
            _fails.TryRemove(key, out _);
            return false;
        }
        if (e.Count < max) return false;
        if (left > retryAfter) retryAfter = left;
        return true;
    }

    public void Fail(string ip, string id)
    {
        var now = DateTime.UtcNow;
        Bump(PairKey(ip, id), now);
        Bump(AccountKey(id), now);
        Sweep(now);
    }

    /// <summary>Успешный вход сбрасывает только счётчик «IP + логин»; общий по аккаунту истекает сам по окну.</summary>
    public void Reset(string ip, string id) => _fails.TryRemove(PairKey(ip, id), out _);

    private void Bump(string key, DateTime now) =>
        _fails.AddOrUpdate(key, (1, now), (_, e) => now - e.Start > Window ? (1, now) : (e.Count + 1, e.Start));

    /// <summary>Уборка устаревших записей не чаще раза в минуту — чтобы поток неудач не превращался в O(n) на каждый запрос.</summary>
    private void Sweep(DateTime now)
    {
        var next = Interlocked.Read(ref _nextSweepTicks);
        if (now.Ticks < next || Interlocked.CompareExchange(ref _nextSweepTicks, now.Add(SweepEvery).Ticks, next) != next) return;
        foreach (var k in _fails.Where(p => now - p.Value.Start > Window).Select(p => p.Key).ToList())
            _fails.TryRemove(k, out _);
    }
}
