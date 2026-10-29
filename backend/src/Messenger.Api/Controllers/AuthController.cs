using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using UserEntity = Messenger.Api.Domain.User;

namespace Messenger.Api.Controllers;

[ApiController, Route("api/auth")]
public sealed class AuthController(
    AppDbContext db, ITokenService tokens, IRefreshTokenService refreshTokens, LoginThrottle throttle, IOptions<JwtOptions> jwt) : ControllerBase
{
    public const string CookieName = "rt";
    // Сравнение с «пустышкой», когда пользователь не найден, — чтобы время ответа не выдавало существование логина.
    private static readonly string DummyHash = BCrypt.Net.BCrypt.HashPassword("dummy-password-for-timing", workFactor: 11);

    [HttpPost("register"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthResponse>> Register(RegisterRequest req, CancellationToken ct)
    {
        var email = req.Email.Trim().ToLowerInvariant();
        var login = req.Login.Trim().ToLowerInvariant();
        var user = new UserEntity
        {
            Login = login,
            Email = email,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(req.Password, workFactor: 11),
            DisplayName = string.IsNullOrWhiteSpace(req.DisplayName) ? login : req.DisplayName.Trim(),
        };

        db.Users.Add(user);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Одинаковый ответ для занятого логина и занятого email — не подсказываем, что именно существует.
            return Problem(statusCode: StatusCodes.Status409Conflict, title: "Login or email is already taken");
        }

        return Ok(await 
        SessionAsync(user, ct));
    }

    [HttpPost("login"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthResponse>> Login(LoginRequest req, CancellationToken ct)
    {
        var id = req.Login.Trim().ToLowerInvariant();
        if (throttle.IsBlocked(id, out var retry))
        {
            Response.Headers.RetryAfter = ((int)retry.TotalSeconds + 1).ToString();
            return Problem(statusCode: StatusCodes.Status429TooManyRequests, title: "Too many failed attempts");
        }

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Login == id || u.Email == id, ct);
        var passwordOk = BCrypt.Net.BCrypt.Verify(req.Password, user?.PasswordHash ?? DummyHash);
        if (user is null || !passwordOk)
        {
            throttle.Fail(id);
            return Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Invalid login or password");
        }

        throttle.Reset(id);
        return Ok(await StartSessionAsync(user, ct));
    }

    /// <summary>Обновляет access-токен по httpOnly-cookie. Требует заголовок X-Requested-With (защита от CSRF: кросс-сайтовая форма его не поставит).</summary>
    [HttpPost("refresh"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthResponse>> Refresh(CancellationToken ct)
    {
        if (!Request.Headers.ContainsKey("X-Requested-With"))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Missing X-Requested-With header");

        var raw = Request.Cookies[CookieName];
        var rotated = string.IsNullOrEmpty(raw) ? null : await refreshTokens.RotateAsync(raw, ct);
        if (rotated is null)
        {
            ClearCookie();
            return Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Session expired");
        }

        SetCookie(rotated.Value.Raw);
        return Ok(ToResponse(rotated.Value.User));
    }

    /// <summary>Отзывает refresh-токен и стирает cookie. Работает и с истёкшим access-токеном.</summary>
    [HttpPost("logout"), AllowAnonymous]
    public async Task<IActionResult> Logout(CancellationToken ct)
    {
        await refreshTokens.RevokeAsync(Request.Cookies[CookieName], ct);
        ClearCookie();
        return NoContent();
    }

    /// <summary>
    /// Продление сессии: по ещё действующему токену выдаёт новый. Клиент вызывает заранее, до истечения,
    /// поэтому активного пользователя не выкидывает на экран входа каждые AccessTokenMinutes.
    /// </summary>
    [HttpPost("refresh"), Authorize]
    public async Task<ActionResult<AuthResponse>> Refresh(CancellationToken ct)
    {
        var me = User.GetUserId();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == me, ct);
        if (user is null)
            return Problem(statusCode: StatusCodes.Status401Unauthorized, title: "User no longer exists");
        return Ok(ToResponse(user));
    }

    /// <summary>JWT stateless: клиент просто удаляет токен.</summary>
    [HttpPost("logout"), Authorize]
    public IActionResult Logout() => NoContent();

    private AuthResponse ToResponse(UserEntity user)
    {
        var (token, expires) = tokens.Create(user);
        return new AuthResponse(token, expires, new UserDto(user.Id, user.Login, user.DisplayName, user.AvatarUrl));
    }

    private CookieOptions CookieOpts(TimeSpan? maxAge)
    {
        var none = jwt.Value.CookieSameSite.Equals("None", StringComparison.OrdinalIgnoreCase) && Request.IsHttps;
        return new CookieOptions
        {
            HttpOnly = true,
            Secure = Request.IsHttps,
            SameSite = none ? SameSiteMode.None : SameSiteMode.Lax,
            Path = "/api/auth",
            MaxAge = maxAge,
            IsEssential = true,
        };
    }

    private void SetCookie(string raw) => Response.Cookies.Append(CookieName, raw, CookieOpts(TimeSpan.FromDays(jwt.Value.RefreshTokenDays)));
    private void ClearCookie() => Response.Cookies.Delete(CookieName, CookieOpts(null));
}
