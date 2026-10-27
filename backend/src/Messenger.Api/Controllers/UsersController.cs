using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace Messenger.Api.Controllers;

[ApiController, Route("api/users"), Authorize]
public sealed class UsersController(AppDbContext db) : ControllerBase
{
    [HttpGet("me")]
    public async Task<ActionResult<UserDto>> GetMe(CancellationToken ct)
    {
        var me = User.GetUserId();
        var dto = await db.Users.AsNoTracking()
            .Where(u => u.Id == me)
            .Select(u => new UserDto(u.Id, u.Login, u.DisplayName, u.AvatarUrl))
            .FirstOrDefaultAsync(ct);
        if (dto is null) return NotFound();
        return dto;
    }

    [HttpPut("me")]
    public async Task<ActionResult<UserDto>> UpdateMe(UpdateProfileRequest req, CancellationToken ct)
    {
        if (!AvatarUrl.TryNormalize(req.AvatarUrl, out var avatar))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "avatarUrl must be a public https URL");

        var me = User.GetUserId();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == me, ct);
        if (user is null) return NotFound();

        user.DisplayName = req.DisplayName.Trim();
        user.AvatarUrl = avatar;
        await db.SaveChangesAsync(ct);

        return new UserDto(user.Id, user.Login, user.DisplayName, user.AvatarUrl);
    }

    /// <summary>
    /// Список пользователей (кроме себя), как «Люди» во ВКонтакте: без query — все, по алфавиту имени;
    /// с query — те, у кого логин или имя содержит строку. Постраничная выдача: limit (1–100, по умолчанию 30) и offset.
    /// </summary>
    [HttpGet]
    public async Task<ActionResult<List<UserDto>>> List(
        [FromQuery] string? query,
        [FromQuery] int limit = 30,
        [FromQuery] int offset = 0,
        CancellationToken ct = default)
    {
        var me = User.GetUserId();
        var q = query?.Trim() ?? "";

        var users = db.Users.AsNoTracking().Where(u => u.Id != me);
        if (q.Length > 0)
        {
            var pattern = "%" + q.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";
            users = users.Where(u => EF.Functions.ILike(u.Login, pattern, "\\") || EF.Functions.ILike(u.DisplayName, pattern, "\\"));
        }

        return await users
            .OrderBy(u => u.DisplayName).ThenBy(u => u.Login)
            .Skip(Math.Max(offset, 0))
            .Take(Math.Clamp(limit, 1, 100))
            .Select(u => new UserDto(u.Id, u.Login, u.DisplayName, u.AvatarUrl))
            .ToListAsync(ct);
    }
}
