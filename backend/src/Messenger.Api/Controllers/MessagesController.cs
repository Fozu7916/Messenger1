using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Messenger.Api.Hubs;
using Messenger.Api.Messages;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Messenger.Api.Controllers;

[ApiController, Authorize, EnableRateLimiting("users")]
public sealed class MessagesController(
    AppDbContext db,
    IMessageRepository messages,
    IDialogAccess access,
    IHubContext<ChatHub> hub) : ControllerBase
{
    /// <summary>
    /// История и дельта-синхронизация. Всегда возвращает сообщения по возрастанию ULID.
    /// ?after=ULID — только новее; ?before=ULID — только старее; без параметров — последние limit.
    /// Удалённые сообщения не возвращаются.
    /// </summary>
    [HttpGet("api/dialogs/{dialogId}/messages")]
    public async Task<ActionResult<IReadOnlyList<MessageDto>>> GetHistory(
        string dialogId,
        [FromQuery] string? after,
        [FromQuery] string? before,
        [FromQuery] int limit = 50,
        CancellationToken ct = default)
    {
        // 404, а не 403 — не раскрываем существование чужих диалогов
        if (!await access.IsMemberAsync(dialogId, User.GetUserId(), ct))
            return NotFound();

        if (after is not null && before is not null)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Use either 'after' or 'before', not both");
        if ((after is not null && !Ulid.TryParse(after, out _)) || (before is not null && !Ulid.TryParse(before, out _)))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "'after'/'before' must be a valid ULID");

        var items = await messages.GetAsync(dialogId, User.GetUserId(), after, before, Math.Clamp(limit, 1, 100), ct);
        return Ok(items);
    }

    /// <summary>
    /// Поиск по тексту сообщений (не людей — для них /api/users/search) во всех своих диалогах или в одном (dialogId).
    /// Запрос разбивается на слова: в сообщении должны встретиться все, в любом порядке. Минимум 2 символа.
    /// Результат — от новых к старым; before=ULID последнего элемента отдаёт следующую страницу.
    /// </summary>
    [HttpGet("api/messages/search")]
    public async Task<ActionResult<IReadOnlyList<MessageDto>>> Search(
        [FromQuery] string? q,
        [FromQuery] string? dialogId,
        [FromQuery] string? before,
        [FromQuery] int limit = 30,
        CancellationToken ct = default)
    {
        var query = q?.Trim() ?? "";
        if (query.Length < 2)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "q must be at least 2 characters");
        if (before is not null && !Ulid.TryParse(before, out _))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "'before' must be a valid ULID");

        var me = User.GetUserId();
        if (dialogId is not null && !await access.IsMemberAsync(dialogId, me, ct))
            return NotFound();

        var tokens = SearchText.Tokens(query);
        var items = await messages.SearchAsync(me, tokens, dialogId, before, Math.Clamp(limit, 1, 50), ct);
        return Ok(items);
    }

    /// <summary>Изменение текста своего сообщения. Остальным участникам уходит событие MessageEdited.</summary>
    [HttpPut("api/messages/{id}")]
    public async Task<ActionResult<MessageDto>> Edit(string id, EditMessageRequest req, CancellationToken ct)
    {
        var text = req.Text.Trim();
        if (text.Length == 0 || text.Length > 4000)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "text must be 1–4000 characters");

        var me = User.GetUserId();
        var msg = await db.Messages.FirstOrDefaultAsync(m => m.Id == id && m.SenderId == me && m.DeletedAt == null, ct);
        if (msg is null) return NotFound();

        var changed = msg.Text != text;
        if (changed)
        {
            msg.Text = text;
            msg.EditedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }

        var dto = new MessageDto(msg.Id, msg.ClientMessageId, msg.DialogId, msg.SenderId, msg.Text, msg.MediaUrl, msg.CreatedAt, msg.EditedAt,
            msg.ReplyToId, msg.ForwardedFromId, msg.ForwardedFromName);
        if (changed)
        {
            var members = await access.GetMemberIdsAsync(msg.DialogId, ct);
            await hub.Clients.Users(members).SendAsync("MessageEdited", dto, ct);
        }
        return dto;
    }

    /// <summary>
    /// Удаление сообщения (как в Telegram). Любой участник диалога может удалить любое сообщение:
    /// scope=me — скрыть только у себя (собеседник сообщение сохраняет), scope=all (по умолчанию) — удалить у обоих.
    /// </summary>
    [HttpDelete("api/messages/{id}")]
    public async Task<IActionResult> Delete(string id, [FromQuery] string scope = "all", CancellationToken ct = default)
    {
        if (scope is not ("me" or "all"))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "scope must be 'me' or 'all'");

        var me = User.GetUserId();

        var dialogId = await db.Messages.AsNoTracking()
            .Where(m => m.Id == id && m.DeletedAt == null)
            .Select(m => m.DialogId)
            .FirstOrDefaultAsync(ct);
        // 404 и для чужого диалога, чтобы не раскрывать существование сообщений
        if (dialogId is null || !await access.IsMemberAsync(dialogId, me, ct)) return NotFound();

        if (scope == "me")
        {
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO message_hides (message_id, user_id) VALUES ({id}, {me}) ON CONFLICT DO NOTHING", ct);
            // остальным устройствам этого же пользователя
            await hub.Clients.User(me).SendAsync("MessageDeleted", dialogId, id, ct);
            return NoContent();
        }

        await db.Messages.Where(m => m.Id == id)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.DeletedAt, (DateTime?)DateTime.UtcNow), ct);
        var unpinned = await db.PinnedMessages.Where(p => p.MessageId == id).ExecuteDeleteAsync(ct);
        var members = await access.GetMemberIdsAsync(dialogId, ct);
        if (unpinned > 0) await hub.Clients.Users(members).SendAsync("MessageUnpinned", dialogId, id, ct);
        await hub.Clients.Users(members).SendAsync("MessageDeleted", dialogId, id, ct);

        return NoContent();
    }

    private const int MaxPins = 10;

    /// <summary>Закреплённые сообщения диалога (видимые мне), сначала закреплённые позже.</summary>
    [HttpGet("api/dialogs/{dialogId}/pins")]
    public async Task<ActionResult<IReadOnlyList<MessageDto>>> GetPins(string dialogId, CancellationToken ct)
    {
        var me = User.GetUserId();
        if (!await access.IsMemberAsync(dialogId, me, ct)) return NotFound();
        return Ok(await messages.GetPinnedAsync(dialogId, me, ct));
    }

    /// <summary>
    /// Закрепляет сообщение для обоих участников (до 10 на диалог, повтор — no-op). Любой участник может закрепить любое сообщение.
    /// Участникам уходит MessagePinned(dialogId, message, pinnedById).
    /// </summary>
    [HttpPut("api/dialogs/{dialogId}/pins/{messageId}")]
    public async Task<IActionResult> Pin(string dialogId, string messageId, CancellationToken ct)
    {
        var me = User.GetUserId();
        if (!await access.IsMemberAsync(dialogId, me, ct)) return NotFound();
        if (!Ulid.TryParse(messageId, out _)) return NotFound();
        var found = await messages.GetByIdsAsync(dialogId, me, [messageId], ct);
        if (found.Count == 0) return NotFound();
        if (await db.PinnedMessages.CountAsync(p => p.DialogId == dialogId, ct) >= MaxPins
            && !await db.PinnedMessages.AnyAsync(p => p.DialogId == dialogId && p.MessageId == messageId, ct))
            return Problem(statusCode: StatusCodes.Status409Conflict, title: $"At most {MaxPins} pinned messages per dialog");

        var added = await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO pinned_messages (dialog_id, message_id, pinned_by_id) VALUES ({dialogId}, {messageId}, {me}) ON CONFLICT DO NOTHING", ct);
        if (added > 0)
        {
            var members = await access.GetMemberIdsAsync(dialogId, ct);
            await hub.Clients.Users(members).SendAsync("MessagePinned", dialogId, found[0], me, ct);
        }
        return NoContent();
    }

    /// <summary>Открепляет сообщение. Участникам уходит MessageUnpinned(dialogId, messageId).</summary>
    [HttpDelete("api/dialogs/{dialogId}/pins/{messageId}")]
    public async Task<IActionResult> Unpin(string dialogId, string messageId, CancellationToken ct)
    {
        var me = User.GetUserId();
        if (!await access.IsMemberAsync(dialogId, me, ct)) return NotFound();
        var removed = await db.PinnedMessages.Where(p => p.DialogId == dialogId && p.MessageId == messageId).ExecuteDeleteAsync(ct);
        if (removed > 0)
        {
            var members = await access.GetMemberIdsAsync(dialogId, ct);
            await hub.Clients.Users(members).SendAsync("MessageUnpinned", dialogId, messageId, ct);
        }
        return NoContent();
    }

    /// <summary>
    /// Пересылка сообщений из диалога dialogId в toDialogId (оба — мои). Копии получают ForwardedFromId/Name оригинального автора
    /// (при повторной пересылке сохраняется первый автор). Идемпотентно по clientBatchId. Получателям уходит MessageReceived.
    /// </summary>
    [HttpPost("api/dialogs/{dialogId}/forward")]
    public async Task<ActionResult<IReadOnlyList<MessageDto>>> Forward(string dialogId, ForwardRequest req, CancellationToken ct)
    {
        var me = User.GetUserId();
        if (!await access.IsMemberAsync(dialogId, me, ct) || !await access.IsMemberAsync(req.ToDialogId, me, ct))
            return NotFound();
        var ids = req.MessageIds.Distinct().ToList();
        if (ids.Any(i => !Ulid.TryParse(i, out _)))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "messageIds must be valid ULIDs");
        var source = await messages.GetByIdsAsync(dialogId, me, ids, ct);
        if (source.Count != ids.Count) return NotFound();

        var authorIds = source.Where(m => m.ForwardedFromId is null).Select(m => m.SenderId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => authorIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);

        var members = await access.GetMemberIdsAsync(req.ToDialogId, ct);
        var result = new List<MessageDto>(source.Count);
        string? prev = null;
        for (var i = 0; i < source.Count; i++)
        {
            var m = source[i];
            // ULID строго возрастает внутри пачки, иначе порядок пересланных сообщений мог бы смешаться в пределах одной миллисекунды
            string id;
            do { id = Ulid.NewUlid().ToString(); } while (prev is not null && string.CompareOrdinal(id, prev) <= 0);
            prev = id;

            var saved = await messages.SaveAsync(new NewMessage(
                Id: id,
                ClientMessageId: $"{req.ClientBatchId}:{i}",
                DialogId: req.ToDialogId,
                SenderId: me,
                Text: m.Text,
                MediaUrl: m.MediaUrl,
                ForwardedFromId: m.ForwardedFromId ?? m.SenderId,
                ForwardedFromName: m.ForwardedFromName ?? (names.TryGetValue(m.SenderId, out var n) ? n : null)), ct);
            result.Add(saved.Message);
            if (saved.IsNew) await hub.Clients.Users(members).SendAsync("MessageReceived", saved.Message, ct);
        }
        return Ok(result);
    }
}
