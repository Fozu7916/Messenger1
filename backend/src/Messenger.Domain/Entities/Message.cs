namespace Messenger.Domain.Entities;

public sealed class Message
{
    public Guid Id { get; private set; }
    public Guid ConversationId { get; private set; }
    public Guid SenderId { get; private set; }

    public string Content { get; private set; } = null!;
    public DateTime CreatedAt { get; private set; }

    public Conversation Conversation { get; private set; } = null!;
    public User Sender { get; private set; } = null!;

    private Message()
    {
    }

    public Message(
        Guid conversationId,
        Guid senderId,
        string content)
    {
        Id = Guid.NewGuid();
        ConversationId = conversationId;
        SenderId = senderId;
        Content = content;
        CreatedAt = DateTime.UtcNow;
    }
}