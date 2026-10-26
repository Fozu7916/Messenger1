using System.Net;
using Messenger.Api.Contracts;

namespace Messenger.Tests;

[Collection(ApiCollection.Name)]
public sealed class AuthTests(ApiFactory factory)
{
    [Fact]
    public async Task Register_then_login_returns_token_and_me_works()
    {
        var u = await factory.RegisterAsync("auth");

        var login = await factory.CreateClient().PostAsJsonAsync("/api/auth/login",
            new { login = u.User.Login, password = "Passw0rd!x" });
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);

        var me = await u.Http.GetFromJsonAsync<UserDto>("/api/users/me");
        Assert.Equal(u.User.Id, me!.Id);
    }

    [Fact]
    public async Task Login_with_wrong_password_returns_401()
    {
        var u = await factory.RegisterAsync("auth");

        var resp = await factory.CreateClient().PostAsJsonAsync("/api/auth/login",
            new { login = u.User.Login, password = "wrong-password" });

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Registering_same_login_twice_returns_409()
    {
        var u = await factory.RegisterAsync("dup");

        var resp = await factory.CreateClient().PostAsJsonAsync("/api/auth/register", new
        {
            login = u.User.Login,
            email = "other-" + u.User.Login + "@test.local",
            password = "Passw0rd!x",
            displayName = "x",
        });

        Assert.Equal(HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Register_with_invalid_data_returns_400()
    {
        var resp = await factory.CreateClient().PostAsJsonAsync("/api/auth/register",
            new { login = "a", email = "not-an-email", password = "123", displayName = "" });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Protected_endpoint_without_token_returns_401()
    {
        var resp = await factory.CreateClient().GetAsync("/api/users/me");

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Refresh_with_valid_token_issues_new_working_token()
    {
        var u = await factory.RegisterAsync("auth");

        var resp = await u.Http.PostAsync("/api/auth/refresh", null);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var auth = (await resp.Content.ReadFromJsonAsync<AuthResponse>())!;
        Assert.Equal(u.User.Id, auth.User.Id);

        var http = factory.CreateClient();
        http.DefaultRequestHeaders.Authorization = new("Bearer", auth.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await http.GetAsync("/api/users/me")).StatusCode);
    }

    [Fact]
    public async Task Refresh_without_token_returns_401()
    {
        var resp = await factory.CreateClient().PostAsync("/api/auth/refresh", null);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }
}
