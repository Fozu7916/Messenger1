using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
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
/// Аватарки и обои. Файлы лежат в S3 (IFileStorage), в БД — только ссылка на аватар.
/// Аватары публичны (адрес содержит случайный ULID, файл неизменяем → кэшируется навсегда).
/// Обои приватны: отдаются только владельцу по токену (клиент берёт их через fetch и превращает в blob-ссылку).
/// </summary>
[ApiController, Authorize, EnableRateLimiting("users")]
public sealed class FilesController(AppDbContext db, IFileStorage storage, IDialogAccess access, IHubContext<ChatHub> hub, ILogger<FilesController> log) : ControllerBase
{
    private const int MaxUpload = 5 * 1024 * 1024;
    private const int MaxWallpapers = 12;
    private const string FilesPrefix = "/api/files/";

    // ---------------- Аватар ----------------

    /// <summary>Загрузить аватар (multipart, поле file, до 5 МБ; JPEG/PNG/WebP/GIF). Возвращает обновлённый профиль.</summary>
    [HttpPost("api/users/me/avatar"), RequestSizeLimit(MaxUpload), RequestFormLimits(MultipartBodyLengthLimit = MaxUpload)]
    public async Task<ActionResult<ProfileDto>> UploadAvatar(IFormFile file, CancellationToken ct)
    {
        var me = User.GetUserId();
        var processed = await ProcessAsync(file, ImageProcessor.Avatar);
        if (processed.Error is not null) return processed.Error;

        var key = $"avatars/{me}/{Ulid.NewUlid()}.webp";
        try { await storage.PutAsync(key, new MemoryStream(processed.Bytes!), processed.Bytes!.Length, "image/webp", ct); }
        catch (StorageNotConfiguredException) { return Unavailable(); }

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == me, ct);
        if (user is null) return NotFound();
        var old = user.AvatarUrl;
        user.AvatarUrl = FilesPrefix + key;
        await db.SaveChangesAsync(ct);
        await DeleteOwnAvatarAsync(me, old);
        return Profile(user);
    }

    [HttpDelete("api/users/me/avatar")]
    public async Task<ActionResult<ProfileDto>> DeleteAvatar(CancellationToken ct)
    {
        var me = User.GetUserId();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == me, ct);
        if (user is null) return NotFound();
        var old = user.AvatarUrl;
        user.AvatarUrl = null;
        await db.SaveChangesAsync(ct);
        await DeleteOwnAvatarAsync(me, old);
        return Profile(user);
    }

    /// <summary>Публичная отдача аватара: ключ неизменяем, поэтому кэш на год.</summary>
    [HttpGet("api/files/avatars/{userId}/{name}"), AllowAnonymous]
    public Task<IActionResult> GetAvatar(string userId, string name, CancellationToken ct) =>
        IsUlid(userId) && name.Length == 31 && name.EndsWith(".webp") && IsUlid(name[..26])
            ? ServeAsync($"avatars/{userId}/{name}", "public, max-age=31536000, immutable", ct)
            : Task.FromResult<IActionResult>(NotFound());

    // ---------------- Обои ----------------

    /// <summary>Идентификаторы загруженных обоев пользователя, сначала новые.</summary>
    [HttpGet("api/users/me/wallpapers")]
    public async Task<ActionResult<List<WallpaperDto>>> ListWallpapers(CancellationToken ct)
    {
        try
        {
            var keys = await storage.ListAsync($"wallpapers/{User.GetUserId()}/", 100, ct);
            return keys.Select(k => Path.GetFileNameWithoutExtension(k)).Where(IsUlid)
                .OrderByDescending(id => id, StringComparer.Ordinal).Select(id => new WallpaperDto(id)).ToList();
        }
        catch (StorageNotConfiguredException) { return Unavailable(); }
    }

    /// <summary>Загрузить обои (multipart, поле file, до 5 МБ). До 12 штук на пользователя.</summary>
    [HttpPost("api/users/me/wallpapers"), RequestSizeLimit(MaxUpload), RequestFormLimits(MultipartBodyLengthLimit = MaxUpload)]
    public async Task<ActionResult<WallpaperDto>> UploadWallpaper(IFormFile file, CancellationToken ct)
    {
        var me = User.GetUserId();
        var processed = await ProcessAsync(file, ImageProcessor.Wallpaper);
        if (processed.Error is not null) return processed.Error;
        try
        {
            if ((await storage.ListAsync($"wallpapers/{me}/", MaxWallpapers + 1, ct)).Count >= MaxWallpapers)
                return Problem(statusCode: StatusCodes.Status409Conflict, title: $"At most {MaxWallpapers} wallpapers; delete one first");
            var id = Ulid.NewUlid().ToString();
            await storage.PutAsync($"wallpapers/{me}/{id}.webp", new MemoryStream(processed.Bytes!), processed.Bytes!.Length, "image/webp", ct);
            return StatusCode(StatusCodes.Status201Created, new WallpaperDto(id));
        }
        catch (StorageNotConfiguredException) { return Unavailable(); }
    }

    /// <summary>Файл обоев. Путь всегда строится от текущего пользователя, чужие обои недоступны.</summary>
    [HttpGet("api/users/me/wallpapers/{id}")]
    public Task<IActionResult> GetWallpaper(string id, CancellationToken ct) =>
        IsUlid(id)
            ? ServeAsync($"wallpapers/{User.GetUserId()}/{id}.webp", "private, max-age=31536000, immutable", ct)
            : Task.FromResult<IActionResult>(NotFound());

    [HttpDelete("api/users/me/wallpapers/{id}")]
    public async Task<IActionResult> DeleteWallpaper(string id, CancellationToken ct)
    {
        if (!IsUlid(id)) return NotFound();
        try { await storage.DeleteAsync($"wallpapers/{User.GetUserId()}/{id}.webp", ct); }
        catch (StorageNotConfiguredException) { return Unavailable(); }
        return NoContent();
    }

    // ---------------- Аватар беседы ----------------

    /// <summary>Загрузить аватар беседы (любой участник). Участникам уходит DialogsChanged.</summary>
    [HttpPost("api/dialogs/{dialogId}/avatar"), RequestSizeLimit(MaxUpload), RequestFormLimits(MultipartBodyLengthLimit = MaxUpload)]
    public async Task<IActionResult> UploadGroupAvatar(string dialogId, IFormFile file, CancellationToken ct)
    {
        var dialog = await GroupAsync(dialogId, ct);
        if (dialog is null) return NotFound();
        var processed = await ProcessAsync(file, ImageProcessor.Avatar);
        if (processed.Error is not null) return processed.Error;
        var key = $"group-avatars/{dialogId}/{Ulid.NewUlid()}.webp";
        try { await storage.PutAsync(key, new MemoryStream(processed.Bytes!), processed.Bytes!.Length, "image/webp", ct); }
        catch (StorageNotConfiguredException) { return Unavailable(); }
        var old = dialog.AvatarUrl;
        dialog.AvatarUrl = FilesPrefix + key;
        await db.SaveChangesAsync(ct);
        await DeleteGroupAvatarFileAsync(dialogId, old);
        await NotifyAsync(dialogId, ct);
        return NoContent();
    }

    [HttpDelete("api/dialogs/{dialogId}/avatar")]
    public async Task<IActionResult> DeleteGroupAvatar(string dialogId, CancellationToken ct)
    {
        var dialog = await GroupAsync(dialogId, ct);
        if (dialog is null) return NotFound();
        var old = dialog.AvatarUrl;
        dialog.AvatarUrl = null;
        await db.SaveChangesAsync(ct);
        await DeleteGroupAvatarFileAsync(dialogId, old);
        await NotifyAsync(dialogId, ct);
        return NoContent();
    }

    [HttpGet("api/files/group-avatars/{dialogId}/{name}"), AllowAnonymous]
    public Task<IActionResult> GetGroupAvatar(string dialogId, string name, CancellationToken ct) =>
        IsUlid(dialogId) && name.Length == 31 && name.EndsWith(".webp") && IsUlid(name[..26])
            ? ServeAsync($"group-avatars/{dialogId}/{name}", "public, max-age=31536000, immutable", ct)
            : Task.FromResult<IActionResult>(NotFound());

    // ---------------- Вложения сообщений (фото, голосовые) ----------------

    /// <summary>Файл вложения. Только участникам диалога; клиент берёт его через fetch с токеном и показывает blob-ссылкой.</summary>
    [HttpGet("api/dialogs/{dialogId}/media/{name}")]
    public async Task<IActionResult> GetMedia(string dialogId, string name, CancellationToken ct)
    {
        if (!IsUlid(dialogId) || !MediaKeys.IsValidName(name) || !await access.IsMemberAsync(dialogId, User.GetUserId(), ct)) return NotFound();
        return await ServeAsync(MediaKeys.Key(dialogId, name), "private, max-age=31536000, immutable", ct, MediaKeys.ContentType(name[27..]));
    }

    // ---------------- Общее ----------------

    private async Task<Domain.Dialog?> GroupAsync(string dialogId, CancellationToken ct)
    {
        var me = User.GetUserId();
        return await db.Dialogs.FirstOrDefaultAsync(d => d.Id == dialogId && d.Kind == "group" && d.Members.Any(m => m.UserId == me), ct);
    }

    private async Task NotifyAsync(string dialogId, CancellationToken ct) =>
        await hub.Clients.Users(await access.GetMemberIdsAsync(dialogId, ct)).SendAsync("DialogsChanged", ct);

    private async Task DeleteGroupAvatarFileAsync(string dialogId, string? url)
    {
        if (url is null || !url.StartsWith(FilesPrefix)) return;
        var key = url[FilesPrefix.Length..];
        if (!key.StartsWith($"group-avatars/{dialogId}/")) return;
        try { await storage.DeleteAsync(key); }
        catch (Exception ex) { log.LogWarning(ex, "Could not delete old group avatar {Key}", key); }
    }

    private static bool IsUlid(string s) => s.Length == 26 && s.All(char.IsAsciiLetterOrDigit);

    private static ProfileDto Profile(Domain.User u) => new(u.Id, u.Login, u.DisplayName, u.AvatarUrl, u.Bio, u.CreatedAt);

    private ObjectResult Unavailable() => Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "File storage is not available");

    private async Task<(byte[]? Bytes, ObjectResult? Error)> ProcessAsync(IFormFile? file, Func<Stream, byte[]> process)
    {
        if (file is null || file.Length == 0 || file.Length > MaxUpload)
            return (null, Problem(statusCode: StatusCodes.Status400BadRequest, title: "Send an image up to 5 MB in the 'file' field"));
        try
        {
            await using var s = file.OpenReadStream();
            return (await Task.Run(() => process(s)), null);   // декодирование — работа для CPU, не блокируем поток запроса
        }
        catch (InvalidImageException ex)
        {
            log.LogInformation("Rejected image upload: {Reason}", ex.Message);
            return (null, Problem(statusCode: StatusCodes.Status400BadRequest, title: "Unsupported or corrupted image (JPEG, PNG, WebP or GIF)"));
        }
    }

    private async Task<IActionResult> ServeAsync(string key, string cacheControl, CancellationToken ct, string contentType = "image/webp")
    {
        IStoredFile? file;
        try { file = await storage.GetAsync(key, ct); }
        catch (StorageNotConfiguredException) { return Unavailable(); }
        if (file is null) return NotFound();

        var etag = string.IsNullOrEmpty(file.ETag) ? null : $"\"{file.ETag.Trim('"')}\"";
        Response.Headers.CacheControl = cacheControl;
        Response.Headers["X-Content-Type-Options"] = "nosniff";
        if (etag is not null)
        {
            Response.Headers.ETag = etag;
            if (Request.Headers.IfNoneMatch.Contains(etag))
            {
                await file.DisposeAsync();
                return StatusCode(StatusCodes.Status304NotModified);
            }
        }
        Response.RegisterForDisposeAsync(file);
        return File(file.Content, contentType);   // тип определяем мы сами (по расширению ключа), а не берём у клиента
    }

    /// <summary>Удаляет прежний аватар, только если он наш и принадлежит этому пользователю (внешние ссылки не трогаем).</summary>
    private async Task DeleteOwnAvatarAsync(string userId, string? url)
    {
        if (url is null || !url.StartsWith(FilesPrefix)) return;
        var key = url[FilesPrefix.Length..];
        if (!key.StartsWith($"avatars/{userId}/")) return;
        try { await storage.DeleteAsync(key); }
        catch (Exception ex) { log.LogWarning(ex, "Could not delete old avatar {Key}", key); }
    }
}
