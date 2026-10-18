namespace Messenger.Api.Auth;

public sealed class JwtOptions
{
    public string Issuer { get; set; } = "messenger";
    public string Audience { get; set; } = "messenger-clients";
    public string Key { get; set; } = "";
    public int AccessTokenMinutes { get; set; } = 60;
}
