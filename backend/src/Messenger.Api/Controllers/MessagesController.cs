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

        var items = await messages.GetAsync(dialogId, after, before, Math.Clamp(limit, 1, 100), ct);
        return Ok(items);
    }

    /// <summary>Мягкое удаление; удалять можно только свои сообщения.</summary>
    [HttpDelete("api/messages/{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var me = User.GetUserId();

        var dialogId = await db.Messages.AsNoTracking()
            .Where(m => m.Id == id && m.SenderId == me && m.DeletedAt == null)
            .Select(m => m.DialogId)
            .FirstOrDefaultAsync(ct);
        if (dialogId is null) return NotFound();

        await db.Messages.Where(m => m.Id == id)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.DeletedAt, (DateTime?)DateTime.UtcNow), ct);

        var members = await access.GetMemberIdsAsync(dialogId, ct);
        await hub.Clients.Users(members).SendAsync("MessageDeleted", dialogId, id, ct);

        return NoContent();
    }
}
