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
        "text AS Text, media_url AS MediaUrl, created_at AS CreatedAt";

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
        string dialogId, string? after, string? before, int limit, CancellationToken ct = default)
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
            ORDER BY id {order}
            LIMIT @limit;
            """;

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = (await conn.QueryAsync<MessageDto>(
            new CommandDefinition(sql, new { dialogId, after, before, limit }, cancellationToken: ct))).ToList();

        if (order == "DESC") rows.Reverse();
        return rows;
    }
}
