namespace Messenger.Api.Auth;

public sealed class JwtOptions
{
    public string Issuer { get; set; } = "messenger";
    public string Audience { get; set; } = "messenger-clients";
    public string Key { get; set; } = "";
    public int AccessTokenMinutes { get; set; } = 15;
    public int RefreshTokenDays { get; set; } = 30;
    /// <summary>"Lax" (один домен) или "None" (фронтенд на другом домене; требует https).</summary>
    public string CookieSameSite { get; set; } = "Lax";
}
