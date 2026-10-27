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
