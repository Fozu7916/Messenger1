using System.Net;
using System.Threading.RateLimiting;
using Messenger.Api.Auth;
using Messenger.Api.Data;
using Messenger.Api.Email;
using Messenger.Api.Hubs;
using Messenger.Api.Messages;
using Messenger.Api.Storage;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);
var config = builder.Configuration;

// ---------- Конфигурация (секреты — только из env / user-secrets, см. .env.example) ----------
var postgres = config.GetConnectionString("Postgres");
if (string.IsNullOrWhiteSpace(postgres))
    throw new InvalidOperationException("ConnectionStrings:Postgres is not configured (env: ConnectionStrings__Postgres).");

var jwt = config.GetSection("Jwt").Get<JwtOptions>() ?? new JwtOptions();
if (jwt.Key.Length < 32)
    throw new InvalidOperationException("Jwt:Key must be at least 32 characters (env: Jwt__Key).");

builder.Services.Configure<JwtOptions>(config.GetSection("Jwt"));

// ---------- Данные ----------
builder.Services.AddSingleton(_ => NpgsqlDataSource.Create(postgres));   // общий пул для EF и Dapper
builder.Services.AddDbContext<AppDbContext>((sp, o) =>
    o.UseNpgsql(sp.GetRequiredService<NpgsqlDataSource>()).UseSnakeCaseNamingConvention());
builder.Services.AddScoped<IMessageRepository, MessageRepository>();
builder.Services.AddScoped<IDialogAccess, DialogAccess>();
builder.Services.AddFileStorage(config);   // S3: Yandex Object Storage (прод); без настроек (локально) — заглушка

// ---------- Аутентификация ----------
builder.Services.AddSingleton<ITokenService, TokenService>();
builder.Services.AddScoped<IRefreshTokenService, RefreshTokenService>();
builder.Services.AddSingleton<LoginThrottle>();
builder.Services.AddScoped<IEmailTokenService, EmailTokenService>();
builder.Services.Configure<SmtpOptions>(config.GetSection("Smtp"));
builder.Services.Configure<ResendOptions>(config.GetSection("Resend"));
if (!string.IsNullOrWhiteSpace(config["Resend:ApiKey"]))
    builder.Services.AddHttpClient<IEmailSender, ResendEmailSender>();   // HTTPS: работает и на бесплатном Render
else if (!string.IsNullOrWhiteSpace(config["Smtp:Host"]))
    builder.Services.AddSingleton<IEmailSender, SmtpEmailSender>();
else
    builder.Services.AddSingleton<IEmailSender, LogEmailSender>();
builder.Services.AddSingleton<EmailQueue>();
builder.Services.AddSingleton<IEmailQueue>(sp => sp.GetRequiredService<EmailQueue>());
builder.Services.AddHostedService<EmailQueueWorker>();
builder.Services.AddHostedService<RefreshTokenCleanup>();
builder.Services.AddSingleton<HubRateLimiter>();
builder.Services.AddSingleton<IUserIdProvider, SubClaimUserIdProvider>();
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.MapInboundClaims = false;   // оставляем "sub" как есть
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = jwt.Issuer,
            ValidateAudience = true,
            ValidAudience = jwt.Audience,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = TokenService.CreateKey(jwt.Key),
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromSeconds(30),
        };
        // WebSocket-клиенты не могут слать заголовок Authorization — токен приходит в query.
        o.Events = new JwtBearerEvents
        {
            OnMessageReceived = ctx =>
            {
                var token = ctx.Request.Query["access_token"];
                if (!string.IsNullOrEmpty(token) && ctx.HttpContext.Request.Path.StartsWithSegments(ChatHub.Path))
                    ctx.Token = token;
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();

// ---------- Forwarded headers (Render / любой reverse proxy) ----------
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    // ForwardLimit = 1: берётся только последняя запись X-Forwarded-For (её дописал ваш прокси), подделанные клиентом слева игнорируются.
    o.ForwardLimit = config.GetValue("ForwardedHeaders:ForwardLimit", 1);
    o.KnownIPNetworks.Clear();
    o.KnownProxies.Clear();
    // Задайте ForwardedHeaders:KnownProxies / KnownNetworks (CIDR) — тогда X-Forwarded-* принимаются только от них.
    // Если не заданы, доверяем любому прокси (подходит только когда приложение недоступно напрямую, как за Render).
    foreach (var p in config.GetSection("ForwardedHeaders:KnownProxies").Get<string[]>() ?? [])
        o.KnownProxies.Add(IPAddress.Parse(p));
    foreach (var n in config.GetSection("ForwardedHeaders:KnownNetworks").Get<string[]>() ?? [])
        o.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(n));   // CIDR, например "10.0.0.0/8"
});

