using System.IdentityModel.Tokens.Jwt;
using Messenger.Api.Auth;
using Messenger.Api.Domain;
using Microsoft.Extensions.Options;

namespace Messenger.Tests;

public class TokenServiceTests
{
    private static TokenService Create(int minutes = 60) =>
        new(Options.Create(new JwtOptions { Key = new string('k', 40), AccessTokenMinutes = minutes }));

    [Fact]
    public void Token_contains_user_id_as_sub_and_future_expiry()
    {
        var user = new User { Login = "alice" };

        var (token, expires) = Create().Create(user);
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);

        Assert.Equal(user.Id, jwt.Subject);
        Assert.True(expires > DateTime.UtcNow);
    }

    [Fact]
    public void Token_does_not_contain_password_hash()
    {
        var user = new User { Login = "alice", PasswordHash = "SECRET-HASH" };

        var (token, _) = Create().Create(user);

        Assert.DoesNotContain("SECRET-HASH", new JwtSecurityTokenHandler().ReadJwtToken(token).ToString());
    }
}
