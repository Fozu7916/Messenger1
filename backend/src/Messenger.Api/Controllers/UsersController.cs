using System.Text.Json;
using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Messenger.Api.Hubs;

namespace Messenger.Api.Controllers;

[ApiController, Route("api/users"), Authorize, EnableRateLimiting("users")]
public sealed class UsersController(AppDbContext db, IPresenceTracker presence) : ControllerBase
{
    [HttpGet("me")]
    public async Task<ActionResult<ProfileDto>> GetMe(CancellationToken ct)
    {
        var me = User.GetUserId();
        var dto = await db.Users.AsNoTracking()
            .Where(u => u.Id == me)
            .Select(u => new ProfileDto(u.Id, u.Login, u.DisplayName, u.AvatarUrl, u.Bio, u.CreatedAt, null, null))
            .FirstOrDefaultAsync(ct);
        if (dto is null) return NotFound();
        return dto;
    }

    /// <summary>Правка профиля. Bio: null — не менять, "" — очистить (старые клиенты поле не шлют и ничего не теряют).</summary>
    [HttpPut("me")]
    public async Task<ActionResult<ProfileDto>> UpdateMe(UpdateProfileRequest req, CancellationToken ct)
    {
        var displayName = req.DisplayName.Trim();
        if (displayName.Length == 0 || displayName.Any(char.IsControl))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "displayName contains invalid characters");
        string? bio = null;
        var bioGiven = req.Bio is not null;
        if (bioGiven)
        {
            var text = req.Bio!.Trim().Replace("\r\n", "\n");
            if (text.Any(ch => char.IsControl(ch) && ch != '\n'))
                return Problem(statusCode: StatusCodes.Status400BadRequest, title: "bio contains invalid characters");
            bio = text.Length == 0 ? null : text;
        }

