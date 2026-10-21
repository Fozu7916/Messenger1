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
    Task<IReadOnlyList<MessageDto>> GetAsync(string dialogId, string userId, string? after, string? before, int limit, CancellationToken ct = default);

    /// <summary>Сколько непрочитанных сообщений собеседников у пользователя в каждом его диалоге (диалоги без непрочитанных не включаются).</summary>
    Task<IReadOnlyDictionary<string, int>> GetUnreadCountsAsync(string userId, CancellationToken ct = default);

    /// <summary>
    /// Отмечает диалог прочитанным до сообщения <paramref name="upToId"/> включительно (на самом деле — до ближайшего существующего).
    /// Назад отметка не двигается. Возвращает новый ULID отметки, если она сдвинулась, иначе null.
    /// </summary>
    Task<string?> MarkReadAsync(string dialogId, string userId, string upToId, CancellationToken ct = default);

    /// <summary>
    /// Полнотекстовый (подстрочный, без учёта регистра) поиск по сообщениям во всех диалогах пользователя
    /// или в одном из них. Результат — от новых к старым; <paramref name="before"/> — курсор для следующей страницы.
    /// </summary>
    Task<IReadOnlyList<MessageDto>> SearchAsync(string userId, string query, string? dialogId, string? before, int limit, CancellationToken ct = default);
}
