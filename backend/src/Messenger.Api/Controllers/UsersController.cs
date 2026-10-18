using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
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
        // запрещаем javascript:/data: и т.п. в аватаре
        if (!string.IsNullOrWhiteSpace(req.AvatarUrl) &&
            !(Uri.TryCreate(req.AvatarUrl, UriKind.Absolute, out var uri) &&
              (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)))
        {
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "avatarUrl must be an http(s) URL");
        }

        var me = User.GetUserId();
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == me, ct);
        if (user is null) return NotFound();

        user.DisplayName = req.DisplayName.Trim();
        user.AvatarUrl = string.IsNullOrWhiteSpace(req.AvatarUrl) ? null : req.AvatarUrl;
        await db.SaveChangesAsync(ct);

        return new UserDto(user.Id, user.Login, user.DisplayName, user.AvatarUrl);
    }

    /// <summary>Поиск по префиксу логина или имени, минимум 2 символа.</summary>
    [HttpGet]
    public async Task<ActionResult<List<UserDto>>> Search([FromQuery] string? query, CancellationToken ct)
    {
        var q = query?.Trim() ?? "";
        if (q.Length < 2)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "query must be at least 2 characters");

        var me = User.GetUserId();
        var pattern = q.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%";

        return await db.Users.AsNoTracking()
            .Where(u => u.Id != me &&
                        (EF.Functions.ILike(u.Login, pattern, "\\") || EF.Functions.ILike(u.DisplayName, pattern, "\\")))
            .OrderBy(u => u.Login)
            .Take(20)
            .Select(u => new UserDto(u.Id, u.Login, u.DisplayName, u.AvatarUrl))
            .ToListAsync(ct);
    }
}
