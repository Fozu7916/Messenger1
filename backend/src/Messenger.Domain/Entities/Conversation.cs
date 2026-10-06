namespace Messenger.Domain.Entities;

public sealed class Conversation
{
    public Guid Id { get; private set; }
    public DateTime CreatedAt { get; private set; }

    public ICollection<ConversationMember> Members { get; private set; } = [];
    public ICollection<Message> Messages { get; private set; } = [];



    public Conversation()
    {
        Id = Guid.NewGuid();
        CreatedAt = DateTime.UtcNow;
    }
}