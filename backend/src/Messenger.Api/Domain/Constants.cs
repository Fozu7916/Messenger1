namespace Messenger.Api.Domain;

public static class DialogKind
{
    public const string Direct = "direct";
    public const string Group = "group";
}

public static class MemberRole
{
    public const string Owner = "owner";
    public const string Member = "member";
}

public static class MessageKind
{
    public const string Text = "text";
    public const string Image = "image";
    public const string Voice = "voice";
    public const string System = "system";
}

public static class HubEvents
{
    public const string MessageReceived = "MessageReceived";
    public const string MessageAcked = "MessageAcked";
    public const string MessageDeleted = "MessageDeleted";
    public const string MessageEdited = "MessageEdited";
    public const string MessagePinned = "MessagePinned";
    public const string MessageUnpinned = "MessageUnpinned";
    public const string MessagesRead = "MessagesRead";
    public const string ReactionChanged = "ReactionChanged";
    public const string DialogsChanged = "DialogsChanged";
    public const string UserTyping = "UserTyping";
    public const string PresenceChanged = "PresenceChanged";
}