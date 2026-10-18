using System.Threading.RateLimiting;
using Messenger.Api.Auth;
using Messenger.Api.Data;
using Messenger.Api.Hubs;
using Messenger.Api.Messages;
using Microsoft.AspNetCore.Authentication.JwtBearer;
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

// ---------- Rate limiting на авторизацию ----------
// TODO: за Nginx RemoteIpAddress — адрес прокси; подключить ForwardedHeaders с KnownProxies.
var authPerMinute = config.GetValue("RateLimiting:AuthPerMinute", 10);
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("auth", ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = authPerMinute, Window = TimeSpan.FromMinutes(1) }));
});

// ---------- SignalR (+ Redis backplane, если задан) ----------
var signalR = builder.Services.AddSignalR();
var redis = config.GetConnectionString("Redis");
if (!string.IsNullOrWhiteSpace(redis))
    signalR.AddStackExchangeRedis(redis, o => o.Configuration.ChannelPrefix = RedisChannel.Literal("messenger"));
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

if (config.GetValue<bool>("Database:AutoMigrate"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    // Пока миграций нет — создаём схему напрямую. После `dotnet ef migrations add` используется Migrate().
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
app.UseCors();
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();
app.MapHub<ChatHub>(ChatHub.Path);
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.Run();

public partial class Program { }   // нужен для WebApplicationFactory в тестах
