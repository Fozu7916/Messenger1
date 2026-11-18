using Messenger.Api.Storage;

namespace Messenger.Api.Media;

/// <summary>Ключи и адреса вложений: media/{dialogId}/{ulid}.{ext}, отдаются только участникам диалога.</summary>
public static class MediaKeys
{
    public static readonly string[] Extensions = ["webp", "ogg", "webm", "m4a", "mp3"];

    public static string ContentType(string ext) => ext switch
    {
        "webp" => "image/webp", "ogg" => "audio/ogg", "webm" => "audio/webm", "m4a" => "audio/mp4", "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    };

    public static string Url(string dialogId, string name) => $"/api/dialogs/{dialogId}/media/{name}";
    public static string Key(string dialogId, string name) => $"media/{dialogId}/{name}";

    public static bool IsValidName(string name) =>
        name.Length > 27 && name[26] == '.' && name[..26].All(char.IsAsciiLetterOrDigit) && Extensions.Contains(name[27..]);

    /// <summary>"/api/dialogs/{dialogId}/media/{name}" → (dialogId, name); иначе null.</summary>
    public static (string DialogId, string Name)? Parse(string? url)
    {
        const string prefix = "/api/dialogs/";
        if (url is null || !url.StartsWith(prefix)) return null;
        var parts = url[prefix.Length..].Split('/');
        return parts is [var dialog, "media", var name] && dialog.Length == 26 && IsValidName(name) ? (dialog, name) : null;
    }

    /// <summary>Удаляет все вложения диалога (при удалении диалога/беседы). Ошибки не критичны: файлы-сироты не мешают работе.</summary>
    public static async Task DeleteDialogMediaAsync(this IFileStorage storage, string dialogId, ILogger log)
    {
        try
        {
            foreach (var key in await storage.ListAsync($"media/{dialogId}/", 1000))
                await storage.DeleteAsync(key);
        }
        catch (Exception ex) { log.LogWarning(ex, "Could not clean up media of dialog {DialogId}", dialogId); }
    }
}

/// <summary>Определяет формат голосового по первым байтам (расширению и Content-Type клиента не верим).</summary>
public static class VoiceFormat
{
    public static (string Ext, string ContentType)? Detect(ReadOnlySpan<byte> h)
    {
        if (h.Length >= 4 && h[0] == 0x1A && h[1] == 0x45 && h[2] == 0xDF && h[3] == 0xA3) return ("webm", "audio/webm");   // Chrome, Edge
        if (h.Length >= 4 && h[0] == 'O' && h[1] == 'g' && h[2] == 'g' && h[3] == 'S') return ("ogg", "audio/ogg");          // Firefox
        if (h.Length >= 8 && h[4] == 'f' && h[5] == 't' && h[6] == 'y' && h[7] == 'p') return ("m4a", "audio/mp4");          // Safari
        if (h.Length >= 3 && ((h[0] == 'I' && h[1] == 'D' && h[2] == '3') || (h[0] == 0xFF && (h[1] & 0xE0) == 0xE0))) return ("mp3", "audio/mpeg");
        return null;
    }
}
