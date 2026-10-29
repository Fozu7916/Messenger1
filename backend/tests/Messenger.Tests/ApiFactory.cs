using Messenger.Api.Contracts;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Testcontainers.PostgreSql;

namespace Messenger.Tests;

/// <summary>Поднимает настоящий PostgreSQL в Docker и приложение поверх него. Требуется запущенный Docker.</summary>
public sealed class ApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:17").Build();
    

    public Task InitializeAsync() => _pg.StartAsync();

    public new async Task DisposeAsync()
    {
        await _pg.DisposeAsync();
        await base.DisposeAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Postgres", _pg.GetConnectionString());
        builder.UseSetting("Jwt:Key", "test-key-test-key-test-key-test-key-1234");
        builder.UseSetting("Database:AutoMigrate", "true");
        builder.UseSetting("RateLimiting:AuthPerMinute", "100000");
        builder.UseSetting("Auth:RefreshGraceSeconds", "0");
    }
}

[CollectionDefinition(Name)]
public sealed class ApiCollection : ICollectionFixture<ApiFactory>
{
    public const string Name = "api";
}

public sealed record TestUser(HttpClient Http, UserDto User, string Token);

public static class TestHelpers
{
    public static async Task<TestUser> RegisterAsync(this ApiFactory f, string prefix = "u")
    {
        var login = prefix + Guid.NewGuid().ToString("N")[..8];
        var resp = await f.CreateClient().PostAsJsonAsync("/api/auth/register", new
        {
            login,
            email = $"{login}@test.local",
            password = "Passw0rd!x",
            displayName = login,
        });
        resp.EnsureSuccessStatusCode();
        var auth = (await resp.Content.ReadFromJsonAsync<AuthResponse>())!;

        var http = f.CreateClient();
        http.DefaultRequestHeaders.Authorization = new("Bearer", auth.AccessToken);
        return new TestUser(http, auth.User, auth.AccessToken);
    }

    public static async Task<DialogDto> CreateDialogAsync(this TestUser a, TestUser b)
    {
        var resp = await a.Http.PostAsJsonAsync("/api/dialogs", new { userId = b.User.Id });
        resp.EnsureSuccessStatusCode();
        return (await resp.Content.ReadFromJsonAsync<DialogDto>())!;
    }

    public static HubConnection ConnectHub(this ApiFactory f, string token) =>
        new HubConnectionBuilder()
            .WithUrl(new Uri(f.Server.BaseAddress, "/hubs/chat"), o =>
            {
                o.HttpMessageHandlerFactory = _ => f.Server.CreateHandler();
                o.AccessTokenProvider = () => Task.FromResult<string?>(token);
                o.Transports = HttpTransportType.LongPolling;   // TestServer без реальных сокетов
            })
            .Build();
}
