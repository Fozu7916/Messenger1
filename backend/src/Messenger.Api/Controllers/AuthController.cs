using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using UserEntity = Messenger.Api.Domain.User;

namespace Messenger.Api.Controllers;

[ApiController, Route("api/auth")]
public sealed class AuthController(AppDbContext db, ITokenService tokens) : ControllerBase
{
    // Сравнение с «пустышкой», когда пользователь не найден, — чтобы время ответа не выдавало существование логина.
    private static readonly string DummyHash = BCrypt.Net.BCrypt.HashPassword("dummy-password-for-timing", workFactor: 11);

    [HttpPost("register"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthResponse>> Register(RegisterRequest req, CancellationToken ct)
    {
        var email = req.Email.Trim().ToLowerInvariant();
        var baseLogin = req.Login.Trim().ToLowerInvariant();
        var user = new UserEntity
        {
            Login = baseLogin,
            Email = email,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(req.Password, workFactor: 11),
            DisplayName = string.IsNullOrWhiteSpace(req.DisplayName) ? baseLogin : req.DisplayName.Trim(),
        };

        db.Users.Add(user);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            return Problem(statusCode: StatusCodes.Status409Conflict, title: "Login or email is already taken");
        }

        return Ok(ToResponse(user));
    }

    [HttpPost("login"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthResponse>> Login(LoginRequest req, CancellationToken ct)
    {
        var id = req.Login.Trim().ToLowerInvariant();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Login == id || u.Email == id, ct);

        var passwordOk = BCrypt.Net.BCrypt.Verify(req.Password, user?.PasswordHash ?? DummyHash);
        if (user is null || !passwordOk)
            return Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Invalid login or password");

        return Ok(ToResponse(user));
    }

    /// <summary>JWT stateless: клиент просто удаляет токен. TODO: refresh-токены и их отзыв.</summary>
    [HttpPost("logout"), Authorize]
    public IActionResult Logout() => NoContent();

    private AuthResponse ToResponse(UserEntity user)
    {
        var (token, expires) = tokens.Create(user);
        return new AuthResponse(token, expires, new UserDto(user.Id, user.Login, user.DisplayName, user.AvatarUrl));
    }
}