        var me = User.GetUserId();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == me, ct);
        if (user is null) return NotFound();
        // Своя загруженная аватарка (/api/files/...) приходит обратно без изменений — оставляем как есть; внешние ссылки проверяем.
        string? avatar;
        if (req.AvatarUrl is not null && req.AvatarUrl == user.AvatarUrl) avatar = user.AvatarUrl;
        else if (!AvatarUrl.TryNormalize(req.AvatarUrl, out avatar))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "avatarUrl must be a public https URL");
        user.DisplayName = displayName;
        user.AvatarUrl = avatar;
        if (bioGiven) user.Bio = bio;
        await db.SaveChangesAsync(ct);
        return user.ToProfileDto();
    }

    /// <summary>Настройки оформления (тема, акцент, обои…): JSON-объект до 4 КБ, формат определяет клиент. Пусто — {}.</summary>
    [HttpGet("me/appearance")]
    public async Task<IActionResult> GetAppearance(CancellationToken ct)
    {
        var me = User.GetUserId();
        var json = await db.Users.AsNoTracking().Where(u => u.Id == me).Select(u => u.Appearance).FirstOrDefaultAsync(ct);
        return Content(json ?? "{}", "application/json");
    }

    [HttpPut("me/appearance")]
    public async Task<IActionResult> PutAppearance([FromBody] JsonElement body, CancellationToken ct)
    {
        var raw = body.ValueKind == JsonValueKind.Object ? body.GetRawText() : null;
        if (raw is null || raw.Length > 4096)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "appearance must be a JSON object up to 4 KB");
        var me = User.GetUserId();
        await db.Users.Where(u => u.Id == me).ExecuteUpdateAsync(s => s.SetProperty(u => u.Appearance, raw), ct);
        return NoContent();
    }

    /// <summary>
    /// Профиль другого пользователя. «В сети» и «был(а) в сети» видны только тем, у кого с ним есть общий диалог.
    /// </summary>
    [HttpGet("{id}")]
    public async Task<ActionResult<ProfileDto>> Get(string id, CancellationToken ct)
    {
        var me = User.GetUserId();
        var row = await db.Users.AsNoTracking()
            .Where(u => u.Id == id)
            .Select(u => new { u.Id, u.Login, u.DisplayName, u.AvatarUrl, u.Bio, u.CreatedAt, u.LastSeenAt })
            .FirstOrDefaultAsync(ct);
        if (row is null) return NotFound();

        var contact = id != me && await db.DialogMembers.AsNoTracking()
            .AnyAsync(m => m.UserId == id && db.DialogMembers.Any(m2 => m2.DialogId == m.DialogId && m2.UserId == me), ct);
        bool? online = contact ? presence.IsOnline(id) : null;
        DateTime? lastSeen = contact && online == false ? row.LastSeenAt : null;
        return new ProfileDto(row.Id, row.Login, row.DisplayName, row.AvatarUrl, row.Bio, row.CreatedAt, online, lastSeen);
    }

    /// <summary>
    /// Поиск собеседников (людей), не сообщений. Запрос разбивается на слова: каждое должно встретиться в логине или имени,
    /// в любом порядке («пет ив» найдёт «Иван Петров»). Ведущий «@» игнорируется. Сначала те, у кого логин/имя начинается с первого слова.
    /// scope=all (по умолчанию) — все пользователи, q обязателен; scope=contacts — только те, с кем уже есть диалог (q можно опустить).
    /// </summary>
    [HttpGet("search")]
    public async Task<ActionResult<List<UserDto>>> Search(
        [FromQuery] string? q,
        [FromQuery] string scope = "all",
        [FromQuery] int limit = 20,
        [FromQuery] int offset = 0,
        CancellationToken ct = default)
    {
        if (scope is not ("all" or "contacts"))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "scope must be 'all' or 'contacts'");
        var tokens = SearchText.Tokens(q, stripAt: true);
        if (tokens.Count == 0 && scope == "all")
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "q is required");

        var me = User.GetUserId();
        var users = db.Users.AsNoTracking().Where(u => u.Id != me);
        if (scope == "contacts")
            users = users.Where(u => db.DialogMembers.Any(m => m.UserId == u.Id
                && db.DialogMembers.Any(m2 => m2.DialogId == m.DialogId && m2.UserId == me)));
        users = Matching(users, tokens);

        var ordered = tokens.Count == 0
            ? users.OrderBy(u => u.DisplayName).ThenBy(u => u.Login)
            : RankByPrefix(users, SearchText.Prefix(tokens[0]));
        return await ordered
            .Skip(Math.Max(offset, 0))
            .Take(Math.Clamp(limit, 1, 100))
            .Select(u => new UserDto(u.Id, u.Login, u.DisplayName, u.AvatarUrl))
            .ToListAsync(ct);
    }

    /// <summary>
    /// Список людей (кроме себя), как «Люди» во ВКонтакте: без query — все по алфавиту имени;
    /// с query — поиск по словам, как в /search. Постранично: limit (1–100, по умолчанию 30) и offset.
    /// </summary>
    [HttpGet]
    public async Task<ActionResult<List<UserDto>>> List(
        [FromQuery] string? query,
        [FromQuery] int limit = 30,
        [FromQuery] int offset = 0,
        CancellationToken ct = default)
    {
        var me = User.GetUserId();
        var users = Matching(db.Users.AsNoTracking().Where(u => u.Id != me), SearchText.Tokens(query, stripAt: true));
        return await users
            .OrderBy(u => u.DisplayName).ThenBy(u => u.Login)
            .Skip(Math.Max(offset, 0))
            .Take(Math.Clamp(limit, 1, 100))
            .Select(u => new UserDto(u.Id, u.Login, u.DisplayName, u.AvatarUrl))
            .ToListAsync(ct);
    }

    private static IQueryable<Messenger.Api.Domain.User> Matching(IQueryable<Messenger.Api.Domain.User> users, List<string> tokens)
    {
        foreach (var t in tokens)
        {
            var pattern = SearchText.Contains(t);
            users = users.Where(u => EF.Functions.ILike(u.Login, pattern, "\\") || EF.Functions.ILike(u.DisplayName, pattern, "\\"));
        }
        return users;
    }

    private static IOrderedQueryable<Messenger.Api.Domain.User> RankByPrefix(IQueryable<Messenger.Api.Domain.User> users, string prefix) =>
        users.OrderBy(u => EF.Functions.ILike(u.Login, prefix, "\\") || EF.Functions.ILike(u.DisplayName, prefix, "\\") ? 0 : 1)
            .ThenBy(u => u.DisplayName).ThenBy(u => u.Login);
}
