using System.Net;
using System.Threading.RateLimiting;
using Messenger.Api.Auth;
using Messenger.Api.Data;
using Messenger.Api.Hubs;
using Messenger.Api.Messages;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using StackExchange.Redis;

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

// ---------- Аутентификация ----------
builder.Services.AddSingleton<ITokenService, TokenService>();
builder.Services.AddScoped<IRefreshTokenService, RefreshTokenService>();
builder.Services.AddSingleton<LoginThrottle>();
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
var usersPerMinute = config.GetValue("RateLimiting:UsersPerMinute", 60);
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("users", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.User.FindFirst("sub")?.Value ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = usersPerMinute, Window = TimeSpan.FromMinutes(1) }));
    o.AddPolicy("auth", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = authPerMinute, Window = TimeSpan.FromMinutes(1) }));
});

// ---------- SignalR (+ Redis backplane, если задан) ----------
var signalR = builder.Services.AddSignalR();
var redis = config.GetConnectionString("Redis");
if (!string.IsNullOrWhiteSpace(redis))
    signalR.AddStackExchangeRedis(redis, o => o.Configuration.ChannelPrefix = RedisChannel.Literal("messenger"));
if (!string.IsNullOrWhiteSpace(redis))
{
    // Присутствие в Redis: корректно работает при нескольких инстансах.
    builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
    {
        var opts = ConfigurationOptions.Parse(redis);
        opts.AbortOnConnectFail = false;
        return ConnectionMultiplexer.Connect(opts);
    });
    builder.Services.AddSingleton<RedisPresenceTracker>();
    builder.Services.AddSingleton<IPresenceTracker>(sp => sp.GetRequiredService<RedisPresenceTracker>());
    builder.Services.AddHostedService(sp => sp.GetRequiredService<RedisPresenceTracker>());
}
else
{
    builder.Services.AddSingleton<IPresenceTracker, InMemoryPresenceTracker>();
}

// ---------- Web ----------
var origins = config.GetSection("Cors:Origins").Get<string[]>() ?? [];
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins(origins).AllowAnyHeader().AllowAnyMethod().AllowCredentials()));
builder.Services.AddControllers();
builder.Services.AddProblemDetails();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

var app = builder.Build();

app.UseForwardedHeaders();   // самым первым

app.Use(async (ctx, next) =>
{
    var h = ctx.Response.Headers;
    h["X-Content-Type-Options"] = "nosniff";
    h["X-Frame-Options"] = "DENY";
    h["Referrer-Policy"] = "no-referrer";
    h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
    // img-src https: — аватары по внешним ссылкам; connect-src 'self' wss: — API и SignalR (при отдельном домене API добавьте его).
    h["Content-Security-Policy"] = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self' wss: https:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
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