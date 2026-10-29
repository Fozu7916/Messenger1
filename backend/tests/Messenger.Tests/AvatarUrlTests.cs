using Messenger.Api.Contracts;

namespace Messenger.Tests;

public sealed class AvatarUrlTests
{
    [Theory]
    [InlineData("https://example.com/a.png")]
    [InlineData("https://cdn.example.com/img/a.jpg?size=64")]
    [InlineData("https://8.8.8.8/a.png")]
    [InlineData("")]
    [InlineData(null)]
    public void Accepts_public_https_and_empty(string? url) => Assert.True(AvatarUrl.TryNormalize(url, out _));

    [Theory]
    [InlineData("http://example.com/a.png")]
    [InlineData("javascript:alert(1)")]
    [InlineData("data:image/png;base64,AAAA")]
    [InlineData("file:///etc/passwd")]
    [InlineData("//example.com/a.png")]
    [InlineData("https://user:pass@example.com/a.png")]
    [InlineData("https://example.com:8443/a.png")]
    [InlineData("https://localhost/a.png")]
    [InlineData("https://printer.local/a.png")]
    [InlineData("https://intranet/a.png")]
    [InlineData("https://127.0.0.1/a.png")]
    [InlineData("https://10.0.0.5/a.png")]
    [InlineData("https://192.168.1.1/a.png")]
    [InlineData("https://172.16.0.1/a.png")]
    [InlineData("https://169.254.169.254/latest/meta-data")]
    [InlineData("https://[::1]/a.png")]
    [InlineData("https://[fe80::1]/a.png")]
    [InlineData("https://[fd00::1]/a.png")]
    [InlineData("https://example.com/a b.png")]
    public void Rejects_unsafe_urls(string url) => Assert.False(AvatarUrl.TryNormalize(url, out _));

    [Fact]
    public void Rejects_too_long_url() =>
        Assert.False(AvatarUrl.TryNormalize("https://example.com/" + new string('a', 2100), out _));
}
