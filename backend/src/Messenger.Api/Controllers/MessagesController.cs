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

[ApiController, Authorize, EnableRateLimiting("users")]
public sealed class MessagesController(
    AppDbContext db,
    IMessageRepository messages,
    IFileStorage storage,
    IDialogAccess access,
    IHubContext<ChatHub> hub,
    ILogger<MessagesController> log) : ControllerBase
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
        var msg = await db.Messages.FirstOrDefaultAsync(m => m.Id == id && m.SenderId == me && m.DeletedAt == null && m.Kind != MessageKind.System, ct);
        if (msg is null) return NotFound();

        var changed = msg.Text != text;
        if (changed)
        {
            msg.Text = text;
            msg.EditedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }

        var dto = msg.ToDto();
        if (changed)
        {
            var members = await access.GetMemberIdsAsync(msg.DialogId, ct);
            await hub.Clients.Users(members).SendAsync(HubEvents.MessageEdited, dto, ct);
        }
        return dto;
    }

    /// <summary>
    /// Удаление сообщения: scope=me — скрыть только у себя, scope=all (по умолчанию) — удалить у всех.
    /// В личном диалоге удалить у обоих может любой участник; в беседе — только автор сообщения или владелец беседы.
    /// </summary>
    [HttpDelete("api/messages/{id}")]
    public async Task<IActionResult> Delete(string id, [FromQuery] string scope = "all", CancellationToken ct = default)
    {
        if (scope is not ("me" or "all"))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "scope must be 'me' or 'all'");

        var me = User.GetUserId();

        var msg = await db.Messages.AsNoTracking()
            .Where(m => m.Id == id && m.DeletedAt == null)
            .Select(m => new { m.DialogId, m.SenderId, m.Kind, m.MediaUrl, DialogKind = m.Dialog.Kind })
            .FirstOrDefaultAsync(ct);
        // 404 и для чужого диалога, чтобы не раскрывать существование сообщений
        if (msg is null || !await access.IsMemberAsync(msg.DialogId, me, ct)) return NotFound();

        if (scope == "me")
        {
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"INSERT INTO message_hides (message_id, user_id) VALUES ({id}, {me}) ON CONFLICT DO NOTHING", ct);
            await hub.Clients.User(me).SendAsync(HubEvents.MessageDeleted, msg.DialogId, id, ct);
            return NoContent();
        }

        if (msg.DialogKind == DialogKind.Group)
        {
            if (msg.Kind == MessageKind.System)
                return Problem(statusCode: StatusCodes.Status403Forbidden, title: "System messages cannot be deleted for everyone");
            if (msg.SenderId != me)
            {
                var isOwner = await db.DialogMembers.AsNoTracking()
                    .AnyAsync(m => m.DialogId == msg.DialogId && m.UserId == me && m.Role == MemberRole.Owner, ct);
                if (!isOwner)
                    return Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only the sender or group owner can delete this message for everyone");
            }
        }

        await db.Messages.Where(m => m.Id == id)
            .ExecuteUpdateAsync(s => s.SetProperty(m => m.DeletedAt, (DateTime?)DateTime.UtcNow), ct);
        var unpinned = await db.PinnedMessages.Where(p => p.MessageId == id).ExecuteDeleteAsync(ct);
        if (MediaKeys.Parse(msg.MediaUrl) is { } media)
        {
            try { await storage.DeleteAsync(MediaKeys.Key(media.DialogId, media.Name), ct); }
            catch (Exception ex) { log.LogWarning(ex, "Could not delete media of message {Id}", id); }
        }
        var members = await access.GetMemberIdsAsync(msg.DialogId, ct);
        if (unpinned > 0) await hub.Clients.Users(members).SendAsync(HubEvents.MessageUnpinned, msg.DialogId, id, ct);
        await hub.Clients.Users(members).SendAsync(HubEvents.MessageDeleted, msg.DialogId, id, ct);

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
            await hub.Clients.Users(members).SendAsync(HubEvents.MessagePinned, dialogId, found[0], me, ct);
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
            await hub.Clients.Users(members).SendAsync(HubEvents.MessageUnpinned, dialogId, messageId, ct);
        }
        return NoContent();
    }

    private static readonly string[] AllowedReactions = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

    /// <summary>Реакции диалога (последние 3000): [{messageId, userId, emoji}].</summary>
    [HttpGet("api/dialogs/{dialogId}/reactions")]
    public async Task<IActionResult> GetReactions(string dialogId, CancellationToken ct)
    {
        if (!await access.IsMemberAsync(dialogId, User.GetUserId(), ct)) return NotFound();
        var list = await db.MessageReactions.AsNoTracking().Where(r => r.DialogId == dialogId)
            .OrderByDescending(r => r.CreatedAt).Take(3000)
            .Select(r => new { messageId = r.MessageId, userId = r.UserId, emoji = r.Emoji }).ToListAsync(ct);
        return Ok(list);
    }

    /// <summary>Ставит (или заменяет) мою реакцию. Участникам уходит ReactionChanged(dialogId, messageId, userId, emoji).</summary>
    [HttpPut("api/dialogs/{dialogId}/reactions/{messageId}")]
    public async Task<IActionResult> SetReaction(string dialogId, string messageId, [FromBody] ReactionRequest body, CancellationToken ct)
    {
        var me = User.GetUserId();
        if (!await access.IsMemberAsync(dialogId, me, ct)) return NotFound();
        if (!Ulid.TryParse(messageId, out _)) return NotFound();
        if (!AllowedReactions.Contains(body.Emoji)) return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Unsupported reaction");
        if ((await messages.GetByIdsAsync(dialogId, me, [messageId], ct)).Count == 0) return NotFound();

        await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO message_reactions (message_id, user_id, dialog_id, emoji) VALUES ({messageId}, {me}, {dialogId}, {body.Emoji}) ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()", ct);
        var members = await access.GetMemberIdsAsync(dialogId, ct);
        await hub.Clients.Users(members).SendAsync(HubEvents.ReactionChanged, dialogId, messageId, me, body.Emoji, ct);
        return NoContent();
    }

    /// <summary>Убирает мою реакцию. Участникам уходит ReactionChanged(dialogId, messageId, userId, null).</summary>
    [HttpDelete("api/dialogs/{dialogId}/reactions/{messageId}")]
    public async Task<IActionResult> RemoveReaction(string dialogId, string messageId, CancellationToken ct)
    {
        var me = User.GetUserId();
        if (!await access.IsMemberAsync(dialogId, me, ct)) return NotFound();
        var removed = await db.MessageReactions.Where(r => r.DialogId == dialogId && r.MessageId == messageId && r.UserId == me).ExecuteDeleteAsync(ct);
        if (removed > 0)
        {
            var members = await access.GetMemberIdsAsync(dialogId, ct);
            await hub.Clients.Users(members).SendAsync(HubEvents.ReactionChanged, dialogId, messageId, me, (string?)null, ct);
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
        if (source.Any(m => m.Kind == MessageKind.System)) return Problem(statusCode: StatusCodes.Status400BadRequest, title: "System messages cannot be forwarded");

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

            string? mediaUrl = null;
            if (MediaKeys.Parse(m.MediaUrl) is { } src)
            {
                var ext = Path.GetExtension(src.Name).TrimStart('.');
                var newName = $"{id}.{ext}";
                try
                {
                    // копия на стороне хранилища (файл через API не гоняем); у копии свой файл: удаление оригинала её не ломает
                    await storage.CopyAsync(MediaKeys.Key(src.DialogId, src.Name), MediaKeys.Key(req.ToDialogId, newName), ct);
                    mediaUrl = MediaKeys.Url(req.ToDialogId, newName);
                }
                catch (StorageNotConfiguredException) { return Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "File storage is not available"); }
                catch (Exception ex) when (ex is not OperationCanceledException) { log.LogWarning(ex, "Could not copy media {Key} while forwarding", src.Name); }   // оригинала нет — перешлём без вложения
            }
            var saved = await messages.SaveAsync(new NewMessage(
                Id: id,
                ClientMessageId: $"{req.ClientBatchId}:{i}",
                DialogId: req.ToDialogId,
                SenderId: me,
                Text: m.Text,
                MediaUrl: mediaUrl,
                Kind: mediaUrl is null ? MessageKind.Text : m.Kind,
                MediaWidth: mediaUrl is null ? null : m.MediaWidth,
                MediaHeight: mediaUrl is null ? null : m.MediaHeight,
                MediaDurationMs: mediaUrl is null ? null : m.MediaDurationMs,
                ForwardedFromId: m.ForwardedFromId ?? m.SenderId,
                ForwardedFromName: m.ForwardedFromName ?? (names.TryGetValue(m.SenderId, out var n) ? n : null)), ct);
            result.Add(saved.Message);
            if (saved.IsNew) await hub.Clients.Users(members).SendAsync(HubEvents.MessageReceived, saved.Message, ct);
        }
        return Ok(result);
    }

    private const int MaxMediaUpload = 10 * 1024 * 1024;
    private const int MaxVoiceBytes = 3 * 1024 * 1024;

    /// <summary>
    /// Фото или голосовое сообщение (multipart): file, clientMessageId, kind = image|voice, text (подпись), durationMs, replyToId.
    /// Фото декодируется и перекодируется в WebP до 1600 px, голосовое проверяется по первым байтам (webm/ogg/m4a/mp3, до 3 МБ).
    /// Идемпотентно по clientMessageId. Участникам уходит MessageReceived.
    /// </summary>
    [HttpPost("api/dialogs/{dialogId}/messages/media"), RequestSizeLimit(MaxMediaUpload), RequestFormLimits(MultipartBodyLengthLimit = MaxMediaUpload)]
    public async Task<ActionResult<MessageDto>> SendMedia(string dialogId, [FromForm] SendMediaForm form, CancellationToken ct)
    {
        var me = User.GetUserId();
        if (!await access.IsMemberAsync(dialogId, me, ct)) return NotFound();
        if (form.Kind is not (MessageKind.Image or MessageKind.Voice) || form.File.Length == 0 || form.File.Length > (form.Kind == MessageKind.Voice ? MaxVoiceBytes : MaxMediaUpload))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Send an image (up to 10 MB) or a voice message (up to 3 MB)");
        if (form.ReplyToId is not null && (!Ulid.TryParse(form.ReplyToId, out _) || !await messages.ExistsInDialogAsync(dialogId, form.ReplyToId, ct)))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "invalid_reply_to");

        MemoryStream uploadStream; string ext, contentType; int? w = null, h = null, duration = null;
        try
        {
            await using var s = form.File.OpenReadStream();
            if (form.Kind == MessageKind.Image)
            {
                var photo = await Task.Run(() => ImageProcessor.Photo(s), ct);
                (uploadStream, w, h, ext, contentType) = (new MemoryStream(photo.Data), photo.Width, photo.Height, "webp", "image/webp");
            }
            else
            {
                var ms = new MemoryStream((int)form.File.Length);
                await s.CopyToAsync(ms, ct);
                if (!ms.TryGetBuffer(out var seg) || VoiceFormat.Detect(seg.AsSpan()) is not { } fmt)
                {
                    await ms.DisposeAsync();
                    return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Unsupported audio format");
                }
                ms.Position = 0;
                (uploadStream, ext, contentType) = (ms, fmt.Ext, fmt.ContentType);
                duration = Math.Clamp(form.DurationMs ?? 0, 0, 600_000);
            }
        }
        catch (InvalidImageException)
        {
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Unsupported or corrupted image (JPEG, PNG, WebP or GIF)");
        }

        var id = Ulid.NewUlid().ToString();
        var name = $"{id}.{ext}";
        var key = MediaKeys.Key(dialogId, name);
        await using (uploadStream)
        {
            try { await storage.PutAsync(key, uploadStream, uploadStream.Length, contentType, ct); }
            catch (StorageNotConfiguredException) { return Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "File storage is not available"); }
        }

        var saved = await messages.SaveAsync(new NewMessage(
            Id: id, ClientMessageId: form.ClientMessageId, DialogId: dialogId, SenderId: me, Text: (form.Text ?? "").Trim(),
            MediaUrl: MediaKeys.Url(dialogId, name), ReplyToId: form.ReplyToId,
            Kind: form.Kind, MediaWidth: w, MediaHeight: h, MediaDurationMs: duration), ct);
        if (!saved.IsNew)
        {
            await storage.DeleteAsync(key, ct);   // повтор того же запроса: лишний файл не оставляем
            return Ok(saved.Message);
        }
        await hub.Clients.Users(await access.GetMemberIdsAsync(dialogId, ct)).SendAsync(HubEvents.MessageReceived, saved.Message, ct);
        return Ok(saved.Message);
    }
}

public sealed record ReactionRequest(string Emoji);