using Messenger.Api.Contracts;

namespace Messenger.Api.Messages;

public sealed record NewMessage(
    string Id,
    string ClientMessageId,
    string DialogId,
    string SenderId,
    string Text,
    string? MediaUrl);

public sealed record SaveResult(MessageDto Message, bool IsNew);

public interface IMessageRepository
{
    /// <summary>Идемпотентная вставка: повтор с тем же (SenderId, ClientMessageId) вернёт уже сохранённое сообщение.</summary>
    Task<SaveResult> SaveAsync(NewMessage message, CancellationToken ct = default);

    /// <summary>
    /// after  — сообщения новее ULID (по возрастанию), для дельта-синхронизации.
    /// before — сообщения старее ULID, для подгрузки истории вверх.
    /// Без обоих — последние <paramref name="limit"/>. Результат всегда по возрастанию ULID.
    /// </summary>
    Task<IReadOnlyList<MessageDto>> GetAsync(string dialogId, string? after, string? before, int limit, CancellationToken ct = default);
}
