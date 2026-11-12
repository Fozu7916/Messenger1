namespace Messenger.Api.Contracts;

/// <summary>Разбор запроса «по частям»: слова через пробел, каждое должно встретиться (в любом порядке и месте).</summary>
public static class SearchText
{
    public const int MaxTokens = 5;
    public const int MaxTokenLength = 64;

    public static List<string> Tokens(string? q, bool stripAt = false)
    {
        var result = new List<string>();
        foreach (var raw in (q ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            var t = stripAt ? raw.TrimStart('@') : raw;
            if (t.Length == 0) continue;
            if (t.Length > MaxTokenLength) t = t[..MaxTokenLength];
            if (result.Contains(t, StringComparer.OrdinalIgnoreCase)) continue;
            result.Add(t);
            if (result.Count == MaxTokens) break;
        }
        return result;
    }

    /// <summary>Шаблон ILIKE «содержит»; экранирование LIKE в PostgreSQL по умолчанию — обратный слэш.</summary>
    public static string Contains(string token) => "%" + Escape(token) + "%";
    public static string Prefix(string token) => Escape(token) + "%";
    private static string Escape(string s) => s.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");
}
