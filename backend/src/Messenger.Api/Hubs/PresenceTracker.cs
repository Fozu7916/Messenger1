namespace Messenger.Api.Hubs;

public interface IPresenceTracker
{
    /// <returns>true, если пользователь только что стал онлайн (первое соединение).</returns>
    bool UserConnected(string userId, string connectionId);
    /// <returns>true, если пользователь только что стал офлайн (закрыто последнее соединение).</returns>
    bool UserDisconnected(string userId, string connectionId);
    /// <summary>Есть ли у пользователя хотя бы одно активное соединение.</summary>
    bool IsOnline(string userId);
}

/// <summary>
/// Временная реализация в памяти процесса. При нескольких инстансах бэкенда нужна версия на Redis
/// (ключи с TTL, как в документации) — интерфейс уже под это выделен.
/// </summary>
public sealed class InMemoryPresenceTracker : IPresenceTracker
{
    private readonly Dictionary<string, HashSet<string>> _connections = new();
    private readonly object _lock = new();

    public bool UserConnected(string userId, string connectionId)
    {
        lock (_lock)
        {
            if (!_connections.TryGetValue(userId, out var set))
                _connections[userId] = set = new HashSet<string>();
            set.Add(connectionId);
            return set.Count == 1;
        }
    }

    public bool IsOnline(string userId)
    {
        lock (_lock) return _connections.ContainsKey(userId);
    }

    public bool UserDisconnected(string userId, string connectionId)
    {
        lock (_lock)
        {
            if (!_connections.TryGetValue(userId, out var set)) return false;
            set.Remove(connectionId);
            if (set.Count > 0) return false;
            _connections.Remove(userId);
            return true;
        }
    }
}

/// <summary>
/// Присутствие в Redis для нескольких инстансов: sorted set соединений на пользователя, score = момент протухания.
/// Каждый инстанс раз в 30 с продлевает свои соединения; при падении инстанса записи сами протухают за 90 с.
/// </summary>
public sealed class RedisPresenceTracker(StackExchange.Redis.IConnectionMultiplexer mux) : IPresenceTracker, IHostedService, IDisposable
{
    private const int TtlSeconds = 90;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> _local = new();   // connectionId → userId
    private Timer? _timer;

    private const string ConnectScript = @"
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local n = redis.call('ZCARD', KEYS[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
if n == 0 then return 1 else return 0 end";
    private const string DisconnectScript = @"
redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then return 1 else return 0 end";

    private static string Key(string userId) => "presence:" + userId;
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeSeconds();

    public bool UserConnected(string userId, string connectionId)
    {
        _local[connectionId] = userId;
        var r = mux.GetDatabase().ScriptEvaluate(ConnectScript, [Key(userId)], [Now, Now + TtlSeconds, connectionId, TtlSeconds * 2]);
        return (long)r == 1;
    }

    public bool UserDisconnected(string userId, string connectionId)
    {
        _local.TryRemove(connectionId, out _);
        var r = mux.GetDatabase().ScriptEvaluate(DisconnectScript, [Key(userId)], [Now, connectionId]);
        return (long)r == 1;
    }

    public bool IsOnline(string userId) =>
        mux.GetDatabase().SortedSetLength(Key(userId), Now, double.PositiveInfinity) > 0;

    public Task StartAsync(CancellationToken ct)
    {
        _timer = new Timer(_ => Heartbeat(), null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
        return Task.CompletedTask;
    }

    private void Heartbeat()
    {
        try
        {
            var db = mux.GetDatabase();
            var exp = Now + TtlSeconds;
            foreach (var (cid, uid) in _local)
                db.SortedSetAdd(Key(uid), cid, exp, StackExchange.Redis.When.Exists);
        }
        catch { /* Redis временно недоступен — повторим через 30 с */ }
    }

    public Task StopAsync(CancellationToken ct) { _timer?.Change(Timeout.Infinite, 0); return Task.CompletedTask; }
    public void Dispose() => _timer?.Dispose();
}
