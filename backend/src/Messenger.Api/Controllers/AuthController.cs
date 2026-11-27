using Messenger.Api.Auth;
using Messenger.Api.Contracts;
using Messenger.Api.Data;
using Messenger.Api.Email;
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
    AppDbContext db, ITokenService tokens, IRefreshTokenService refreshTokens, LoginThrottle throttle, IOptions<JwtOptions> jwt,
    IEmailTokenService emailTokens, IEmailQueue mailQueue, IConfiguration config) : ControllerBase
{
    public const string CookieName = "rt";
    // Сравнение с «пустышкой», когда пользователь не найден, — чтобы время ответа не выдавало существование логина.
    private static readonly string DummyHash = BCrypt.Net.BCrypt.HashPassword("dummy-password-for-timing", workFactor: 11);

    [HttpPost("register"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthResponse>> Register(RegisterRequest req, CancellationToken ct)
    {
        var email = req.Email.Trim().ToLowerInvariant();
        var login = req.Login.Trim().ToLowerInvariant();
        var displayName = string.IsNullOrWhiteSpace(req.DisplayName) ? login : req.DisplayName.Trim();
        if (displayName.Any(char.IsControl))
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "displayName contains invalid characters");
        var user = new UserEntity
        {
            Login = login,
            Email = email,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(req.Password, workFactor: 11),
            DisplayName = displayName,
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

        await SendConfirmationAsync(user, ct);
        return Ok(await StartSessionAsync(user, ct));
    }

    [HttpPost("login"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<ActionResult<AuthResponse>> Login(LoginRequest req, CancellationToken ct)
    {
        var id = req.Login.Trim().ToLowerInvariant();
        var ip = ClientIp();
        if (throttle.IsBlocked(ip, id, out var retry))
        {
            Response.Headers.RetryAfter = ((int)retry.TotalSeconds + 1).ToString();
            return Problem(statusCode: StatusCodes.Status429TooManyRequests, title: "Too many failed attempts");
        }

        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Login == id || u.Email == id, ct);
        // Если аккаунт существует — проверяем блокировку ещё и по user.Id, чтобы нельзя было обходить лимит, чередуя логин и email.
        if (user is not null && throttle.IsBlocked(ip, "uid:" + user.Id, out retry))
        {
            Response.Headers.RetryAfter = ((int)retry.TotalSeconds + 1).ToString();
            return Problem(statusCode: StatusCodes.Status429TooManyRequests, title: "Too many failed attempts");
        }

        var passwordOk = BCrypt.Net.BCrypt.Verify(req.Password, user?.PasswordHash ?? DummyHash);
        if (user is null || !passwordOk)
        {
            throttle.Fail(ip, id);
            if (user is not null) throttle.Fail(ip, "uid:" + user.Id);
            return Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Invalid login or password");
        }

        // Проверка после пароля: чужой человек не узнает, подтверждена ли почта у существующего аккаунта.
        if (user.EmailConfirmedAt is null && config.GetValue("Auth:RequireConfirmedEmail", false))
            return Problem(statusCode: StatusCodes.Status403Forbidden, title: "Email is not confirmed");

        throttle.Reset(ip, id);
        throttle.Reset(ip, "uid:" + user.Id);
        return Ok(await StartSessionAsync(user, ct));
    }

    /// <summary>Отправляет письмо со ссылкой сброса. Всегда 204 — не раскрывает, есть ли такой email.</summary>
    [HttpPost("forgot-password"), AllowAnonymous, EnableRateLimiting("mail")]
    public async Task<IActionResult> ForgotPassword(EmailRequest req, CancellationToken ct)
    {
        var email = req.Email.Trim().ToLowerInvariant();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email == email, ct);
        if (user is not null && await emailTokens.IssueAsync(user.Id, EmailTokenPurpose.Reset, ct) is { } raw)
            SendMail(user.Email, "Сброс пароля",
                $"Чтобы задать новый пароль, откройте ссылку (действует {config.GetValue("Auth:ResetTokenMinutes", 30)} мин):\n{Link("reset", raw)}\n\nЕсли вы не запрашивали сброс, просто проигнорируйте письмо.");
        return NoContent();
    }

    /// <summary>Задаёт новый пароль по токену из письма. Токен одноразовый; все сессии отзываются.</summary>
    [HttpPost("reset-password"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> ResetPassword(ResetPasswordRequest req, CancellationToken ct)
    {
        var user = await emailTokens.ConsumeAsync(req.Token, EmailTokenPurpose.Reset, ct);
        if (user is null) return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Reset link is invalid or expired");

        user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(req.NewPassword, workFactor: 11);
        user.EmailConfirmedAt ??= DateTime.UtcNow;   // перешёл по ссылке из почты — владение подтверждено
        await db.SaveChangesAsync(ct);
        await refreshTokens.RevokeAllExceptAsync(user.Id, null, ct);
        return NoContent();
    }

    [HttpPost("confirm-email"), AllowAnonymous, EnableRateLimiting("auth")]
    public async Task<IActionResult> ConfirmEmail(TokenRequest req, CancellationToken ct)
    {
        var user = await emailTokens.ConsumeAsync(req.Token, EmailTokenPurpose.Confirm, ct);
        if (user is null) return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Confirmation link is invalid or expired");
        user.EmailConfirmedAt ??= DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return NoContent();
    }

    /// <summary>Повторная отправка письма подтверждения. Всегда 204.</summary>
    [HttpPost("resend-confirmation"), AllowAnonymous, EnableRateLimiting("mail")]
    public async Task<IActionResult> ResendConfirmation(EmailRequest req, CancellationToken ct)
    {
        var email = req.Email.Trim().ToLowerInvariant();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Email == email && u.EmailConfirmedAt == null, ct);
        if (user is not null) await SendConfirmationAsync(user, ct);
        return NoContent();
    }

    private async Task SendConfirmationAsync(UserEntity user, CancellationToken ct)
    {
        if (await emailTokens.IssueAsync(user.Id, EmailTokenPurpose.Confirm, ct) is { } raw)
            SendMail(user.Email, "Подтвердите почту",
                $"Здравствуйте! Чтобы подтвердить email, откройте ссылку (действует {config.GetValue("Auth:ConfirmTokenHours", 24)} ч):\n{Link("confirm", raw)}");
    }

    /// <summary>Ссылка строится из конфигурации, а не из заголовка Host (иначе его подмена отравила бы ссылку в письме). Токен — во фрагменте: он не попадает в логи серверов и Referer.</summary>
    private string Link(string page, string raw)
    {
        var baseUrl = config["App:PublicBaseUrl"];
        if (string.IsNullOrWhiteSpace(baseUrl)) baseUrl = config.GetSection("Cors:Origins").Get<string[]>()?.FirstOrDefault() ?? "";
        return $"{baseUrl.TrimEnd('/')}/{page}#token={raw}";
    }

    /// <summary>Постановка письма в фоновую очередь: время ответа не зависит от SMTP/Resend, а сбой почты не ломает запрос.</summary>
    private void SendMail(string to, string subject, string body) => mailQueue.Enqueue(to, subject, body);

    /// <summary>
    /// Смена пароля. Все остальные сессии (refresh-токены) отзываются, текущая сохраняется.
    /// Неверный текущий пароль — 400 (не 401: клиент по 401 разлогинивает пользователя).
    /// </summary>
    [HttpPost("password"), Authorize, EnableRateLimiting("auth")]
    public async Task<IActionResult> ChangePassword(ChangePasswordRequest req, CancellationToken ct)
    {
        var me = User.GetUserId();
        var key = "pw:" + me;
        var ip = ClientIp();
        if (throttle.IsBlocked(ip, key, out var retry))
        {
            Response.Headers.RetryAfter = ((int)retry.TotalSeconds + 1).ToString();
            return Problem(statusCode: StatusCodes.Status429TooManyRequests, title: "Too many failed attempts");
        }

        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == me, ct);
        if (user is null) return Unauthorized();
        if (!BCrypt.Net.BCrypt.Verify(req.CurrentPassword, user.PasswordHash))
        {
            throttle.Fail(ip, key);
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "Current password is incorrect");
        }
        if (req.NewPassword == req.CurrentPassword)
            return Problem(statusCode: StatusCodes.Status400BadRequest, title: "New password must differ from the current one");

        user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(req.NewPassword, workFactor: 11);
        await db.SaveChangesAsync(ct);
        throttle.Reset(ip, key);
        await refreshTokens.RevokeAllExceptAsync(me, Request.Cookies[CookieName], ct);
        return NoContent();
    }

    private string ClientIp() => HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";

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

    private async Task<AuthResponse> StartSessionAsync(UserEntity user, CancellationToken ct)
    {
        SetCookie(await refreshTokens.IssueAsync(user.Id, ct));
        return ToResponse(user);
    }

    private AuthResponse ToResponse(UserEntity user)
    {
        var (token, expires) = tokens.Create(user);
        return new AuthResponse(token, expires, user.ToUserDto());
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
