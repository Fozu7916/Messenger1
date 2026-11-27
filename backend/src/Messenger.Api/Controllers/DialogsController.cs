using Dapper;
using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Messenger.Api.Domain;
using Messenger.Api.Hubs;
using Messenger.Api.Media;
using Messenger.Api.Messages;
using Messenger.Api.Storage;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Messenger.Api.Controllers;

[ApiController, Route("api/dialogs"), Authorize, EnableRateLimiting("users")]
public sealed class DialogsController(
    AppDbContext db,
    NpgsqlDataSource dataSource,
    IMessageRepository messages,
    IDialogAccess access,
    IFileStorage storage,
    IHubContext<ChatHub> hub,
    ILogger<DialogsController> log) : ControllerBase
{
    private const string ListSql = """
        SELECT
            d.id AS Id,
            d.created_at AS CreatedAt,
            d.kind AS Kind,
            d.title AS Title,
            d.avatar_url AS DialogAvatarUrl,
            (SELECT COUNT(*) FROM dialog_members dm_cnt WHERE dm_cnt.dialog_id = d.id) AS MemberCount,
            me_m.role AS MyRole,
            peer_u.id AS PeerId,
            peer_u.login AS PeerLogin,
            peer_u.display_name AS PeerDisplayName,
            peer_u.avatar_url AS PeerAvatarUrl,
            peer_m.last_read_id AS PeerLastReadId,
            lm.id AS LastId,
            lm.client_message_id AS LastClientMessageId,
            lm.sender_id AS LastSenderId,
            lm.text AS LastText,
            lm.media_url AS LastMediaUrl,
            lm.created_at AS LastCreatedAt,
            lm.edited_at AS LastEditedAt,
            lm.reply_to_id AS LastReplyToId,
            lm.forwarded_from_id AS LastForwardedFromId,
            lm.forwarded_from_name AS LastForwardedFromName,
            lm.kind AS LastKind,
            lm.media_width AS LastMediaWidth,
            lm.media_height AS LastMediaHeight,
            lm.media_duration_ms AS LastMediaDurationMs
        FROM dialog_members me_m
        JOIN dialogs d ON d.id = me_m.dialog_id
        LEFT JOIN LATERAL (
            SELECT dm.user_id, dm.last_read_id
            FROM dialog_members dm
            WHERE dm.dialog_id = d.id AND dm.user_id <> @me
            LIMIT 1
        ) peer_m ON d.kind = 'direct'
        LEFT JOIN users peer_u ON peer_u.id = peer_m.user_id
        LEFT JOIN LATERAL (
            SELECT m.*
            FROM messages m
            WHERE m.dialog_id = d.id
              AND m.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.message_id = m.id AND h.user_id = @me)
            ORDER BY m.id DESC
            LIMIT 1
        ) lm ON true
        WHERE me_m.user_id = @me
        ORDER BY COALESCE(lm.created_at, d.created_at) DESC, d.id ASC
        LIMIT @limit OFFSET @offset;
        """;

    [HttpGet]
    public async Task<ActionResult<List<DialogDto>>> List([FromQuery] int limit = 100, [FromQuery] int offset = 0, CancellationToken ct = default)
    {
        var me = User.GetUserId();
        limit = Math.Clamp(limit, 1, 200);
        offset = Math.Max(0, offset);

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = (await conn.QueryAsync<DialogListRow>(
            new CommandDefinition(ListSql, new { me, limit, offset }, cancellationToken: ct))).ToList();

        var unread = await messages.GetUnreadCountsAsync(me, ct);

        return rows.Select(r => new DialogDto(
            r.Id,
            r.CreatedAt,
            r.Kind == DialogKind.Group
                ? new UserDto(r.Id, "", r.Title ?? "Беседа", r.DialogAvatarUrl)
                : r.PeerId is null ? null : new UserDto(r.PeerId, r.PeerLogin!, r.PeerDisplayName!, r.PeerAvatarUrl),
            r.LastId is null
                ? null
                : new MessageDto(
                    r.LastId, r.LastClientMessageId!, r.Id, r.LastSenderId!, r.LastText!, r.LastMediaUrl,
                    r.LastCreatedAt!.Value, r.LastEditedAt, r.LastReplyToId, r.LastForwardedFromId,
                    r.LastForwardedFromName, r.LastKind ?? MessageKind.Text, r.LastMediaWidth, r.LastMediaHeight, r.LastMediaDurationMs),
            unread.TryGetValue(r.Id, out var n) ? n : 0,
            r.Kind == DialogKind.Group ? null : r.PeerLastReadId,
            r.Kind,
            r.Title,
            (int)r.MemberCount,
            r.MyRole ?? MemberRole.Member)).ToList();
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
            .Where(d => d.Kind == DialogKind.Direct && d.Members.Any(m => m.UserId == me) && d.Members.Any(m => m.UserId == req.UserId))
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
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
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
        if (info.Kind == DialogKind.Group && info.Role != MemberRole.Owner)
            return Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only the owner can delete a group; leave it instead");
        var members = await access.GetMemberIdsAsync(id, ct);
        await db.Dialogs.Where(d => d.Id == id).ExecuteDeleteAsync(ct);
        await storage.DeleteDialogMediaAsync(id, log);
        await hub.Clients.Users(members).SendAsync(HubEvents.DialogsChanged, ct);
        return NoContent();
    }

    private sealed class DialogListRow
    {
        public string Id { get; init; } = "";
        public DateTime CreatedAt { get; init; }
        public string Kind { get; init; } = DialogKind.Direct;
        public string? Title { get; init; }
        public string? DialogAvatarUrl { get; init; }
        public long MemberCount { get; init; }
        public string? MyRole { get; init; }
        public string? PeerId { get; init; }
        public string? PeerLogin { get; init; }
        public string? PeerDisplayName { get; init; }
        public string? PeerAvatarUrl { get; init; }
        public string? PeerLastReadId { get; init; }
        public string? LastId { get; init; }
        public string? LastClientMessageId { get; init; }
        public string? LastSenderId { get; init; }
        public string? LastText { get; init; }
        public string? LastMediaUrl { get; init; }
        public DateTime? LastCreatedAt { get; init; }
        public DateTime? LastEditedAt { get; init; }
        public string? LastReplyToId { get; init; }
        public string? LastForwardedFromId { get; init; }
        public string? LastForwardedFromName { get; init; }
        public string? LastKind { get; init; }
        public int? LastMediaWidth { get; init; }
        public int? LastMediaHeight { get; init; }
        public int? LastMediaDurationMs { get; init; }
    }
}