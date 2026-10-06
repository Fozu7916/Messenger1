namespace Messenger.Domain.Entities;

public sealed class User
{
    public Guid Id { get; private set; }
    public string Username { get; private set; } = null!;
    public DateTime CreatedAt { get; private set; }

    private User()
    {
    }

    public User(string username)
    {
        Id = Guid.NewGuid();
        Username = username;
        CreatedAt = DateTime.UtcNow;
    }
}