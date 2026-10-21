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