// ---------- Rate limiting на авторизацию ----------
var authPerMinute = config.GetValue("RateLimiting:AuthPerMinute", 10);
var usersPerMinute = config.GetValue("RateLimiting:UsersPerMinute", 300);
var mailPer15Min = config.GetValue("RateLimiting:MailPer15Min", 5);
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    // Клиенту сообщаем, через сколько повторить (фронтенд показывает это число).
    o.OnRejected = (ctx, _) =>
    {
        if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var after))
            ctx.HttpContext.Response.Headers.RetryAfter = ((int)Math.Ceiling(after.TotalSeconds)).ToString();
        return ValueTask.CompletedTask;
    };
    // REST по пользователю: скользящее окно сглаживает всплески (синхронизация после реконнекта) лучше фиксированного.
    o.AddPolicy("users", ctx => RateLimitPartition.GetSlidingWindowLimiter(
        ctx.User.FindFirst("sub")?.Value ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new SlidingWindowRateLimiterOptions { PermitLimit = usersPerMinute, Window = TimeSpan.FromMinutes(1), SegmentsPerWindow = 6 }));
    // Вход, регистрация, обновление сессии, сброс пароля: по IP.
    o.AddPolicy("auth", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = authPerMinute, Window = TimeSpan.FromMinutes(1) }));
    // Всё, что отправляет письма: заметно строже, партиция отдельная от "auth".
    o.AddPolicy("mail", ctx => RateLimitPartition.GetFixedWindowLimiter(
        "mail:" + (ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown"),
        _ => new FixedWindowRateLimiterOptions { PermitLimit = mailPer15Min, Window = TimeSpan.FromMinutes(15) }));
});


// ---------- SignalR ----------
builder.Services.AddSignalR();
builder.Services.AddSingleton<IPresenceTracker, InMemoryPresenceTracker>();

// ---------- Web ----------
var origins = config.GetSection("Cors:Origins").Get<string[]>() ?? [];
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod().AllowCredentials()));
builder.Services.AddControllers();
builder.Services.AddProblemDetails();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

var connectSrc = "'self' wss: " + string.Join(' ', config.GetSection("Csp:ConnectSrc").Get<string[]>() ?? []);
app.UseForwardedHeaders();   // самым первым

app.Use(async (ctx, next) =>
{
    var h = ctx.Response.Headers;
    h["X-Content-Type-Options"] = "nosniff";
    h["X-Frame-Options"] = "DENY";
    h["Referrer-Policy"] = "no-referrer";
    h["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=()";
    // img-src https: — аватары по внешним ссылкам; connect-src — свой origin и wss плюс Csp:ConnectSrc (если API на другом домене).
    h["Content-Security-Policy"] = "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src " + connectSrc + "; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
    await next();
});
if (!app.Environment.IsDevelopment()) app.UseHsts();

if (config.GetValue<bool>("Database:AutoMigrate"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    if (db.Database.GetMigrations().Any()) db.Database.Migrate();
    else db.Database.EnsureCreated();
}

app.UseExceptionHandler();
app.UseStatusCodePages();
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseDefaultFiles();   // раздача собранного фронтенда из wwwroot
app.UseStaticFiles();

app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();   // после аутентификации: лимит «users» считается по пользователю

app.MapControllers();
app.MapHub<ChatHub>(ChatHub.Path);
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapFallbackToFile("index.html");   // SPA-fallback, строго последним среди Map*

app.Run();

public partial class Program { }   // нужен для WebApplicationFactory в тестах