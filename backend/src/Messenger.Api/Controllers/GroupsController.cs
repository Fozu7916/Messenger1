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

namespace Messenger.Api.Controllers;

/// <summary>
/// Беседы (групповые чаты): создание, название, участники. Создатель — owner; он может исключать и переименовывать,
/// добавлять участников может любой. О каждом изменении в беседу пишется служебное сообщение, участникам уходит DialogsChanged.
/// </summary>
[ApiController, Route("api/dialogs"), Authorize, EnableRateLimiting("users")]
public sealed class GroupsController(AppDbContext db, IMessageRepository messages, IDialogAccess access, IFileStorage storage,
    IHubContext<ChatHub> hub, ILogger<GroupsController> log) : ControllerBase
{
    private const int MaxMembers = 50;

    [HttpPost("group")]
    public async Task<ActionResult<DialogDto>> Create(CreateGroupRequest req, CancellationToken ct)
    {
        var me = User.GetUserId();
        var title = req.Title.Trim();
        var ids = req.MemberIds.Where(i => i != me).Distinct().ToList();
        if (title.Length == 0 || title.Any(char.IsControl) || ids.Count == 0 || ids.Count > MaxMembers - 1)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: $"Valid title and 1–{MaxMembers - 1} other members are required");
        if (await db.Users.CountAsync(u => ids.Contains(u.Id), ct) != ids.Count)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Some users do not exist");

        var now = DateTime.UtcNow;
        var dialog = new Dialog
        {
            Kind = DialogKind.Group, Title = title, CreatedById = me, CreatedAt = now,
            Members = { new DialogMember { UserId = me, Role = MemberRole.Owner, JoinedAt = now } },
        };
        foreach (var id in ids) dialog.Members.Add(new DialogMember { UserId = id, JoinedAt = now });
        db.Dialogs.Add(dialog);
        await db.SaveChangesAsync(ct);

        await PostSystemAsync(dialog.Id, me, $"{await NameAsync(me, ct)} создал(а) беседу «{title}»", ct);
        await NotifyAsync([me, .. ids], ct);
        return Created($"/api/dialogs/{dialog.Id}", new DialogDto(dialog.Id, dialog.CreatedAt, new UserDto(dialog.Id, "", title, null), null,
            Kind: DialogKind.Group, Title: title, MemberCount: ids.Count + 1, MyRole: MemberRole.Owner));
    }

    /// <summary>Участники беседы (владелец первым).</summary>
    [HttpGet("{id}/members")]
    public async Task<ActionResult<List<MemberDto>>> Members(string id, CancellationToken ct)
    {
        if (!await access.IsMemberAsync(id, User.GetUserId(), ct)) return NotFound();
        return await ListAsync(id, ct);
    }

    [HttpPut("{id}")]
    public async Task<IActionResult> Rename(string id, RenameGroupRequest req, CancellationToken ct)
    {
        var me = User.GetUserId();
        var title = req.Title.Trim();
        var dialog = await db.Dialogs.FirstOrDefaultAsync(d => d.Id == id && d.Kind == DialogKind.Group && d.Members.Any(m => m.UserId == me), ct);
        if (dialog is null) return NotFound();
        if (title.Length == 0 || title.Any(char.IsControl))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Title is required and cannot contain control characters");
        if (!await IsOwnerAsync(id, me, ct)) return Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only the owner can rename the group");
        if (dialog.Title == title) return NoContent();
        dialog.Title = title;
        await db.SaveChangesAsync(ct);
        await PostSystemAsync(id, me, $"{await NameAsync(me, ct)} переименовал(а) беседу в «{title}»", ct);
        await NotifyAsync(await access.GetMemberIdsAsync(id, ct), ct);
        return NoContent();
    }

    /// <summary>Добавить участников (любой участник беседы; всего не больше 50). Уже состоящие пропускаются.</summary>
    [HttpPost("{id}/members")]
    public async Task<ActionResult<List<MemberDto>>> AddMembers(string id, AddMembersRequest req, CancellationToken ct)
    {
        var me = User.GetUserId();
        List<string> current;
        List<string> add;
        List<string> addedNames = [];

        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            var locked = await db.Dialogs
                .FromSqlInterpolated($"SELECT * FROM dialogs WHERE id = {id} AND kind = 'group' FOR UPDATE")
                .AsNoTracking()
                .FirstOrDefaultAsync(ct);
            if (locked is null) return NotFound();

            current = await db.DialogMembers.AsNoTracking()
                .Where(m => m.DialogId == id)
                .Select(m => m.UserId)
                .ToListAsync(ct);
            if (!current.Contains(me)) return NotFound();

            add = req.UserIds.Distinct().Where(u => !current.Contains(u)).ToList();
            if (current.Count + add.Count > MaxMembers)
                return Problem(statusCode: StatusCodes.Status400BadRequest, title: $"At most {MaxMembers} members");

            if (add.Count > 0)
            {
                var users = await db.Users.AsNoTracking()
                    .Where(u => add.Contains(u.Id))
                    .Select(u => new { u.Id, u.DisplayName })
                    .ToListAsync(ct);
                if (users.Count != add.Count)
                    return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Some users do not exist");

                addedNames = users.Select(u => u.DisplayName).ToList();
                db.DialogMembers.AddRange(add.Select(u => new DialogMember { DialogId = id, UserId = u }));
                await db.SaveChangesAsync(ct);
            }

            await tx.CommitAsync(ct);
        }

        if (add.Count > 0)
        {
            await PostSystemAsync(id, me, $"{await NameAsync(me, ct)} добавил(а): {string.Join(", ", addedNames)}", ct);
            await NotifyAsync([.. current, .. add], ct);
        }
        return await ListAsync(id, ct);
    }

    /// <summary>
    /// Выйти из беседы (userId = «me» или свой id) или исключить участника (только владелец). Если ушёл владелец,
    /// его роль получает самый ранний участник; если ушёл последний — беседа удаляется.
    /// </summary>
    [HttpDelete("{id}/members/{userId}")]
    public async Task<IActionResult> RemoveMember(string id, string userId, CancellationToken ct)
    {
        var me = User.GetUserId();
        var target = userId == "me" ? me : userId;

        List<string> everyone;
        bool deletedGroup;
        string systemText = "";

        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            var locked = await db.Dialogs
                .FromSqlInterpolated($"SELECT * FROM dialogs WHERE id = {id} AND kind = 'group' FOR UPDATE")
                .AsNoTracking()
                .FirstOrDefaultAsync(ct);
            if (locked is null) return NotFound();

            var rows = await db.DialogMembers.AsNoTracking()
                .Where(m => m.DialogId == id)
                .Select(m => new { m.UserId, m.Role, m.JoinedAt, Name = m.User.DisplayName })
                .ToListAsync(ct);
            var mine = rows.FirstOrDefault(r => r.UserId == me);
            var theirs = rows.FirstOrDefault(r => r.UserId == target);
            if (mine is null || theirs is null) return NotFound();
            if (target != me && mine.Role != MemberRole.Owner)
                return Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only the owner can remove members");

            await db.DialogMembers.Where(m => m.DialogId == id && m.UserId == target).ExecuteDeleteAsync(ct);
            var remaining = rows.Where(r => r.UserId != target).ToList();
            everyone = rows.Select(r => r.UserId).ToList();

            if (remaining.Count == 0)
            {
                await db.Dialogs.Where(d => d.Id == id).ExecuteDeleteAsync(ct);
                deletedGroup = true;
            }
            else
            {
                deletedGroup = false;
                if (theirs.Role == MemberRole.Owner)
                {
                    var heir = remaining.OrderBy(r => r.JoinedAt).First().UserId;
                    await db.DialogMembers.Where(m => m.DialogId == id && m.UserId == heir)
                        .ExecuteUpdateAsync(s => s.SetProperty(m => m.Role, MemberRole.Owner), ct);
                }
                systemText = target == me ? $"{mine.Name} вышел(ла) из беседы" : $"{mine.Name} исключил(а) {theirs.Name}";
            }

            await tx.CommitAsync(ct);
        }

        if (deletedGroup)
        {
            await storage.DeleteDialogMediaAsync(id, log);
            await NotifyAsync(everyone, ct);
            return NoContent();
        }

        await PostSystemAsync(id, me, systemText, ct);
        await NotifyAsync(everyone, ct);
        return NoContent();
    }

    // ---------------- помощники ----------------

    private Task<List<MemberDto>> ListAsync(string id, CancellationToken ct) =>
        db.DialogMembers.AsNoTracking().Where(m => m.DialogId == id)
            .OrderBy(m => m.Role == MemberRole.Owner ? 0 : 1).ThenBy(m => m.JoinedAt)
            .Select(m => new MemberDto(new UserDto(m.User.Id, m.User.Login, m.User.DisplayName, m.User.AvatarUrl), m.Role))
            .ToListAsync(ct);

    private Task<bool> IsOwnerAsync(string dialogId, string userId, CancellationToken ct) =>
        db.DialogMembers.AsNoTracking().AnyAsync(m => m.DialogId == dialogId && m.UserId == userId && m.Role == MemberRole.Owner, ct);

    private Task<string> NameAsync(string userId, CancellationToken ct) =>
        db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.DisplayName).FirstAsync(ct);

    /// <summary>Служебное сообщение («Анна добавила Марка»): автор — тот, кто сделал действие; в непрочитанные не считается.</summary>
    private async Task PostSystemAsync(string dialogId, string actorId, string text, CancellationToken ct)
    {
        var id = Ulid.NewUlid().ToString();
        var saved = await messages.SaveAsync(new NewMessage(id, "sys:" + id, dialogId, actorId, text, null, Kind: MessageKind.System), ct);
        await hub.Clients.Users(await access.GetMemberIdsAsync(dialogId, ct)).SendAsync(HubEvents.MessageReceived, saved.Message, ct);
    }

    private Task NotifyAsync(IEnumerable<string> userIds, CancellationToken ct) =>
        hub.Clients.Users(userIds.Distinct().ToList()).SendAsync(HubEvents.DialogsChanged, ct);
}