using System.Net;
using System.Net.Sockets;

namespace Messenger.Api.Contracts;

/// <summary>Проверка ссылки на аватар: только публичный https, без логина/пароля в URL, без внутренних адресов.</summary>
public static class AvatarUrl
{
    public const int MaxLength = 2048;

    public static bool TryNormalize(string? raw, out string? normalized)
    {
        normalized = null;
        if (string.IsNullOrWhiteSpace(raw)) return true; // пустое = убрать аватар
        raw = raw.Trim();
        if (raw.Length > MaxLength || raw.Any(char.IsControl) || raw.Any(char.IsWhiteSpace)) return false;
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttps || !string.IsNullOrEmpty(uri.UserInfo) || !uri.IsDefaultPort) return false;

        var host = uri.IdnHost.TrimEnd('.').ToLowerInvariant();
        if (host.Length == 0 || host == "localhost" || host.EndsWith(".localhost") || host.EndsWith(".local")
            || host.EndsWith(".internal") || host.EndsWith(".lan") || host.EndsWith(".home") || !host.Contains('.') && uri.HostNameType == UriHostNameType.Dns)
            return false;
        if (IPAddress.TryParse(host.Trim('[', ']'), out var ip) && !IsPublic(ip)) return false;

        normalized = uri.AbsoluteUri;
        return normalized.Length <= MaxLength;
    }

    private static bool IsPublic(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any)) return false;
        var b = ip.GetAddressBytes();
        if (ip.AddressFamily == AddressFamily.InterNetwork)
            return !(b[0] is 0 or 10 or 127 || b[0] >= 224 || (b[0] == 100 && b[1] is >= 64 and <= 127) || (b[0] == 169 && b[1] == 254)
                || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 192 && b[1] == 0 && b[2] == 0));
        return !(ip.IsIPv6LinkLocal || ip.IsIPv6SiteLocal || ip.IsIPv6Multicast || (b[0] & 0xFE) == 0xFC);
    }
}
