namespace Messenger.Domain.Entities;

public sealed class ConversationMember
{
    public Guid ConversationId { get; private set; }
    public Guid UserId { get; private set; }

    public Conversation Conversation { get; private set; } = null!;
    public User User { get; private set; } = null!;

    private ConversationMember()
    {
    }

    public ConversationMember(Guid conversationId, Guid userId)
    {
        ConversationId = conversationId;
        UserId = userId;
    }
}