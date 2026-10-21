using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Messenger.Api.Hubs;
using Messenger.Api.Messages;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Messenger.Api.Controllers;

[ApiController, Authorize]
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
    /// Поиск по тексту сообщений во всех своих диалогах (или в одном — dialogId). Минимум 2 символа.
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

        var items = await messages.SearchAsync(me, query, dialogId, before, Math.Clamp(limit, 1, 50), ct);
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

        var dto = new MessageDto(msg.Id, msg.ClientMessageId, msg.DialogId, msg.SenderId, msg.Text, msg.MediaUrl, msg.CreatedAt, msg.EditedAt);
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

        var members = await access.GetMemberIdsAsync(dialogId, ct);
        await hub.Clients.Users(members).SendAsync("MessageDeleted", dialogId, id, ct);

        return NoContent();
    }
}
