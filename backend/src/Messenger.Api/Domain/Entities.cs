namespace Messenger.Api.Domain;

public class User
{
    public string Id { get; set; } = Ulid.NewUlid().ToString();
    public string Login { get; set; } = "";          // хранится в нижнем регистре
    public string Email { get; set; } = "";          // хранится в нижнем регистре
    /// <summary>Когда владелец подтвердил почту по ссылке из письма; null — не подтверждена.</summary>
    public DateTime? EmailConfirmedAt { get; set; }
    public string PasswordHash { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string? AvatarUrl { get; set; }
    /// <summary>О себе (до 300 символов), показывается в профиле.</summary>
    public string? Bio { get; set; }
    /// <summary>Настройки оформления (тема, акцент, обои…) — JSON, которым владеет клиент; синхронизируется между устройствами.</summary>
    public string? Appearance { get; set; }
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
    /// <summary>"direct" — личный диалог (двое), "group" — беседа.</summary>
    public string Kind { get; set; } = DialogKind.Direct;
    public string? Title { get; set; }
    /// <summary>Аватар беседы: путь вида /api/files/group-avatars/{dialogId}/{ulid}.webp.</summary>
    public string? AvatarUrl { get; set; }
    public string? CreatedById { get; set; }
    public List<DialogMember> Members { get; } = [];
    public List<Message> Messages { get; } = [];
}

public class DialogMember
{
    public string DialogId { get; set; } = "";
    public string UserId { get; set; } = "";
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
    /// <summary>"owner" (создатель; при его уходе роль переходит к самому раннему участнику) или "member".</summary>
    public string Role { get; set; } = MemberRole.Member;
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
    /// <summary>Сообщение, на которое это — ответ (в том же диалоге). Если оригинал удалён физически — null.</summary>
    public string? ReplyToId { get; set; }
    /// <summary>Автор оригинала, если сообщение переслано (сохраняется при повторной пересылке).</summary>
    public string? ForwardedFromId { get; set; }
    /// <summary>Имя автора оригинала на момент пересылки.</summary>
    public string? ForwardedFromName { get; set; }
    /// <summary>"text", "image", "voice" или "system" (служебное: «Анна добавила Марка»).</summary>
    public string Kind { get; set; } = MessageKind.Text;
    public int? MediaWidth { get; set; }
    public int? MediaHeight { get; set; }
    public int? MediaDurationMs { get; set; }
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

/// <summary>Одноразовый токен из письма: подтверждение почты или сброс пароля. В БД только SHA-256 от значения.</summary>
public class EmailToken
{
    public string Id { get; set; } = Ulid.NewUlid().ToString();
    public string UserId { get; set; } = "";
    /// <summary>"confirm" или "reset".</summary>
    public string Purpose { get; set; } = "";
    public string TokenHash { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAt { get; set; }
    public DateTime? UsedAt { get; set; }
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

/// <summary>Закреплённое сообщение диалога (общее для обоих участников).</summary>
public class PinnedMessage
{
    public string DialogId { get; set; } = "";
    public string MessageId { get; set; } = "";
    public string PinnedById { get; set; } = "";
    public DateTime PinnedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>Реакция пользователя на сообщение (одна на пользователя: новая заменяет прежнюю).</summary>
public class MessageReaction
{
    public string MessageId { get; set; } = "";
    public string UserId { get; set; } = "";
    public string DialogId { get; set; } = "";
    public string Emoji { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
