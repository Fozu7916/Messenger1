using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Messenger.Api.Domain;
using Messenger.Api.Hubs;
using Messenger.Api.Messages;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Messenger.Api.Controllers;

[ApiController, Route("api/dialogs"), Authorize]
public sealed class DialogsController(AppDbContext db, IMessageRepository messages, IDialogAccess access, IHubContext<ChatHub> hub) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<List<DialogDto>>> List(CancellationToken ct)
    {
        var me = User.GetUserId();

        var rows = await db.Dialogs.AsNoTracking()
            .Where(d => d.Members.Any(m => m.UserId == me))
            .Select(d => new
            {
                d.Id,
                d.CreatedAt,
                Peer = d.Members.Where(m => m.UserId != me)
                    .Select(m => new { m.User.Id, m.User.Login, m.User.DisplayName, m.User.AvatarUrl })
                    .FirstOrDefault(),
                PeerRead = d.Members.Where(m => m.UserId != me).Select(m => m.LastReadId).FirstOrDefault(),
                Last = d.Messages.Where(m => m.DeletedAt == null && !db.MessageHides.Any(h => h.MessageId == m.Id && h.UserId == me))
                    .OrderByDescending(m => m.Id)
                    .Select(m => new { m.Id, m.ClientMessageId, m.DialogId, m.SenderId, m.Text, m.MediaUrl, m.CreatedAt, m.EditedAt })
                    .FirstOrDefault(),
            })
            .ToListAsync(ct);

        var unread = await messages.GetUnreadCountsAsync(me, ct);

        return rows
            .Select(r => new DialogDto(
                r.Id,
                r.CreatedAt,
                r.Peer is null ? null : new UserDto(r.Peer.Id, r.Peer.Login, r.Peer.DisplayName, r.Peer.AvatarUrl),
                r.Last is null ? null : new MessageDto(r.Last.Id, r.Last.ClientMessageId, r.Last.DialogId,
                    r.Last.SenderId, r.Last.Text, r.Last.MediaUrl, r.Last.CreatedAt, r.Last.EditedAt),
                unread.TryGetValue(r.Id, out var n) ? n : 0,
                r.PeerRead))
            .OrderByDescending(d => d.LastMessage?.CreatedAt ?? d.CreatedAt)
            .ToList();
    }

    /// <summary>Создаёт личный диалог. Если диалог с этим пользователем уже есть — возвращает его (200).</summary>
    [HttpPost]
    public async Task<ActionResult<DialogDto>> Create(CreateDialogRequest req, CancellationToken ct)
    {
        var me = User.GetUserId();
        if (req.UserId == me)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Cannot create a dialog with yourself");

        var peer = await db.Users.AsNoTracking()
            .Where(u => u.Id == req.UserId)
            .Select(u => new UserDto(u.Id, u.Login, u.DisplayName, u.AvatarUrl))
            .FirstOrDefaultAsync(ct);
        if (peer is null) return NotFound();

        // Оба собеседника могут открыть диалог одновременно (или клиент повторит запрос после обрыва сети).
        // Транзакционная advisory-блокировка на пару участников сериализует «проверить → создать» и не даёт дублей.
        var pair = string.CompareOrdinal(me, req.UserId) < 0 ? $"{me}:{req.UserId}" : $"{req.UserId}:{me}";
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock(hashtextextended({pair}, 0))", ct);

        var existing = await db.Dialogs.AsNoTracking()
            .Where(d => d.Members.Any(m => m.UserId == me) && d.Members.Any(m => m.UserId == req.UserId))
            .FirstOrDefaultAsync(ct);
        if (existing is not null)
            return Ok(new DialogDto(existing.Id, existing.CreatedAt, peer, null));

        var now = DateTime.UtcNow;
        var pairKey = string.CompareOrdinal(me, req.UserId) < 0 ? $"{me}:{req.UserId}" : $"{req.UserId}:{me}";
        var dialog = new Dialog
        {
            CreatedAt = now,
            PairKey = pairKey,
            Members =
            {
                new DialogMember { UserId = me, JoinedAt = now },
                new DialogMember { UserId = req.UserId, JoinedAt = now },
            },
        };
        db.Dialogs.Add(dialog);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        return Created($"/api/dialogs/{dialog.Id}", new DialogDto(dialog.Id, dialog.CreatedAt, peer, null));
    }

    /// <summary>Удаляет диалог целиком (вместе с сообщениями — каскадом в БД) у обоих участников.</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var me = User.GetUserId();
        var members = await access.GetMemberIdsAsync(id, ct);
        if (!members.Contains(me)) return NotFound();

        await db.Dialogs.Where(d => d.Id == id).ExecuteDeleteAsync(ct);
        // Собеседник (и другие устройства удалившего) убирают диалог сразу, а не при следующей синхронизации.
        await hub.Clients.Users(members).SendAsync("DialogDeleted", id, ct);
        return NoContent();
    }
}
