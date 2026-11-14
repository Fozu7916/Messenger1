using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Messenger.Api.Domain;
using Messenger.Api.Messages;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Messenger.Api.Hubs;
using Messenger.Api.Media;
using Messenger.Api.Storage;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Messenger.Api.Controllers;

[ApiController, Route("api/dialogs"), Authorize, EnableRateLimiting("users")]
public sealed class DialogsController(AppDbContext db, IMessageRepository messages, IDialogAccess access, IFileStorage storage,
    IHubContext<ChatHub> hub, ILogger<DialogsController> log) : ControllerBase
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
                d.Kind,
                d.Title,
                d.AvatarUrl,
                MemberCount = d.Members.Count,
                MyRole = d.Members.Where(m => m.UserId == me).Select(m => m.Role).FirstOrDefault(),
                Peer = d.Members.Where(m => m.UserId != me)
                    .Select(m => new { m.User.Id, m.User.Login, m.User.DisplayName, m.User.AvatarUrl })
                    .FirstOrDefault(),
                PeerRead = d.Members.Where(m => m.UserId != me).Select(m => m.LastReadId).FirstOrDefault(),
                Last = d.Messages.Where(m => m.DeletedAt == null && !db.MessageHides.Any(h => h.MessageId == m.Id && h.UserId == me))
                    .OrderByDescending(m => m.Id)
                    .Select(m => new { m.Id, m.ClientMessageId, m.DialogId, m.SenderId, m.Text, m.MediaUrl, m.CreatedAt, m.EditedAt, m.ReplyToId, m.ForwardedFromId, m.ForwardedFromName, m.Kind, m.MediaWidth, m.MediaHeight, m.MediaDurationMs })
                    .FirstOrDefault(),
            })
            .ToListAsync(ct);

        var unread = await messages.GetUnreadCountsAsync(me, ct);

        return rows
            .Select(r => new DialogDto(
                r.Id,
                r.CreatedAt,
                // у беседы «собеседник» синтетический (id = id беседы, имя = название): так весь интерфейс показывает название и аватар без особых случаев
                r.Kind == "group" ? new UserDto(r.Id, "", r.Title ?? "Беседа", r.AvatarUrl)
                    : r.Peer is null ? null : new UserDto(r.Peer.Id, r.Peer.Login, r.Peer.DisplayName, r.Peer.AvatarUrl),
                r.Last is null ? null : new MessageDto(r.Last.Id, r.Last.ClientMessageId, r.Last.DialogId,
                    r.Last.SenderId, r.Last.Text, r.Last.MediaUrl, r.Last.CreatedAt, r.Last.EditedAt,
                    r.Last.ReplyToId, r.Last.ForwardedFromId, r.Last.ForwardedFromName, r.Last.Kind, r.Last.MediaWidth, r.Last.MediaHeight, r.Last.MediaDurationMs),
                unread.TryGetValue(r.Id, out var n) ? n : 0,
                r.Kind == "group" ? null : r.PeerRead,
                r.Kind, r.Title, r.MemberCount, r.MyRole ?? "member"))
            .OrderByDescending(d => d.LastMessage?.CreatedAt ?? d.CreatedAt)
            .ToList();
    }

    /// <summary>
    /// Создаёт личный диалог. Если диалог с этим пользователем уже есть — возвращает его (200).
    /// </summary>
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

        var existing = await db.Dialogs.AsNoTracking()
            .Where(d => d.Kind == "direct" && d.Members.Any(m => m.UserId == me) && d.Members.Any(m => m.UserId == req.UserId))
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
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: Npgsql.PostgresErrorCodes.UniqueViolation })
        {
            // Параллельный запрос уже создал диалог этой пары — возвращаем его.
            db.ChangeTracker.Clear();
            var race = await db.Dialogs.AsNoTracking().FirstAsync(d => d.PairKey == pairKey, ct);
            return Ok(new DialogDto(race.Id, race.CreatedAt, peer, null));
        }

        return Created($"/api/dialogs/{dialog.Id}", new DialogDto(dialog.Id, dialog.CreatedAt, peer, null));
    }

    /// <summary>Удаляет диалог целиком (вместе с сообщениями — каскадом в БД) у обоих участников.</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var me = User.GetUserId();
        var info = await db.Dialogs.AsNoTracking().Where(d => d.Id == id && d.Members.Any(m => m.UserId == me))
            .Select(d => new { d.Kind, Role = d.Members.Where(m => m.UserId == me).Select(m => m.Role).First() })
            .FirstOrDefaultAsync(ct);
        if (info is null) return NotFound();
        if (info.Kind == "group" && info.Role != "owner")
            return Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only the owner can delete a group; leave it instead");
        var members = await access.GetMemberIdsAsync(id, ct);
        await db.Dialogs.Where(d => d.Id == id).ExecuteDeleteAsync(ct);
        await storage.DeleteDialogMediaAsync(id, log);
        await hub.Clients.Users(members).SendAsync("DialogsChanged", ct);   // у остальных диалог исчезает сразу, а не при следующей синхронизации
        return NoContent();
    }
}
