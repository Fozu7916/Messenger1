using System.ComponentModel.DataAnnotations;

namespace Messenger.Api.Contracts;

public sealed class RegisterRequest
{
    [Required, RegularExpression("^[a-zA-Z0-9_]{3,32}$", ErrorMessage = "3–32 символа: латиница, цифры, _")]
    public string Login { get; init; } = "";

    [Required, MaxLength(254), RegularExpression(@"^[^@\s]+@[^@\s.]+(\.[^@\s.]+)*\.[A-Za-z]{2,}$", ErrorMessage = "Введите корректный email, например name@example.com")]
    public string Email { get; init; } = "";

    // bcrypt учитывает только первые 72 байта пароля
    [Required, MinLength(8), MaxUtf8Bytes(72)]
    public string Password { get; init; } = "";

    [MaxLength(64)]
    public string? DisplayName { get; init; }
}

public sealed class LoginRequest
{
    /// <summary>Логин или email.</summary>
    [Required, MaxLength(254)]
    public string Login { get; init; } = "";

    [Required, MaxUtf8Bytes(72)]
    public string Password { get; init; } = "";
}

public sealed class UpdateProfileRequest
{
    [Required, MaxLength(64)]
    public string DisplayName { get; init; } = "";

    [MaxLength(Messenger.Api.Contracts.AvatarUrl.MaxLength)]
    public string? AvatarUrl { get; init; }
    /// <summary>null — не менять; пустая строка — очистить.</summary>
    [MaxLength(300)]
    public string? Bio { get; init; }
}

public sealed class ChangePasswordRequest
{
    [Required, MaxUtf8Bytes(72)]
    public string CurrentPassword { get; init; } = "";
    [Required, MinLength(8), MaxUtf8Bytes(72)]
    public string NewPassword { get; init; } = "";
}

public sealed class ForwardRequest
{
    [Required, StringLength(26, MinimumLength = 26)]
    public string ToDialogId { get; init; } = "";
    [Required, MinLength(1), MaxLength(50)]
    public List<string> MessageIds { get; init; } = [];
    /// <summary>Ключ идемпотентности пачки: повтор с тем же значением не создаёт дублей.</summary>
    [Required, StringLength(40, MinimumLength = 1)]
    public string ClientBatchId { get; init; } = "";
}

public sealed class CreateDialogRequest
{
    [Required, StringLength(26, MinimumLength = 26)]
    public string UserId { get; init; } = "";
}

public sealed class EditMessageRequest
{
    [Required, MaxLength(4000)]
    public string Text { get; init; } = "";
}


/// <summary>bcrypt обрезает пароль по 72 БАЙТАМ, а MaxLength считает символы: длинный кириллический пароль молча терял хвост.</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class MaxUtf8BytesAttribute(int max) : ValidationAttribute($"Пароль не длиннее {max} байт (для кириллицы и эмодзи — короче по символам)")
{
    public override bool IsValid(object? value) => value is not string s || System.Text.Encoding.UTF8.GetByteCount(s) <= max;
}

public sealed class CreateGroupRequest
{
    [Required, StringLength(80, MinimumLength = 1)]
    public string Title { get; init; } = "";
    [Required, MinLength(1), MaxLength(49)]
    public List<string> MemberIds { get; init; } = [];
}

public sealed class RenameGroupRequest
{
    [Required, StringLength(80, MinimumLength = 1)]
    public string Title { get; init; } = "";
}

public sealed class AddMembersRequest
{
    [Required, MinLength(1), MaxLength(49)]
    public List<string> UserIds { get; init; } = [];
}

/// <summary>Фото или голосовое сообщение (multipart/form-data).</summary>
public sealed class SendMediaForm
{
    [Required] public IFormFile File { get; init; } = null!;
    [Required, StringLength(64, MinimumLength = 1)] public string ClientMessageId { get; init; } = "";
    /// <summary>"image" или "voice".</summary>
    [Required] public string Kind { get; init; } = "";
    [MaxLength(1000)] public string? Text { get; init; }
    /// <summary>Длительность голосового в миллисекундах (от клиента; ограничивается 0–10 минут).</summary>
    public int? DurationMs { get; init; }
    public string? ReplyToId { get; init; }
}
