using Dapper;
using Messenger.Api.Contracts;
using Npgsql;

namespace Messenger.Api.Messages;

/// <summary>Высокочастотные операции с сообщениями — прямой SQL через Dapper (CQRS-подход).</summary>
public sealed class MessageRepository(NpgsqlDataSource dataSource) : IMessageRepository
{
    // Алиасы нужны, чтобы Dapper сопоставил snake_case-колонки с параметрами конструктора MessageDto.
    private const string Columns =
        "id AS Id, client_message_id AS ClientMessageId, dialog_id AS DialogId, sender_id AS SenderId, " +
        "text AS Text, media_url AS MediaUrl, created_at AS CreatedAt, edited_at AS EditedAt";

    // created_at проставляет БД (now()): единые часы для всех инстансов бэкенда.
    // NB: при партиционировании messages уникальный индекс должен включать ключ партиции.
    private const string InsertSql = $"""
        INSERT INTO messages (id, client_message_id, dialog_id, sender_id, text, media_url)
        VALUES (@Id, @ClientMessageId, @DialogId, @SenderId, @Text, @MediaUrl)
        ON CONFLICT (sender_id, client_message_id) DO NOTHING
        RETURNING {Columns};
        """;

    private const string SelectExistingSql = $"""
        SELECT {Columns} FROM messages
        WHERE sender_id = @SenderId AND client_message_id = @ClientMessageId;
        """;

    public async Task<SaveResult> SaveAsync(NewMessage message, CancellationToken ct = default)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);

        var inserted = await conn.QuerySingleOrDefaultAsync<MessageDto>(
            new CommandDefinition(InsertSql, message, cancellationToken: ct));
        if (inserted is not null)
            return new SaveResult(inserted, IsNew: true);

        var existing = await conn.QuerySingleAsync<MessageDto>(
            new CommandDefinition(SelectExistingSql, message, cancellationToken: ct));
        return new SaveResult(existing, IsNew: false);
    }

    public async Task<IReadOnlyList<MessageDto>> GetAsync(
        string dialogId, string userId, string? after, string? before, int limit, CancellationToken ct = default)
    {
        var (condition, order) = (after, before) switch
        {
            ({ }, _) => ("AND id > @after", "ASC"),
            (_, { }) => ("AND id < @before", "DESC"),
            _ => ("", "DESC"),
        };

        var sql = $"""
            SELECT {Columns} FROM messages
            WHERE dialog_id = @dialogId AND deleted_at IS NULL {condition}
              AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = messages.id AND h.user_id = @userId)
            ORDER BY id {order}
            LIMIT @limit;
            """;

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = (await conn.QueryAsync<MessageDto>(
            new CommandDefinition(sql, new { dialogId, userId, after, before, limit }, cancellationToken: ct))).ToList();

        if (order == "DESC") rows.Reverse();
        return rows;
    }

    public async Task<IReadOnlyDictionary<string, int>> GetUnreadCountsAsync(string userId, CancellationToken ct = default)
    {
        const string sql = """
            SELECT m.dialog_id AS DialogId, COUNT(*) AS Count
            FROM messages m
            JOIN dialog_members dm ON dm.dialog_id = m.dialog_id AND dm.user_id = @userId
            WHERE m.sender_id <> @userId
              AND m.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = @userId)
              AND (dm.last_read_id IS NULL OR m.id > dm.last_read_id)
            GROUP BY m.dialog_id;
            """;

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<UnreadRow>(new CommandDefinition(sql, new { userId }, cancellationToken: ct));
        return rows.ToDictionary(r => r.DialogId, r => (int)r.Count);
    }

    public async Task<string?> MarkReadAsync(string dialogId, string userId, string upToId, CancellationToken ct = default)
    {
        // Берём ближайшее существующее сообщение не позже upToId: нельзя «прочитать» то, чего ещё нет.
        const string sql = """
            WITH target AS (
                SELECT MAX(id) AS id FROM messages WHERE dialog_id = @dialogId AND id <= @upToId
            )
            UPDATE dialog_members dm
            SET last_read_id = target.id
            FROM target
            WHERE dm.dialog_id = @dialogId AND dm.user_id = @userId
              AND target.id IS NOT NULL
              AND (dm.last_read_id IS NULL OR dm.last_read_id < target.id)
            RETURNING dm.last_read_id;
            """;

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<string?>(
            new CommandDefinition(sql, new { dialogId, userId, upToId }, cancellationToken: ct));
    }

    public async Task<IReadOnlyList<MessageDto>> SearchAsync(
        string userId, string query, string? dialogId, string? before, int limit, CancellationToken ct = default)
    {
        var pattern = "%" + query.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
        var conditions = new List<string>();
        if (dialogId is not null) conditions.Add("AND dialog_id = @dialogId");
        if (before is not null) conditions.Add("AND id < @before");

        var sql = $"""
            SELECT {Columns} FROM messages
            WHERE deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = messages.id AND h.user_id = @userId)
              AND dialog_id IN (SELECT dialog_id FROM dialog_members WHERE user_id = @userId)
              AND text ILIKE @pattern ESCAPE '\'
              {string.Join(' ', conditions)}
            ORDER BY id DESC
            LIMIT @limit;
            """;

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<MessageDto>(
            new CommandDefinition(sql, new { userId, pattern, dialogId, before, limit }, cancellationToken: ct));
        return rows.ToList();
    }
}

internal sealed record UnreadRow(string DialogId, long Count);
