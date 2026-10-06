using Dapper;
using Npgsql;
using Messenger.Domain.Entities;

namespace Messenger.Infrastructure.Persistence.Repositories;

public sealed class MessageRepository
{
    private readonly string _connectionString;

    public MessageRepository(string connectionString)
    {
        _connectionString = connectionString;
    }

    public async Task AddAsync(
        Message message,
        CancellationToken cancellationToken = default)
    {
    const string sql = """
        INSERT INTO messages
            ("Id", "ConversationId", "SenderId", "Content", "CreatedAt")
        VALUES
            (@Id, @ConversationId, @SenderId, @Content, @CreatedAt);
        """;

        await using var connection = new NpgsqlConnection(_connectionString);

        await connection.OpenAsync(cancellationToken);

        await connection.ExecuteAsync(
            new CommandDefinition(
                sql,
                message,
                cancellationToken: cancellationToken));
    }
}