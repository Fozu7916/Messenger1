namespace Messenger.Api.Domain;

public class User
{
    public string Id { get; set; } = Ulid.NewUlid().ToString();
    public string Login { get; set; } = "";          // хранится в нижнем регистре
    public string Email { get; set; } = "";          // хранится в нижнем регистре
    public string PasswordHash { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string? AvatarUrl { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    /// <summary>Когда пользователь последний раз отключился (null — ещё не был в сети после обновления).</summary>
    public DateTime? LastSeenAt { get; set; }
}

public class Dialog
{
    public string Id { get; set; } = Ulid.NewUlid().ToString();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    /// <summary>"меньшийId:большийId" — уникальный ключ пары, защищает от дублей при параллельном создании.</summary>
    public string? PairKey { get; set; }
    public List<DialogMember> Members { get; } = [];
    public List<Message> Messages { get; } = [];
}

public class DialogMember
{
    public string DialogId { get; set; } = "";
    public string UserId { get; set; } = "";
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
    /// <summary>ULID последнего сообщения собеседника, прочитанного этим участником (null — ничего не прочитано).</summary>
    public string? LastReadId { get; set; }
    public Dialog Dialog { get; set; } = null!;
    public User User { get; set; } = null!;
}

public class Message
{
    public string Id { get; set; } = "";
    public string ClientMessageId { get; set; } = "";
    public string DialogId { get; set; } = "";
    public string SenderId { get; set; } = "";
    public string Text { get; set; } = "";
    public string? MediaUrl { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? DeletedAt { get; set; }
    /// <summary>Время последнего редактирования текста (null — не редактировалось).</summary>
    public DateTime? EditedAt { get; set; }
    public Dialog Dialog { get; set; } = null!;
    public User Sender { get; set; } = null!;
}

/// <summary>«Удалить у меня»: сообщение скрыто только для этого пользователя, у собеседника остаётся.</summary>
public class MessageHide
{
    public string MessageId { get; set; } = "";
    public string UserId { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class RefreshToken
{
    public string Id { get; set; } = Ulid.NewUlid().ToString();
    public string UserId { get; set; } = "";
    /// <summary>SHA-256 (hex) от выданного значения; сам токен в БД не хранится.</summary>
    public string TokenHash { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
    public DateTime? RevokedAt { get; set; }
    public string? ReplacedById { get; set; }
}
